// Orchestrates a one-shot Zalo PC history import: a read-only readiness gate
// (1.x), then per-DM backward paging with idempotent ingestion (3.3, 5.x),
// failure isolation (7.x), and a teardown that always closes the session and
// relaunches Zalo PC normally once a launch was attempted (2.6).
// Never touches zalo-sync's sync_state position (5.6).
import type { AppControl } from './app-control'
import type { CdpSession, CdpTarget } from './cdp'
import { isDmConversation } from './mapping'
import { DEFAULT_PAGE_SIZE, forEachPage, ingestPage } from './paging'
import type { StoreReader } from './store-reader'
import type { UidStore } from './uid-store'
import type { ImportError, ImportSummary, ReadinessReport, Reporter, Result, ZaloPcConversation } from './types'

export interface DebugInstance { port: number; restarted: boolean; target: CdpTarget }

export interface ImportDeps {
  app: AppControl
  /** Attaches to the page target; also reports the Chromium version from CDP. */
  openReader: (instance: DebugInstance, zaloVersion: string) =>
    Promise<Result<{ reader: StoreReader; session: CdpSession; chromium: string }>>
  reporter: Reporter
  uidStore: UidStore
  pageSize?: number
}

/** Filled in by the readiness phase so the caller's teardown knows what to undo. */
export interface Teardown { launched?: boolean; session?: CdpSession }

export interface Readiness {
  report: ReadinessReport
  reader: StoreReader
  dms: ZaloPcConversation[]
  skipped: number
  firstRun: boolean
}

/** Read-only: writes nothing to the archive or the binding file. */
export async function runReadiness(
  deps: ImportDeps, account: string, configuredUid: string | null, teardown: Teardown,
): Promise<Result<Readiness>> {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const located = deps.app.locate()
  if (!located.ok) return located
  const { version } = located.value

  teardown.launched = true
  const instance = await deps.app.ensureDebugInstance()
  if (!instance.ok) return instance
  if (instance.value.restarted) deps.reporter.info('Restarted Zalo PC with local debugging enabled for the import.')

  const opened = await deps.openReader(instance.value, version)
  if (!opened.ok) return opened
  const { reader, session, chromium } = opened.value
  teardown.session = session

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
  const dms = convs.value.filter(isDmConversation)

  let oldestMs: number | null = null
  const first = dms[0]
  if (first) {
    const paged = await forEachPage(reader, first.uid, pageSize, (rows) => {
      for (const r of rows) {
        const t = Number(r.sendDttm)
        if (oldestMs === null || t < oldestMs) oldestMs = t
      }
    })
    if (!paged.ok) return paged
  }

  return {
    ok: true,
    value: {
      report: {
        zaloVersion: version, chromium, ownUid, ownName, dmCount: dms.length,
        sample: { name: first ? first.name || first.uid : '', oldestTs: oldestMs === null ? null : Math.floor(oldestMs / 1000) },
      },
      reader, dms, skipped: convs.value.length - dms.length, firstRun: binding.value.firstRun,
    },
  }
}

export function formatReadiness(r: ReadinessReport): string[] {
  const oldest = r.sample.oldestTs === null ? 'no messages' : new Date(r.sample.oldestTs * 1000).toISOString().slice(0, 10)
  return [
    `Zalo PC ${r.zaloVersion} (${r.chromium}), logged in as ${r.ownName} (${r.ownUid}).`,
    `Found ${r.dmCount} DM conversation${r.dmCount === 1 ? '' : 's'}.`,
    ...(r.dmCount > 0 ? [`Oldest readable message in ${r.sample.name}: ${oldest}.`] : []),
  ]
}

function describe(e: ImportError): string {
  return 'message' in e ? `${e.kind}: ${e.message}` : 'detail' in e ? `${e.kind}: ${e.detail}` : e.kind
}

export async function runImport(deps: ImportDeps, account: string, configuredUid: string | null): Promise<Result<ImportSummary>> {
  const { reporter } = deps
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const teardown: Teardown = {}
  try {
    const ready = await runReadiness(deps, account, configuredUid, teardown)
    if (!ready.ok) return ready
    const { report, reader, dms, skipped, firstRun } = ready.value
    for (const line of formatReadiness(report)) reporter.info(line)

    if (firstRun) {
      const bound = deps.uidStore.bind(account, report.ownUid)
      if (!bound.ok) return bound
      reporter.info(`Linked account ${account} to Zalo user ${report.ownName} (${report.ownUid}).`)
    }

    const summary: ImportSummary = { conversations: 0, added: 0, alreadyPresent: 0, skipped, failed: [] }
    for (const conv of dms) {
      const label = conv.name || conv.uid
      let read = 0
      let reason: string
      try {
        const outcome = await forEachPage(reader, conv.uid, pageSize, (rows) => {
          const c = ingestPage(conv, account, report.ownUid, rows, reporter)
          summary.added += c.added
          summary.alreadyPresent += c.alreadyPresent
          read += rows.length
          reporter.progress(label, read)
        })
        if (outcome.ok) { summary.conversations++; continue }
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
    try { teardown.session?.close() } catch (err) { reporter.warn(`Could not close the Zalo PC session: ${(err as Error).message}`) }
    if (teardown.launched) {
      const relaunched = await deps.app.relaunchNormal()
      if (!relaunched.ok) reporter.warn(`Could not reopen Zalo PC normally: ${describe(relaunched.error)}`)
    }
  }
}
