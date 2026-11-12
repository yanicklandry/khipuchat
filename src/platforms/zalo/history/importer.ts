// Orchestrates a one-shot Zalo PC history import: a read-only readiness gate
// (1.x), then per-DM backward paging with idempotent ingestion (3.3, 5.x),
// failure isolation (7.x), and a teardown that always closes the session and
// relaunches Zalo PC normally once a launch was attempted (2.6).
// Never touches zalo-sync's sync_state position (5.6).
import type { AppControl } from './app-control'
import type { CdpSession, CdpTarget } from './cdp'
import { isDmConversation } from './mapping'
import { DEFAULT_PAGE_SIZE, forEachPage, ingestPage, newConversationState } from './paging'
import type { StoreReader } from './store-reader'
import type { UidStore } from './uid-store'
import type { ImportError, ImportSummary, ReadinessReport, Reporter, Result, ZaloPcConversation, ZaloPcRow } from './types'

export interface DebugInstance { port: number; restarted: boolean; target: CdpTarget }

export interface ImportDeps {
  app: AppControl
  /** Attaches to the page target; also reports the Chromium version from CDP. */
  openReader: (instance: DebugInstance, zaloVersion: string) =>
    Promise<Result<{ reader: StoreReader; session: CdpSession; chromium: string }>>
  reporter: Reporter
  uidStore: UidStore
  pageSize?: number
  /** Aborted on Ctrl-C/SIGTERM: the session is closed and teardown runs (review finding 1). */
  signal?: AbortSignal
}

/** Filled in by the readiness phase so the caller's teardown knows what to undo. */
export interface Teardown { launched?: boolean; session?: CdpSession; closed?: boolean }

export interface Readiness {
  report: ReadinessReport
  reader: StoreReader
  dms: ZaloPcConversation[]
  skipped: number
  firstRun: boolean
  /** The sample DM's pages, reused by the import so it is not read twice; null if sampling failed. */
  samplePages: ZaloPcRow[][] | null
}

const interrupted = (conversationsDone: number): { ok: false; error: ImportError } =>
  ({ ok: false, error: { kind: 'interrupted', step: 'read', conversationsDone } })

/** Read-only: writes nothing to the archive or the binding file. */
export async function runReadiness(
  deps: ImportDeps, account: string, configuredUid: string | null, teardown: Teardown,
): Promise<Result<Readiness>> {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const stopped = (): boolean => deps.signal?.aborted === true
  if (stopped()) return interrupted(0)
  const located = deps.app.locate()
  if (!located.ok) return located
  const { version } = located.value

  teardown.launched = true
  const instance = await deps.app.ensureDebugInstance(stopped)
  if (!instance.ok) {
    if (instance.error.kind === 'launch_failed' && instance.error.untouched) teardown.launched = false
    return instance
  }
  if (stopped()) return interrupted(0)
  if (instance.value.restarted) deps.reporter.info('Restarted Zalo PC with local debugging enabled for the import.')

  const opened = await deps.openReader(instance.value, version)
  if (!opened.ok) return opened
  const { reader, session, chromium } = opened.value
  teardown.session = session
  if (stopped()) return interrupted(0)

  const probed = await reader.probeStore()
  if (!probed.ok) return probed
  const me = await reader.getMe()
  if (!me.ok) return me
  if (me.value === null) return { ok: false, error: { kind: 'not_logged_in', step: 'login' } }
  const { uid: ownUid, name: ownName } = me.value

  const binding = deps.uidStore.checkBinding(account, ownUid, configuredUid)
  if (!binding.ok) return binding

  const convs = await reader.listConversations()
  if (!convs.ok) return convs
  if (stopped()) return interrupted(0)
  const dms = convs.value.filter(isDmConversation)

  // The sample is informational: a failure here (other than a lost connection or
  // an abort) is left for the import loop to report as that one DM's failure.
  let oldestMs: number | null = null
  let samplePages: ZaloPcRow[][] | null = null
  const first = dms[0]
  if (first) {
    const pages: ZaloPcRow[][] = []
    const paged = await forEachPage(reader, first.uid, pageSize, (rows) => {
      pages.push(rows)
      for (const r of rows) {
        const t = Number(r.sendDttm)
        if (oldestMs === null || t < oldestMs) oldestMs = t
      }
    }, stopped)
    // An unrecognised shape still stops everything before any write (user decision, 1.3, 6.4).
    if (!paged.ok && paged.error.kind !== 'attach_failed') return stopped() ? interrupted(0) : paged
    if (paged.ok) samplePages = pages
    else oldestMs = null
  }

  return {
    ok: true,
    value: {
      report: {
        zaloVersion: version, chromium, ownUid, ownName, dmCount: dms.length,
        sample: {
          name: first ? first.name || first.uid : '',
          oldestTs: oldestMs === null ? null : Math.floor(oldestMs / 1000),
          ...(first && !samplePages ? { unreadable: true } : {}),
        },
      },
      reader, dms, skipped: convs.value.length - dms.length, firstRun: binding.value.firstRun, samplePages,
    },
  }
}

export function formatReadiness(r: ReadinessReport): string[] {
  const oldest = r.sample.unreadable ? 'unknown (it could not be read; see below)'
    : r.sample.oldestTs === null ? 'no messages' : new Date(r.sample.oldestTs * 1000).toISOString().slice(0, 10)
  return [
    `Zalo PC ${r.zaloVersion} (${r.chromium}), logged in as ${r.ownName} (${r.ownUid}).`,
    `Found ${r.dmCount} DM conversation${r.dmCount === 1 ? '' : 's'}.`,
    ...(r.dmCount > 0 ? [`Oldest readable message in ${r.sample.name}: ${oldest}.`] : []),
  ]
}

const describe = (e: ImportError): string =>
  'message' in e ? `${e.kind}: ${e.message}` : 'detail' in e ? `${e.kind}: ${e.detail}` : e.kind

export async function runImport(deps: ImportDeps, account: string, configuredUid: string | null): Promise<Result<ImportSummary>> {
  const { reporter } = deps
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const teardown: Teardown = {}
  const closeSession = (): void => {
    if (teardown.closed || !teardown.session) return
    teardown.closed = true
    try { teardown.session.close() } catch (err) { reporter.warn(`Could not close the Zalo PC session: ${(err as Error).message}`) }
  }
  const onAbort = (): void => closeSession() // ends any in-flight renderer call at once (cdp.ts)
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  const stopped = (): boolean => deps.signal?.aborted === true
  try {
    const ready = await runReadiness(deps, account, configuredUid, teardown)
    if (!ready.ok) return stopped() ? interrupted(0) : ready
    const { report, reader, dms, skipped, firstRun, samplePages } = ready.value
    for (const line of formatReadiness(report)) reporter.info(line)

    if (firstRun) {
      const bound = deps.uidStore.bind(account, report.ownUid)
      if (!bound.ok) return bound
      reporter.info(`Linked account ${account} to Zalo user ${report.ownName} (${report.ownUid}).`)
    }

    const summary: ImportSummary = { conversations: 0, added: 0, alreadyPresent: 0, skipped, failed: [] }
    for (const [i, conv] of dms.entries()) {
      if (stopped()) return interrupted(summary.conversations)
      const label = conv.name || conv.uid
      const state = newConversationState()
      let read = 0
      let reason: string
      const onPage = (rows: ZaloPcRow[]): void => {
        const c = ingestPage(conv, account, report.ownUid, rows, reporter, state)
        summary.added += c.added
        summary.alreadyPresent += c.alreadyPresent
        read += rows.length
        reporter.progress(label, read)
      }
      try {
        const cached = i === 0 ? samplePages : null
        const outcome: Result<true> = cached
          ? (cached.forEach(onPage), { ok: true, value: true })
          : await forEachPage(reader, conv.uid, pageSize, onPage, stopped)
        if (outcome.ok) { summary.conversations++; continue }
        if (stopped()) return interrupted(summary.conversations)
        if (outcome.error.kind === 'connection_lost') {
          return { ok: false, error: { kind: 'connection_lost', step: 'read', conversationsDone: summary.conversations } }
        }
        reason = describe(outcome.error)
      } catch (err) {
        reason = `archive write failed: ${(err as Error).message}`
      }
      summary.failed.push({ name: label, reason })
      reporter.warn(`Failed to import ${label}: ${reason}`)
    }
    return { ok: true, value: summary }
  } finally {
    deps.signal?.removeEventListener('abort', onAbort)
    closeSession()
    if (teardown.launched) {
      const relaunched = await deps.app.relaunchNormal()
      if (!relaunched.ok) reporter.warn(`Could not reopen Zalo PC normally: ${describe(relaunched.error)}`)
    }
  }
}
