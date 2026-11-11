import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDb, getChats, getDb, rebuildFtsIndex } from '../src/db'
import { loadRegistry } from '../src/account-registry'
import { handleListChats, handleListMessages, handleSearchMessages } from '../src/query-handlers'

// Mock the zca-js wrapper so no real login/network ever happens. We keep the real
// enum/types/mapping-adjacent exports via importActual and only stub createZaloClient.
vi.mock('../src/platforms/zalo/client', async (importActual) => {
  const actual = await importActual<typeof import('../src/platforms/zalo/client')>()
  return { ...actual, createZaloClient: vi.fn() }
})

import {
  mapChat,
  mapMessage,
  runBackfillImpl,
  runIncrementalImpl,
  createZaloAdapter,
} from '../src/platforms/zalo/sync'
import {
  createZaloClient,
  ZaloThreadType,
  type ZaloClient,
  type ZaloThread,
  type ZaloMessage,
} from '../src/platforms/zalo/client'

// ── Fixtures ────────────────────────────────────────────────────────────────────

function makeThread(o: Partial<ZaloThread> = {}): ZaloThread {
  return { threadId: 'u-alice', name: 'Alice', ...o }
}

function makeMsg(o: Partial<ZaloMessage> = {}): ZaloMessage {
  return {
    msgId: 'm-1',
    threadId: 'u-alice',
    threadType: ZaloThreadType.User,
    isSelf: false,
    senderId: 'u-alice',
    senderName: 'Alice',
    content: 'Hello',
    ts: 1_700_000_000_000, // epoch ms
    ...o,
  }
}

interface MockClient extends ZaloClient {
  started: boolean
  stopped: boolean
  emit(m: ZaloMessage): void
}

function makeMockClient(opts: { friends?: ZaloThread[]; events?: ZaloMessage[] } = {}): MockClient {
  let handler: ((m: ZaloMessage) => void) | null = null
  const client: MockClient = {
    started: false,
    stopped: false,
    getFriends: async () => opts.friends ?? [],
    onMessage(h) { handler = h },
    start() {
      client.started = true
      for (const e of opts.events ?? []) handler?.(e)
    },
    stop: async () => { client.stopped = true },
    emit(m) { handler?.(m) },
  }
  return client
}

// ── 4.1 Pure mapping + DM guard ─────────────────────────────────────────────────

describe('mapChat', () => {
  it('maps a DM thread to a private zalo chat', () => {
    const c = mapChat(makeThread({ threadId: 'u-bob', name: 'Bob' }), 'default')
    expect(c).toMatchObject({ external_id: 'u-bob', name: 'Bob', type: 'private', username: null, platform: 'zalo', account: 'default' })
  })
})

describe('mapMessage', () => {
  it('maps external_id, platform and null media fields', () => {
    const m = mapMessage(makeMsg({ msgId: 'm-42' }), 7)
    expect(m.external_id).toBe('m-42')
    expect(m.chat_id).toBe(7)
    expect(m.platform).toBe('zalo')
    expect(m.reply_to_external_id).toBeNull()
    expect(m.media_file_path).toBeNull()
    expect(m.media_url).toBeNull()
    expect(m.media_width).toBeNull()
    expect(m.media_height).toBeNull()
    expect(m.ocr_text).toBeNull()
  })

  it('converts ts from ms to unix seconds', () => {
    expect(mapMessage(makeMsg({ ts: 1_700_000_000_000 }), 1).timestamp).toBe(1_700_000_000)
  })

  it('classifies non-empty string content as text', () => {
    const m = mapMessage(makeMsg({ content: 'hi there' }), 1)
    expect(m.type).toBe('text')
    expect(m.text).toBe('hi there')
  })

  it('classifies non-string content as other with null text', () => {
    const m = mapMessage(makeMsg({ content: { href: 'http://x', title: 'img' } }), 1)
    expect(m.type).toBe('other')
    expect(m.text).toBeNull()
  })

  it('classifies empty string content as other', () => {
    expect(mapMessage(makeMsg({ content: '' }), 1).type).toBe('other')
  })

  it('records received messages with sender id/name and is_sender=0', () => {
    const m = mapMessage(makeMsg({ isSelf: false, senderId: 'u-x', senderName: 'X' }), 1)
    expect(m.is_sender).toBe(0)
    expect(m.sender_id).toBe('u-x')
    expect(m.sender_name).toBe('X')
  })

  it('nulls sender id/name and sets is_sender=1 for self-authored messages', () => {
    const m = mapMessage(makeMsg({ isSelf: true, senderId: 'me', senderName: 'Me' }), 1)
    expect(m.is_sender).toBe(1)
    expect(m.sender_id).toBeNull()
    expect(m.sender_name).toBeNull()
  })
})

// ── 4.2 Capture loops + adapter (mocked client) ─────────────────────────────────

describe('runBackfillImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('seeds DM chats from friends and inserts DM messages', async () => {
    const client = makeMockClient({
      friends: [makeThread({ threadId: 'u-alice', name: 'Alice' })],
      events: [makeMsg({ msgId: 'm-1' }), makeMsg({ msgId: 'm-2' })],
    })
    await runBackfillImpl(client, 'default', 0)

    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.platform).toBe('zalo')
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(count.n).toBe(2)
    expect(client.started).toBe(true)
    expect(client.stopped).toBe(true)
  })

  it('is idempotent: a second run inserts zero new rows', async () => {
    const mk = () => makeMockClient({ friends: [makeThread()], events: [makeMsg({ msgId: 'm-dup' })] })
    await runBackfillImpl(mk(), 'default', 0)
    await runBackfillImpl(mk(), 'default', 0)
    expect(getChats()).toHaveLength(1)
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('excludes group/OA events (DM-only guard) and does not abort', async () => {
    const client = makeMockClient({
      events: [
        makeMsg({ msgId: 'grp', threadType: ZaloThreadType.Group, threadId: 'g-1' }),
        makeMsg({ msgId: 'dm', threadType: ZaloThreadType.User, threadId: 'u-alice' }),
      ],
    })
    await runBackfillImpl(client, 'default', 0)
    const ids = (getDb().prepare('SELECT external_id FROM messages').all() as { external_id: string }[]).map(r => r.external_id)
    expect(ids).toContain('dm')
    expect(ids).not.toContain('grp')
  })

  it('stores a non-text event as type=other without aborting the session', async () => {
    const client = makeMockClient({
      events: [
        makeMsg({ msgId: 'img', content: { href: 'http://img' } }),
        makeMsg({ msgId: 'txt', content: 'after image' }),
      ],
    })
    await runBackfillImpl(client, 'default', 0)
    const rows = getDb().prepare('SELECT external_id, type FROM messages ORDER BY external_id').all() as { external_id: string; type: string }[]
    expect(rows.find(r => r.external_id === 'img')!.type).toBe('other')
    expect(rows.find(r => r.external_id === 'txt')!.type).toBe('text')
  })

  it('logs and continues when a single event throws during handling', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const poison = makeMsg({ msgId: 'poison', threadId: 'u-alice' })
    Object.defineProperty(poison, 'ts', { get() { throw new Error('boom') } })
    const client = makeMockClient({ events: [poison, makeMsg({ msgId: 'good', content: 'ok' })] })

    await runBackfillImpl(client, 'default', 0)

    const ids = (getDb().prepare('SELECT external_id FROM messages').all() as { external_id: string }[]).map(r => r.external_id)
    expect(ids).toContain('good')
    expect(ids).not.toContain('poison')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('prints the bounded-fidelity notice', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runBackfillImpl(makeMockClient(), 'default', 0)
    const out = logSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(out).toContain('[zalo] Capture complete (backfill)')
    expect(out).toMatch(/best-effort recent-window/i)
    logSpy.mockRestore()
  })
})

describe('runIncrementalImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('inserts only events strictly after the since timestamp', async () => {
    const since = new Date(1_700_000_000 * 1000)
    const client = makeMockClient({
      events: [
        makeMsg({ msgId: 'before', ts: 1_699_999_999_000 }),
        makeMsg({ msgId: 'equal', ts: 1_700_000_000_000 }),
        makeMsg({ msgId: 'after', ts: 1_700_000_001_000 }),
      ],
    })
    await runIncrementalImpl(client, since, 'default', 0)
    const ids = (getDb().prepare('SELECT external_id FROM messages').all() as { external_id: string }[]).map(r => r.external_id)
    expect(ids).toEqual(['after'])
  })
})

describe('createZaloAdapter', () => {
  beforeEach(() => { initDb(':memory:') })
  afterEach(() => { vi.restoreAllMocks() })

  it('has the expected shape with a no-op startListener', () => {
    const adapter = createZaloAdapter('default', { name: 'default', fields: {} })
    expect(adapter.platform).toBe('zalo')
    expect(adapter.account).toBe('default')
    expect(typeof adapter.syncIncremental).toBe('function')
    expect(() => adapter.startListener(getDb())).not.toThrow()
  })

  it('writes a Zalo-naming stderr message and exits non-zero on a client failure', async () => {
    vi.mocked(createZaloClient).mockRejectedValueOnce(new Error('auth rejected'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const adapter = createZaloAdapter('default', { name: 'default', fields: {} })
    await adapter.runBackfill(getDb())

    const out = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(out).toContain('[zalo] Error: auth rejected')
    expect(out).toMatch(/unofficial/i)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

// ── 4.3 Registry + query-surface parity (no surface-code changes) ────────────────

describe('zalo registry + query parity', () => {
  beforeEach(() => { initDb(':memory:') })

  it('exposes a single default account with no config file', () => {
    const reg = loadRegistry('/nonexistent-khipu.config.json')
    expect(reg.listAccounts('zalo')).toEqual(['default'])
    expect(() => reg.credentialsFor('zalo', 'default')).not.toThrow()
  })

  it('is queryable through existing chat/message/search handlers', async () => {
    const client = makeMockClient({
      friends: [makeThread({ threadId: 'u-alice', name: 'Alice' })],
      events: [makeMsg({ msgId: 'm-hello', content: 'pineapple pizza' })],
    })
    await runBackfillImpl(client, 'default', 0)
    rebuildFtsIndex()

    const zaloChats = handleListChats({ platform: 'zalo' })
    expect(zaloChats.length).toBeGreaterThan(0)
    expect(zaloChats.every(c => c.platform === 'zalo')).toBe(true)

    const { messages } = handleListMessages(zaloChats[0]!.chat_id, { limit: 50 })
    expect(messages.some(m => m.text === 'pineapple pizza')).toBe(true)

    const hits = handleSearchMessages('pineapple', { platform: 'zalo' })
    expect(hits.length).toBeGreaterThan(0)
  })
})
