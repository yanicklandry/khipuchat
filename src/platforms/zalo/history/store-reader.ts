// Read-only access to Zalo PC's renderer store (webpack module XS0u), with
// runtime shape validation so an unrecognised Zalo PC build stops the import
// instead of writing garbled data (6.4). Names confirmed on macOS in task 1.3.
// Never touches network (fBUP), decryption (z0WU), or session/key material (8.2).
import type { CdpSession } from './cdp'
import type { ImportError, PageCursor, Result, ZaloPcConversation, ZaloPcRow } from './types'

const EVAL_TIMEOUT_MS = 60_000
/** Matches the CDP client's local-timeout message (cdp.ts). */
const TIMED_OUT = /timed out/i
const READ_FNS = ['getUserId', 'getMe', 'getConversations', 'getMessageFromConversationByLimit'] as const

/** Markers embedded in each expression (also lets tests route fake answers). */
export const CALL = {
  probe: '/*khipu:probe*/',
  me: '/*khipu:me*/',
  conversations: '/*khipu:conversations*/',
  page: '/*khipu:page*/',
} as const

const STORE = 'window.webpackJsonp.push([[Math.random()],{},[["XS0u"]]]).default'
const call = (marker: string, body: string): string =>
  `${marker}(async () => { const store = ${STORE}; ${body} })()`

const PROBE = `${CALL.probe}(() => {
  const jsonp = typeof window.webpackJsonp === 'object' && window.webpackJsonp !== null;
  let store = null; try { store = jsonp ? ${STORE} : null } catch (e) { store = null }
  const missing = store ? ${JSON.stringify(READ_FNS)}.filter(f => typeof store[f] !== 'function') : [];
  return JSON.stringify({ jsonp, store: !!store, missing });
})()`

// Check the uid first: getMe() is only known to work once a user is logged in (task 1.3).
const ME = call(CALL.me, `const uid = String(store.getUserId() || '');
  if (!uid) return JSON.stringify({ uid: '', name: '' });
  const me = await store.getMe();
  return JSON.stringify({ uid, name: String((me && (me.displayName || me.zaloName)) || '') });`)

const CONVERSATIONS = call(CALL.conversations, `const cs = await store.getConversations();
  const arr = Array.isArray(cs) ? cs : Object.values(cs || {});
  return JSON.stringify(arr.map(c => ({
    uid: String(c.userId || c.id || ''),
    name: c.displayName || c.zaloName || c.username || String(c.userId || c.id),
    isGroup: c.isGroup === true ? true : c.isGroup === false ? false : null,
    isOfficialAccount: !!c.oaInfo,
  })));`)

const pageExpr = (uid: string, cursor: PageCursor | null, limit: number): string =>
  call(CALL.page, `const rows = await store.getMessageFromConversationByLimit(${JSON.stringify(uid)}, ${limit},
    { count: ${limit}, fromMsg: ${cursor ? JSON.stringify(cursor) : 'undefined'}, include: false });
  if (!Array.isArray(rows)) return JSON.stringify(null);
  return JSON.stringify(rows.map(r => ({ msgId: r.msgId, cliMsgId: r.cliMsgId, fromUid: r.fromUid, toUid: r.toUid,
    sendDttm: r.sendDttm, serverTime: r.serverTime, msgType: r.msgType, message: r.message, dName: r.dName })));`)

export interface StoreReader {
  probeStore(): Promise<Result<true>>
  getMe(): Promise<Result<{ uid: string; name: string } | null>>
  listConversations(): Promise<Result<ZaloPcConversation[]>>
  getMessagePage(uid: string, cursor: PageCursor | null, limit: number): Promise<Result<ZaloPcRow[]>>
}

export interface StoreReaderOptions {
  sleep?: (ms: number) => Promise<void>
  /** Attempts (2s apart) while the renderer finishes loading after launch. */
  readyTries?: number
}

type Raw = Record<string, unknown>
const idOf = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null
const optStr = (v: unknown): string | null | undefined =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined

/** Returns the normalized row, or the name of the first invalid field. */
function toRow(r: Raw): ZaloPcRow | string {
  const ids: Record<string, string> = {}
  for (const f of ['msgId', 'cliMsgId', 'fromUid', 'toUid', 'sendDttm']) {
    const v = idOf(r[f])
    if (v === null) return f
    ids[f] = v
  }
  if (typeof r['msgType'] !== 'number') return 'msgType'
  const m = r['message']
  if (!(m === null || m === undefined || typeof m === 'string' || (typeof m === 'object' && !Array.isArray(m)))) return 'message'
  const serverTime = optStr(r['serverTime'])
  const dName = optStr(r['dName'])
  if (serverTime === undefined) return 'serverTime'
  if (dName === undefined) return 'dName'
  return {
    msgId: ids['msgId']!, cliMsgId: ids['cliMsgId']!, fromUid: ids['fromUid']!, toUid: ids['toUid']!, sendDttm: ids['sendDttm']!,
    serverTime, msgType: r['msgType'], message: (m ?? null) as ZaloPcRow['message'], dName,
  }
}

function isConversation(c: Raw): boolean {
  return typeof c['uid'] === 'string' && c['uid'].length > 0 && typeof c['name'] === 'string' &&
    (c['isGroup'] === null || typeof c['isGroup'] === 'boolean') && typeof c['isOfficialAccount'] === 'boolean'
}

export function createStoreReader(session: CdpSession, zaloVersion: string | null, opts: StoreReaderOptions = {}): StoreReader {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const tries = opts.readyTries ?? 30
  const shape = (detail: string): { ok: false; error: ImportError } =>
    ({ ok: false, error: { kind: 'shape_unrecognised', step: 'shape', detail, zaloVersion } })

  /**
   * Renderer exceptions in our read calls mean Zalo PC internals changed. Timeouts
   * and a lost connection are not shape problems and pass through unchanged.
   */
  async function run<T>(expression: string): Promise<Result<T>> {
    const r = await session.evaluate<T>(expression, EVAL_TIMEOUT_MS)
    if (!r.ok && r.error.kind === 'attach_failed' && !TIMED_OUT.test(r.error.message)) {
      return shape(`renderer call failed: ${r.error.message}`)
    }
    return r
  }

  return {
    async probeStore() {
      let last: { jsonp: boolean; store: boolean; missing: string[] } | null = null
      for (let i = 0; i < tries; i++) {
        const r = await run<{ jsonp: boolean; store: boolean; missing: string[] }>(PROBE)
        if (!r.ok) return r
        last = r.value
        if (last.store && last.missing.length > 0) return shape(`missing store functions: ${last.missing.join(', ')}`)
        if (last.store) return { ok: true, value: true }
        if (i < tries - 1) await sleep(2000)
      }
      return shape(last?.jsonp ? 'store module XS0u did not resolve' : 'window.webpackJsonp not found')
    },
    async getMe() {
      for (let i = 0; i < tries; i++) {
        const r = await run<{ uid: unknown; name: unknown }>(ME)
        if (!r.ok) return r
        if (typeof r.value.uid !== 'string' || typeof r.value.name !== 'string') return shape('getMe returned an unexpected shape')
        if (r.value.uid.length > 0) return { ok: true, value: { uid: r.value.uid, name: r.value.name } }
        if (i < tries - 1) await sleep(2000)
      }
      return { ok: true, value: null }
    },
    async listConversations() {
      const r = await run<unknown>(CONVERSATIONS)
      if (!r.ok) return r
      if (!Array.isArray(r.value)) return shape('conversation list is not an array')
      const bad = r.value.findIndex((c) => typeof c !== 'object' || c === null || !isConversation(c as Raw))
      if (bad >= 0) return shape(`unrecognised conversation record at index ${bad}`)
      return { ok: true, value: r.value as ZaloPcConversation[] }
    },
    async getMessagePage(uid, cursor, limit) {
      const r = await run<unknown>(pageExpr(uid, cursor, limit))
      if (!r.ok) return r
      if (!Array.isArray(r.value)) return shape('message page is not an array (Zalo PC returned no result)')
      const rows: ZaloPcRow[] = []
      for (const raw of r.value) {
        const row = typeof raw === 'object' && raw !== null ? toRow(raw as Raw) : 'row'
        if (typeof row === 'string') return shape(`unrecognised message row: invalid ${row}`)
        rows.push(row)
      }
      return { ok: true, value: rows }
    },
  }
}
