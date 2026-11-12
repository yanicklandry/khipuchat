import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { initDb, getDb, upsertChat, insertMessage, setPlatformLastSyncedAt, getPlatformLastSyncedAt } from '../src/db'
import { mapChat, mapMessage } from '../src/platforms/zalo/sync'
import { ZaloThreadType } from '../src/platforms/zalo/client'
import { runReadiness, runImport, type ImportDeps } from '../src/platforms/zalo/history/importer'
import { createUidStore } from '../src/platforms/zalo/history/uid-store'
import type { AppControl } from '../src/platforms/zalo/history/app-control'
import type { StoreReader } from '../src/platforms/zalo/history/store-reader'
import type { CdpSession, CdpTarget } from '../src/platforms/zalo/history/cdp'
import type { ImportError, PageCursor, Result, ZaloPcConversation, ZaloPcRow } from '../src/platforms/zalo/history/types'

const OWN = '283886062958706980'
const TARGET: CdpTarget = { id: 'p', type: 'page', url: 'file:///x/pc-dist/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:1/p' }

/** n rows for a thread, oldest first, 1s apart; every 3rd is sent by me. */
function rowsFor(uid: string, n: number, startMs = 1_700_000_000_000): ZaloPcRow[] {
  return Array.from({ length: n }, (_, i) => ({
    msgId: `${uid}-${i}`, cliMsgId: `c-${uid}-${i}`, fromUid: i % 3 === 0 ? '0' : uid, toUid: uid,
    sendDttm: String(startMs + i * 1000), serverTime: null, msgType: 1, message: `m${i}`, dName: 'Peer',
  }))
}

interface World {
  convs: ZaloPcConversation[]
  history: Map<string, ZaloPcRow[]>
  me: { uid: string; name: string } | null
  calls: string[]
  /** Fail getMessagePage for this uid with this error (once per entry in the list). */
  pageErrors: Map<string, ImportError[]>
  /** Lose the connection after this many successful page reads in total. */
  dropAfterPages: number | null
  pagesRead: number
  installed: boolean
  launchError: ImportError | null
  attachError: ImportError | null
  probeError: ImportError | null
  restarted: boolean
}

function makeWorld(over: Partial<World> = {}): World {
  return {
    convs: [], history: new Map(), me: { uid: OWN, name: 'Yanick' }, calls: [], pageErrors: new Map(),
    dropAfterPages: null, pagesRead: 0, installed: true, launchError: null, attachError: null, probeError: null,
    restarted: false, ...over,
  }
}

function fakeReader(w: World): StoreReader {
  return {
    async probeStore() { return w.probeError ? { ok: false, error: w.probeError } : { ok: true, value: true } },
    async getMe() { return { ok: true, value: w.me } },
    async listConversations() { return { ok: true, value: w.convs } },
    async getMessagePage(uid: string, cursor: PageCursor | null, limit: number): Promise<Result<ZaloPcRow[]>> {
      const queued = w.pageErrors.get(uid)
      if (queued && queued.length > 0) return { ok: false, error: queued.shift()! }
      if (w.dropAfterPages !== null && w.pagesRead >= w.dropAfterPages) {
        return { ok: false, error: { kind: 'connection_lost', step: 'read', conversationsDone: 0 } }
      }
      w.pagesRead++
      const all = w.history.get(uid) ?? []
      const older = cursor
        ? all.filter((r) => Number(r.sendDttm) < Number(cursor.sendDttm) ||
            (r.sendDttm === cursor.sendDttm && r.msgId.localeCompare(cursor.msgId, undefined, { numeric: true }) < 0))
        : all
      return { ok: true, value: older.slice(Math.max(0, older.length - limit)) }
    },
  }
}

function makeDeps(w: World, uidFile: string): { deps: ImportDeps; lines: string[]; warns: string[] } {
  const lines: string[] = []
  const warns: string[] = []
  const app: AppControl = {
    locate: () => w.installed
      ? { ok: true, value: { appPath: '/Applications/Zalo.app', version: '26.11.10' } }
      : { ok: false, error: { kind: 'not_installed', step: 'locate', searched: ['/Applications/Zalo.app'] } },
    isRunning: () => true,
    ensureDebugInstance: async () => {
      w.calls.push('launch')
      return w.launchError ? { ok: false, error: w.launchError } : { ok: true, value: { port: 1, restarted: w.restarted, target: TARGET } }
    },
    relaunchNormal: async () => { w.calls.push('relaunch'); return { ok: true, value: true } },
  }
  const session: CdpSession = { evaluate: async () => { throw new Error('unused') }, onClose() {}, close() { w.calls.push('close') } }
  const deps: ImportDeps = {
    app,
    openReader: async () => {
      w.calls.push('attach')
      return w.attachError ? { ok: false, error: w.attachError } : { ok: true, value: { reader: fakeReader(w), session, chromium: 'Chrome/108' } }
    },
    reporter: { info: (l) => lines.push(l), progress: (n, r) => lines.push(`progress ${n} ${r}`), warn: (l) => warns.push(l) },
    uidStore: createUidStore(uidFile),
  }
  return { deps, lines, warns }
}

const dm = (uid: string, name: string): ZaloPcConversation => ({ uid, name, isGroup: false, isOfficialAccount: false })
const count = (table: 'chats' | 'messages'): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

let dir: string
let uidFile: string
beforeEach(() => {
  initDb(':memory:')
  dir = mkdtempSync(path.join(tmpdir(), 'zalo-imp-'))
  uidFile = path.join(dir, '.zalo_uids.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('runReadiness (3.1)', () => {
  it('reports version, chromium, user, DM count, and the oldest message of the most recent DM', async () => {
    const w = makeWorld({
      convs: [dm('111', 'Linh'), { uid: 'g9', name: 'Team', isGroup: true, isOfficialAccount: false }, dm('222', 'An')],
      history: new Map([['111', rowsFor('111', 1201)], ['222', rowsFor('222', 3)]]),
    })
    const { deps } = makeDeps(w, uidFile)
    const r = await runReadiness(deps, 'default', null, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.report).toEqual({
      zaloVersion: '26.11.10', chromium: 'Chrome/108', ownUid: OWN, ownName: 'Yanick', dmCount: 2,
      sample: { name: 'Linh', oldestTs: 1_700_000_000 },
    })
    expect(r.value.dms.map((c) => c.uid)).toEqual(['111', '222'])
    expect(r.value.skipped).toBe(1)
    expect(r.value.firstRun).toBe(true)
    expect(count('chats')).toBe(0)
    expect(existsSync(uidFile)).toBe(false)
  })

  it('reports no sample when there are no DMs', async () => {
    const { deps } = makeDeps(makeWorld(), uidFile)
    const r = await runReadiness(deps, 'default', null, {})
    expect(r).toMatchObject({ ok: true, value: { report: { dmCount: 0, sample: { oldestTs: null } } } })
  })

  const failures: Array<[string, Partial<World>, (uidFile: string) => void, ImportError['kind']]> = [
    ['not installed', { installed: false }, () => {}, 'not_installed'],
    ['launch failure', { launchError: { kind: 'launch_failed', step: 'launch', message: 'x' } }, () => {}, 'launch_failed'],
    ['attach failure', { attachError: { kind: 'attach_failed', step: 'attach', message: 'x' } }, () => {}, 'attach_failed'],
    ['not logged in', { me: null }, () => {}, 'not_logged_in'],
    ['unrecognised shape', { probeError: { kind: 'shape_unrecognised', step: 'shape', detail: 'XS0u', zaloVersion: '26.11.10' } }, () => {}, 'shape_unrecognised'],
    ['account mismatch', {}, (f) => writeFileSync(f, JSON.stringify({ default: 'SOMEONE-ELSE' })), 'account_mismatch'],
    ['invalid uid file', {}, (f) => writeFileSync(f, '{broken'), 'uid_store_invalid'],
  ]
  for (const [label, over, seed, kind] of failures) {
    it(`${label}: returns ${kind}, writes nothing, leaves the binding file unchanged`, async () => {
      seed(uidFile)
      const before = existsSync(uidFile) ? readFileSync(uidFile, 'utf8') : null
      const w = makeWorld({ convs: [dm('111', 'Linh')], history: new Map([['111', rowsFor('111', 5)]]), ...over })
      const r = await runReadiness(makeDeps(w, uidFile).deps, 'default', null, {})
      expect(r).toMatchObject({ ok: false, error: { kind } })
      expect(count('chats')).toBe(0)
      expect(count('messages')).toBe(0)
      expect(existsSync(uidFile) ? readFileSync(uidFile, 'utf8') : null).toBe(before)
    })
  }
})

describe('runImport (3.2)', () => {
  function bigWorld(): World {
    return makeWorld({
      convs: [dm('111', 'Linh'), dm('222', 'An'), { uid: 'g9', name: 'Team', isGroup: true, isOfficialAccount: false }, dm('333', 'Bao')],
      history: new Map([['111', rowsFor('111', 1000)], ['222', rowsFor('222', 200)], ['g9', rowsFor('g9', 50)], ['333', rowsFor('333', 1)]]),
    })
  }

  it('imports every DM message across pages of 500, skips the group, and counts exactly', async () => {
    const w = bigWorld()
    const { deps, lines } = makeDeps(w, uidFile)
    const r = await runImport(deps, 'default', null)
    expect(r).toEqual({ ok: true, value: { conversations: 3, added: 1201, alreadyPresent: 0, skipped: 1, failed: [] } })
    expect(count('messages')).toBe(1201)
    expect(count('chats')).toBe(3)
    expect(lines).toContain('progress Linh 1000')
    expect(lines.some((l) => l.includes(`Linked account default to Zalo user Yanick (${OWN})`))).toBe(true)
    const sent = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE is_sender = 1 AND sender_id IS NULL").get() as { n: number }
    expect(sent.n).toBe(334 + 67 + 1)
    expect(w.calls.slice(-2)).toEqual(['close', 'relaunch'])
  })

  it('binds the account on first run, and a later run as another Zalo user is a mismatch with nothing written', async () => {
    const w = makeWorld({ convs: [dm('111', 'Linh')], history: new Map([['111', rowsFor('111', 3)]]) })
    await runImport(makeDeps(w, uidFile).deps, 'default', null)
    expect(JSON.parse(readFileSync(uidFile, 'utf8'))).toEqual({ default: OWN })
    initDb(':memory:')
    const other = makeWorld({ ...w, me: { uid: '999', name: 'Other' }, calls: [] })
    const r = await runImport(makeDeps(other, uidFile).deps, 'default', null)
    expect(r).toMatchObject({ ok: false, error: { kind: 'account_mismatch', expectedUid: OWN, actualUid: '999' } })
    expect(count('messages')).toBe(0)
    expect(other.calls.slice(-2)).toEqual(['close', 'relaunch'])
  })

  it('a message already captured by zalo-sync counts as present, and a second run adds zero', async () => {
    const chatId = upsertChat(mapChat({ threadId: '111', name: 'Linh' }, 'default'))
    insertMessage(mapMessage({ msgId: '111-2', threadId: '111', threadType: ZaloThreadType.User, isSelf: false,
      senderId: '111', senderName: 'Peer', content: 'm2', ts: 1_700_000_002_000 }, chatId))
    const w = makeWorld({ convs: [dm('111', 'Linh')], history: new Map([['111', rowsFor('111', 10)]]) })
    expect(await runImport(makeDeps(w, uidFile).deps, 'default', null))
      .toMatchObject({ ok: true, value: { added: 9, alreadyPresent: 1 } })
    expect(await runImport(makeDeps({ ...w, calls: [] }, uidFile).deps, 'default', null))
      .toMatchObject({ ok: true, value: { added: 0, alreadyPresent: 10 } })
    expect(count('messages')).toBe(10)
  })

  it('a lost connection mid-conversation keeps committed pages, reports progress, and a re-run completes', async () => {
    const w = bigWorld()
    // readiness pages Linh fully (500, 500, then an empty page); the import reuses those pages, then An's first page drops
    w.dropAfterPages = 3
    const first = makeDeps(w, uidFile)
    const r = await runImport(first.deps, 'default', null)
    expect(r).toEqual({ ok: false, error: { kind: 'connection_lost', step: 'read', conversationsDone: 1 } })
    expect(count('messages')).toBe(1000)
    expect(w.calls.slice(-2)).toEqual(['close', 'relaunch'])
    const again = makeDeps({ ...w, dropAfterPages: null, calls: [] }, uidFile)
    expect(await runImport(again.deps, 'default', null))
      .toMatchObject({ ok: true, value: { added: 201, alreadyPresent: 1000 } })
  })

  it('a failing conversation is listed in the summary and the import continues', async () => {
    const w = bigWorld()
    w.pageErrors.set('222', [{ kind: 'shape_unrecognised', step: 'shape', detail: 'invalid sendDttm', zaloVersion: '26.11.10' }])
    const { deps, warns } = makeDeps(w, uidFile)
    const r = await runImport(deps, 'default', null)
    expect(r).toMatchObject({ ok: true, value: { conversations: 2, added: 1001, failed: [{ name: 'An' }] } })
    expect(warns.some((l) => l.includes('An'))).toBe(true)
  })

  it('an unexpected exception inside one conversation is contained like any other failure', async () => {
    const w = bigWorld()
    const { deps } = makeDeps(w, uidFile)
    const open = deps.openReader
    deps.openReader = async (inst, v) => {
      const r = await open(inst, v)
      if (!r.ok) return r
      const inner = r.value.reader
      const reader: StoreReader = { ...inner, getMessagePage: async (uid, c, l) => {
        if (uid === '333') throw new Error('boom')
        return inner.getMessagePage(uid, c, l)
      } }
      return { ok: true, value: { ...r.value, reader } }
    }
    expect(await runImport(deps, 'default', null))
      .toMatchObject({ ok: true, value: { conversations: 2, failed: [{ name: 'Bao', reason: expect.stringMatching(/boom/) }] } })
  })

  it('a disconnect on a later page of the same conversation keeps its earlier pages, and a re-run completes', async () => {
    const w = bigWorld()
    w.history.set('222', rowsFor('222', 600))
    // readiness: Linh 500, 500, empty (3 reads, reused by the import); An page 1 (4th read), then An page 2 drops
    w.dropAfterPages = 4
    const r = await runImport(makeDeps(w, uidFile).deps, 'default', null)
    expect(r).toEqual({ ok: false, error: { kind: 'connection_lost', step: 'read', conversationsDone: 1 } })
    expect(count('messages')).toBe(1500)
    expect(await runImport(makeDeps({ ...w, dropAfterPages: null, calls: [] }, uidFile).deps, 'default', null))
      .toMatchObject({ ok: true, value: { added: 101, alreadyPresent: 1500 } })
  })

  it('a store that ignores the paging cursor fails that conversation instead of silently truncating it', async () => {
    const w = bigWorld()
    w.history.set('222', rowsFor('222', 600))
    const { deps } = makeDeps(w, uidFile)
    const open = deps.openReader
    deps.openReader = async (inst, v) => {
      const r = await open(inst, v)
      if (!r.ok) return r
      const inner = r.value.reader
      const reader: StoreReader = { ...inner, getMessagePage: (uid, c, l) => inner.getMessagePage(uid, uid === '222' ? null : c, l) }
      return { ok: true, value: { ...r.value, reader } }
    }
    const out = await runImport(deps, 'default', null)
    expect(out).toMatchObject({
      ok: true,
      value: { conversations: 2, alreadyPresent: 0, failed: [{ name: 'An', reason: expect.stringMatching(/cursor/) }] },
    })
    if (out.ok) expect(out.value.added).toBe(1000 + 500 + 1)
  })

  it('a single failing message is logged and skipped while the rest of its page commits (7.2)', async () => {
    const rows = rowsFor('111', 5)
    Object.defineProperty(rows[2], 'dName', { get() { throw new Error('bad row') } })
    const w = makeWorld({ convs: [dm('111', 'Linh')], history: new Map([['111', rows]]) })
    const { deps, warns } = makeDeps(w, uidFile)
    expect(await runImport(deps, 'default', null)).toMatchObject({ ok: true, value: { added: 4, failed: [] } })
    expect(count('messages')).toBe(4)
    expect(warns.some((l) => l.includes('111-2') && l.includes('bad row'))).toBe(true)
  })

  it('pages correctly when many messages share one timestamp across a page boundary', async () => {
    const rows = [7, 8, 9, 10, 11].map((n) => ({ ...rowsFor('111', 1)[0]!, msgId: String(n), cliMsgId: `c${n}` }))
    const w = makeWorld({ convs: [dm('111', 'Linh')], history: new Map([['111', rows]]) })
    const { deps } = makeDeps(w, uidFile)
    deps.pageSize = 2
    expect(await runImport(deps, 'default', null)).toMatchObject({ ok: true, value: { added: 5, alreadyPresent: 0 } })
  })

  it('still relaunches Zalo PC when closing the session throws', async () => {
    const w = makeWorld()
    const { deps } = makeDeps(w, uidFile)
    const open = deps.openReader
    deps.openReader = async (inst, v) => {
      const r = await open(inst, v)
      if (!r.ok) return r
      return { ok: true, value: { ...r.value, session: { ...r.value.session, close() { throw new Error('socket gone') } } } }
    }
    await runImport(deps, 'default', null)
    expect(w.calls).toContain('relaunch')
  })

  it('keeps the name of a chat that already exists, and names a new chat only when Zalo PC has a name', async () => {
    upsertChat(mapChat({ threadId: '111', name: 'Khánh An' }, 'default'))
    const w = makeWorld({
      convs: [{ ...dm('111', 'Some Alias') }, dm('222', ''), dm('333', 'Bao')],
      history: new Map([['111', rowsFor('111', 2)], ['222', rowsFor('222', 2)], ['333', rowsFor('333', 2)]]),
    })
    await runImport(makeDeps(w, uidFile).deps, 'default', null)
    const names = Object.fromEntries((getDb().prepare("SELECT external_id, name FROM chats WHERE platform = 'zalo'").all() as Array<{ external_id: string; name: string }>)
      .map((r) => [r.external_id, r.name]))
    expect(names).toEqual({ '111': 'Khánh An', '222': '222', '333': 'Bao' })
  })

  it('a received message with no dName falls back to the archive chat name, never an empty sender name', async () => {
    upsertChat(mapChat({ threadId: '111', name: 'Khánh An' }, 'default'))
    const noName = (uid: string): ZaloPcRow[] => rowsFor(uid, 3).map((r, i) => ({ ...r, dName: i === 1 ? null : '' }))
    const w = makeWorld({ convs: [dm('111', ''), dm('222', '')], history: new Map([['111', noName('111')], ['222', noName('222')]]) })
    await runImport(makeDeps(w, uidFile).deps, 'default', null)
    const senders = getDb().prepare(
      "SELECT c.external_id AS chat, m.sender_name AS sender FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.is_sender = 0 GROUP BY 1, 2",
    ).all()
    expect(senders).toEqual([{ chat: '111', sender: 'Khánh An' }, { chat: '222', sender: '222' }])
  })

  it('a chat stored under its uid takes the real name once Zalo PC knows it (review finding 3)', async () => {
    upsertChat(mapChat({ threadId: '222', name: '222' }, 'default'))
    upsertChat(mapChat({ threadId: '111', name: 'Khánh An' }, 'default'))
    const w = makeWorld({ convs: [dm('111', 'Alias'), dm('222', 'An')], history: new Map([['111', rowsFor('111', 1)], ['222', rowsFor('222', 1)]]) })
    await runImport(makeDeps(w, uidFile).deps, 'default', null)
    const names = Object.fromEntries((getDb().prepare("SELECT external_id, name FROM chats WHERE platform = 'zalo'").all() as Array<{ external_id: string; name: string }>)
      .map((r) => [r.external_id, r.name]))
    expect(names).toEqual({ '111': 'Khánh An', '222': 'An' })
  })

  it('collapses a multi-device copy that lands on a different page (review finding 4)', async () => {
    // oldest first: r0, r1, r2, r3; r1 and r2 are copies (same sender + cliMsgId). Pages of 2: [r2, r3] then [r0, r1].
    const rows = rowsFor('111', 4).map((r) => ({ ...r, fromUid: '111' }))
    rows[2] = { ...rows[2]!, cliMsgId: rows[1]!.cliMsgId }
    const w = makeWorld({ convs: [dm('111', 'Linh')], history: new Map([['111', rows]]) })
    const { deps } = makeDeps(w, uidFile)
    deps.pageSize = 2
    expect(await runImport(deps, 'default', null)).toMatchObject({ ok: true, value: { added: 3, alreadyPresent: 0 } })
    expect(count('messages')).toBe(3)
  })

  it('reads the sample conversation once and reuses its pages for the import (review finding 10)', async () => {
    const w = bigWorld()
    await runImport(makeDeps(w, uidFile).deps, 'default', null)
    // Linh: 3 page reads (500, 500, empty) in total, not 6; An 1; Bao 1.
    expect(w.pagesRead).toBe(5)
  })

  it('a transient failure reading the sample does not stop the import; that DM fails alone (review finding 6)', async () => {
    const w = bigWorld()
    const slow = { kind: 'attach_failed' as const, step: 'attach' as const, message: 'renderer call timed out after 60000ms', cause: 'timeout' as const }
    w.pageErrors.set('111', [slow, slow])
    const { deps, lines, warns } = makeDeps(w, uidFile)
    const r = await runImport(deps, 'default', null)
    expect(r).toMatchObject({ ok: true, value: { conversations: 2, added: 201, failed: [{ name: 'Linh' }] } })
    expect(lines.some((l) => /Oldest readable message in Linh: unknown/.test(l))).toBe(true)
    expect(warns.some((l) => l.includes('Linh') && l.includes('timed out'))).toBe(true)
  })

  it('an unrecognised shape in the sample still stops everything before any write (user decision, 1.3, 6.4)', async () => {
    const w = bigWorld()
    w.pageErrors.set('111', [{ kind: 'shape_unrecognised', step: 'shape', detail: 'invalid msgType', zaloVersion: '26.11.10' }])
    expect(await runImport(makeDeps(w, uidFile).deps, 'default', null))
      .toMatchObject({ ok: false, error: { kind: 'shape_unrecognised', detail: 'invalid msgType' } })
    expect(count('messages')).toBe(0)
    expect(existsSync(uidFile)).toBe(false)
  })

  it('a lost connection while sampling still stops the import', async () => {
    const w = bigWorld()
    w.pageErrors.set('111', [{ kind: 'connection_lost', step: 'read', conversationsDone: 0 }])
    expect(await runImport(makeDeps(w, uidFile).deps, 'default', null))
      .toMatchObject({ ok: false, error: { kind: 'connection_lost', conversationsDone: 0 } })
  })

  it('an abort (Ctrl-C) stops between pages, closes the session, relaunches Zalo PC, and reports interrupted (review finding 1)', async () => {
    const w = bigWorld()
    const controller = new AbortController()
    const { deps, lines } = makeDeps(w, uidFile)
    deps.signal = controller.signal
    deps.reporter.progress = (name, read) => { lines.push(`progress ${name} ${read}`); if (name === 'An') controller.abort() }
    const r = await runImport(deps, 'default', null)
    expect(r).toEqual({ ok: false, error: { kind: 'interrupted', step: 'read', conversationsDone: 2 } })
    expect(count('messages')).toBe(1200)
    expect(w.calls.slice(-2)).toEqual(['close', 'relaunch'])
  })

  it('an abort during a slow renderer call closes the session so the call ends at once', async () => {
    const w = bigWorld()
    const controller = new AbortController()
    const { deps } = makeDeps(w, uidFile)
    deps.signal = controller.signal
    const open = deps.openReader
    deps.openReader = async (inst, v) => {
      const r = await open(inst, v)
      if (!r.ok) return r
      let release: (() => void) | null = null
      const session = { ...r.value.session, close() { w.calls.push('close'); release?.() } }
      const inner = r.value.reader
      const reader: StoreReader = { ...inner, getMessagePage: async (uid, c, l) => {
        if (uid !== '222') return inner.getMessagePage(uid, c, l)
        await new Promise<void>((res) => { release = res; controller.abort() })
        return { ok: false, error: { kind: 'connection_lost', step: 'read', conversationsDone: 0 } }
      } }
      return { ok: true, value: { ...r.value, session, reader } }
    }
    expect(await runImport(deps, 'default', null)).toMatchObject({ ok: false, error: { kind: 'interrupted', conversationsDone: 1 } })
    expect(w.calls).toContain('relaunch')
  })

  it('an abort while readiness is waiting on Zalo PC reports interrupted, not a lost connection', async () => {
    const controller = new AbortController()
    const w = bigWorld()
    const { deps } = makeDeps(w, uidFile)
    deps.signal = controller.signal
    const open = deps.openReader
    deps.openReader = async (inst, v) => {
      const r = await open(inst, v)
      if (!r.ok) return r
      const reader: StoreReader = { ...r.value.reader, probeStore: async () => {
        controller.abort()
        return { ok: false, error: { kind: 'connection_lost', step: 'read', conversationsDone: 0 } }
      } }
      return { ok: true, value: { ...r.value, reader } }
    }
    expect(await runImport(deps, 'default', null)).toEqual({ ok: false, error: { kind: 'interrupted', step: 'read', conversationsDone: 0 } })
    expect(w.calls.slice(-2)).toEqual(['close', 'relaunch'])
  })

  it('an abort before the launch leaves Zalo PC untouched', async () => {
    const controller = new AbortController()
    controller.abort()
    const w = bigWorld()
    const { deps } = makeDeps(w, uidFile)
    deps.signal = controller.signal
    expect(await runImport(deps, 'default', null)).toMatchObject({ ok: false, error: { kind: 'interrupted', conversationsDone: 0 } })
    expect(w.calls).toEqual([])
  })

  it('an abort right after the launch writes nothing, leaves the binding file alone, and relaunches', async () => {
    const controller = new AbortController()
    const w = bigWorld()
    const { deps } = makeDeps(w, uidFile)
    deps.signal = controller.signal
    const launch = deps.app.ensureDebugInstance
    deps.app.ensureDebugInstance = async () => { const r = await launch(); controller.abort(); return r }
    expect(await runImport(deps, 'default', null)).toMatchObject({ ok: false, error: { kind: 'interrupted', conversationsDone: 0 } })
    expect(count('messages')).toBe(0)
    expect(existsSync(uidFile)).toBe(false)
    expect(w.calls).toEqual(['launch', 'relaunch'])
  })

  it('a copy that failed to import does not hide its sibling on a later page', async () => {
    // oldest first: r0, r1, r2, r3; r1 and r2 are copies. Pages of 2: [r2, r3] then [r0, r1]; r2 throws.
    const rows = rowsFor('111', 4).map((r) => ({ ...r, fromUid: '111' }))
    rows[2] = { ...rows[2]!, cliMsgId: rows[1]!.cliMsgId }
    Object.defineProperty(rows[2], 'dName', { get() { throw new Error('bad copy') } })
    const w = makeWorld({ convs: [dm('111', 'Linh')], history: new Map([['111', rows]]) })
    const { deps, warns } = makeDeps(w, uidFile)
    deps.pageSize = 2
    expect(await runImport(deps, 'default', null)).toMatchObject({ ok: true, value: { added: 3, failed: [] } })
    expect(getDb().prepare("SELECT 1 FROM messages WHERE external_id = '111-1'").get()).toBeDefined()
    expect(warns.some((l) => l.includes('Skipped message 111-2'))).toBe(true)
  })

  it('never touches the zalo sync position', async () => {
    setPlatformLastSyncedAt('zalo', 'default', 12345)
    await runImport(makeDeps(bigWorld(), uidFile).deps, 'default', null)
    expect(getPlatformLastSyncedAt('zalo', 'default')).toBe(12345)
  })

  const postLaunch: Array<[string, Partial<World>]> = [
    ['launch failure', { launchError: { kind: 'launch_failed', step: 'launch', message: 'page target timeout' } }],
    ['not logged in', { me: null }],
    ['unrecognised shape', { probeError: { kind: 'shape_unrecognised', step: 'shape', detail: 'x', zaloVersion: null } }],
  ]
  for (const [label, over] of postLaunch) {
    it(`relaunches Zalo PC normally after a ${label}, and leaves the binding file untouched`, async () => {
      const w = makeWorld({ convs: [dm('111', 'Linh')], ...over })
      const r = await runImport(makeDeps(w, uidFile).deps, 'default', null)
      expect(r.ok).toBe(false)
      expect(w.calls).toContain('relaunch')
      if (over.launchError) expect(w.calls).not.toContain('close')
      else expect(w.calls.slice(-2)).toEqual(['close', 'relaunch'])
      expect(existsSync(uidFile)).toBe(false)
    })
  }

  it('does not relaunch when the launch failed before Zalo PC was touched (review finding 6, round 2)', async () => {
    const w = makeWorld({ launchError: { kind: 'launch_failed', step: 'launch', message: 'no free loopback port', untouched: true } })
    await runImport(makeDeps(w, uidFile).deps, 'default', null)
    expect(w.calls).toEqual(['launch'])
  })

  it('passes the abort check into the launch, so a Ctrl-C while Zalo PC restarts is honoured (round 2 finding 3)', async () => {
    const w = makeWorld()
    const controller = new AbortController()
    const { deps } = makeDeps(w, uidFile)
    deps.signal = controller.signal
    let sawStop: (() => boolean) | undefined
    deps.app.ensureDebugInstance = async (shouldStop) => {
      sawStop = shouldStop
      controller.abort()
      return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: 'interrupted' } }
    }
    expect(await runImport(deps, 'default', null)).toMatchObject({ ok: false, error: { kind: 'interrupted' } })
    expect(sawStop?.()).toBe(true)
    expect(w.calls).toContain('relaunch')
  })

  it('does not relaunch when Zalo PC was never located (nothing was launched)', async () => {
    const w = makeWorld({ installed: false })
    await runImport(makeDeps(w, uidFile).deps, 'default', null)
    expect(w.calls).not.toContain('relaunch')
  })

  it('prints a warning when the final relaunch fails', async () => {
    const w = makeWorld()
    const { deps, warns } = makeDeps(w, uidFile)
    deps.app.relaunchNormal = async () => ({ ok: false, error: { kind: 'launch_failed', step: 'launch', message: 'open it manually' } })
    await runImport(deps, 'default', null)
    expect(warns.some((l) => l.includes('open it manually'))).toBe(true)
  })

  it('says when it restarted Zalo PC', async () => {
    const { deps, lines } = makeDeps(makeWorld({ restarted: true }), uidFile)
    await runImport(deps, 'default', null)
    expect(lines.some((l) => /restarted Zalo PC/i.test(l))).toBe(true)
  })
})
