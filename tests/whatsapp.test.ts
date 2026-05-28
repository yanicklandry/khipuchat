import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { initDb, getChats, getDb } from '../src/db'
import {
  hashStr,
  mapChat,
  mapMessage,
  runBackfillImpl,
  runIncrementalImpl,
  parseArgs,
} from '../src/platforms/whatsapp/sync'
import type { WhatsAppClient, WAChat, WAMessage } from '../src/platforms/whatsapp/client'

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeChat(overrides: Partial<WAChat> = {}): WAChat {
  return {
    id: { _serialized: 'chatid@c.us' },
    name: 'Alice',
    isGroup: false,
    ...overrides,
  }
}

function makeMsg(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    id: { _serialized: 'msg-001@c.us' },
    body: 'Hello',
    from: 'chatid@c.us',
    fromMe: false,
    timestamp: 1700000000,
    type: 'chat',
    ...overrides,
  }
}

function makeMockClient(
  chats: WAChat[],
  messages: WAMessage[],
  contactName = 'Alice',
): WhatsAppClient {
  return {
    getChats: async () => chats,
    fetchMessages: async () => messages,
    getContactName: async () => contactName,
    destroy: async () => {},
  }
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('debug=false when --debug is absent', () => {
    expect(parseArgs(['node', 'sync.ts'])).toEqual({ debug: false })
  })

  it('debug=true when --debug is present', () => {
    expect(parseArgs(['node', 'sync.ts', '--debug'])).toEqual({ debug: true })
  })

  it('debug=false for unrelated flags', () => {
    expect(parseArgs(['node', 'sync.ts', '--verbose'])).toEqual({ debug: false })
  })

  it('debug=true regardless of flag position', () => {
    expect(parseArgs(['--debug', 'node', 'sync.ts'])).toEqual({ debug: true })
  })
})

// ── debug logging ─────────────────────────────────────────────────────────────

describe('createWhatsAppClient debug option', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('writes debug lines to stderr when debug=true', async () => {
    const { createWhatsAppClient } = await import('../src/platforms/whatsapp/client')

    // Mock whatsapp-web.js so Puppeteer never actually launches
    vi.doMock('whatsapp-web.js', () => ({
      default: {
        Client: class MockClient {
          on() {}
          initialize() { return new Promise(() => {}) } // hangs — we only care about the dbg line
          destroy() { return Promise.resolve() }
        },
        LocalAuth: class MockLocalAuth {},
      },
    }))

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // Suppress progress bar stdout writes so the timer doesn't leak into other tests
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    // Fire-and-forget — we only want to observe the initial dbg output
    createWhatsAppClient({ debug: true }).catch(() => {})
    await new Promise(r => setTimeout(r, 50))

    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(output).toContain('[whatsapp:debug]')
    expect(output).toContain('creating Client')
  })

  it('writes nothing to stderr when debug=false', async () => {
    const { createWhatsAppClient } = await import('../src/platforms/whatsapp/client')

    vi.doMock('whatsapp-web.js', () => ({
      default: {
        Client: class MockClient {
          on() {}
          initialize() { return new Promise(() => {}) }
          destroy() { return Promise.resolve() }
        },
        LocalAuth: class MockLocalAuth {},
      },
    }))

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    createWhatsAppClient({ debug: false }).catch(() => {})
    await new Promise(r => setTimeout(r, 50))

    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(output).not.toContain('[whatsapp:debug]')
  })
})

// ── hashStr ───────────────────────────────────────────────────────────────────

describe('hashStr', () => {
  it('is stable', () => { expect(hashStr('wa-123')).toBe(hashStr('wa-123')) })
  it('differs for different inputs', () => { expect(hashStr('a')).not.toBe(hashStr('b')) })
})

// ── mapChat ───────────────────────────────────────────────────────────────────

describe('mapChat', () => {
  it('sets platform to whatsapp', () => {
    expect(mapChat(makeChat()).platform).toBe('whatsapp')
  })

  it('sets type=private when isGroup=false', () => {
    expect(mapChat(makeChat({ isGroup: false })).type).toBe('private')
  })

  it('sets type=group when isGroup=true', () => {
    expect(mapChat(makeChat({ isGroup: true })).type).toBe('group')
  })

  it('uses chat.name', () => {
    expect(mapChat(makeChat({ name: 'Team Chat' })).name).toBe('Team Chat')
  })

  it('uses hashStr of id._serialized', () => {
    const chat = makeChat()
    expect(mapChat(chat).id).toBe(hashStr(chat.id._serialized))
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const msg = makeMsg()

  it('sets platform to whatsapp', () => {
    expect(mapMessage(msg, 1, 'Alice').platform).toBe('whatsapp')
  })

  it('sets external_id to id._serialized', () => {
    expect(mapMessage(msg, 1, 'Alice').external_id).toBe('msg-001@c.us')
  })

  it('sets is_sender=0 when fromMe=false', () => {
    expect(mapMessage(msg, 1, 'Alice').is_sender).toBe(0)
  })

  it('sets is_sender=1 when fromMe=true', () => {
    expect(mapMessage({ ...msg, fromMe: true }, 1, 'Me').is_sender).toBe(1)
  })

  it('uses timestamp directly', () => {
    expect(mapMessage(msg, 1, 'Alice').timestamp).toBe(1700000000)
  })

  it('sets type=text for chat type with body', () => {
    expect(mapMessage(msg, 1, 'Alice').type).toBe('text')
  })

  it('sets type=other for image type', () => {
    expect(mapMessage({ ...msg, type: 'image', body: '' }, 1, 'Alice').type).toBe('other')
  })

  it('sets text to null for empty body', () => {
    expect(mapMessage({ ...msg, body: '' }, 1, 'Alice').text).toBeNull()
  })

  it('sets sender_name to null when fromMe=true', () => {
    expect(mapMessage({ ...msg, fromMe: true }, 1, 'Me').sender_name).toBeNull()
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

describe('runBackfillImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('imports chats and messages', async () => {
    const client = makeMockClient(
      [makeChat({ id: { _serialized: 'alice@c.us' }, name: 'Alice' })],
      [makeMsg({ id: { _serialized: 'msg-1@c.us' } }), makeMsg({ id: { _serialized: 'msg-2@c.us' } })],
    )
    await runBackfillImpl(client)

    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.platform).toBe('whatsapp')
  })

  it('is idempotent', async () => {
    const client = makeMockClient(
      [makeChat({ id: { _serialized: 'bob@c.us' } })],
      [makeMsg({ id: { _serialized: 'msg-idem@c.us' } })],
    )
    await runBackfillImpl(client)
    await runBackfillImpl(client)
    expect(getChats()).toHaveLength(1)
  })

  it('handles empty chat list', async () => {
    const client = makeMockClient([], [])
    await expect(runBackfillImpl(client)).resolves.not.toThrow()
    expect(getChats()).toHaveLength(0)
  })

  it('skips chats with no new activity in incremental mode', async () => {
    const chatId = 'carol@c.us'
    const fetchSpy = vi.fn(async () => [makeMsg({ id: { _serialized: 'msg-x@c.us' } })])
    const client: WhatsAppClient = {
      getChats: async () => [makeChat({ id: { _serialized: chatId }, timestamp: 1700000000 })],
      fetchMessages: fetchSpy,
      getContactName: async () => 'Carol',
      destroy: async () => {},
    }

    // First sync
    await runBackfillImpl(client)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Second sync with same chat.timestamp — should skip
    fetchSpy.mockClear()
    await runBackfillImpl(client)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('processes chats with new activity in incremental mode', async () => {
    const chatId = 'dave@c.us'
    const syncTime = 1700000000
    const fetchSpy = vi.fn(async () => [makeMsg({ id: { _serialized: 'msg-new@c.us' }, timestamp: syncTime + 100 })])
    const client: WhatsAppClient = {
      // chat.timestamp > last_synced_at → should NOT be skipped
      getChats: async () => [makeChat({ id: { _serialized: chatId }, timestamp: syncTime + 100 })],
      fetchMessages: fetchSpy,
      getContactName: async () => 'Dave',
      destroy: async () => {},
    }

    // Seed a prior sync record
    getDb().prepare(
      "INSERT INTO chats (id, name, type, username, platform, last_synced_at, message_count) VALUES (?, 'Dave', 'private', NULL, 'whatsapp', ?, 0)",
    ).run(hashStr(chatId), syncTime)

    await runBackfillImpl(client)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('filters out already-synced messages by timestamp', async () => {
    const chatId = 'eve@c.us'
    const syncTime = 1700000000
    const oldMsg = makeMsg({ id: { _serialized: 'old@c.us' }, timestamp: syncTime - 60 })
    const newMsg = makeMsg({ id: { _serialized: 'new@c.us' }, timestamp: syncTime + 60 })
    const client: WhatsAppClient = {
      getChats: async () => [makeChat({ id: { _serialized: chatId }, timestamp: syncTime + 60 })],
      fetchMessages: async () => [oldMsg, newMsg],
      getContactName: async () => 'Eve',
      destroy: async () => {},
    }

    // Seed prior sync at syncTime
    getDb().prepare(
      "INSERT INTO chats (id, name, type, username, platform, last_synced_at, message_count) VALUES (?, 'Eve', 'private', NULL, 'whatsapp', ?, 0)",
    ).run(hashStr(chatId), syncTime)

    await runBackfillImpl(client)

    const msgs = getDb().prepare("SELECT external_id FROM messages WHERE chat_id = ?").all(hashStr(chatId)) as { external_id: string }[]
    const ids = msgs.map(m => m.external_id)
    expect(ids).not.toContain('old@c.us')
    expect(ids).toContain('new@c.us')
  })
})

// ── runIncrementalImpl ────────────────────────────────────────────────────────

describe('runIncrementalImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('logs the client-side filter warning', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = makeMockClient([], [])
    await runIncrementalImpl(client, new Date())
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('[whatsapp] incremental: client-side filter only')
    consoleSpy.mockRestore()
  })

  it('skips messages at or before since timestamp', async () => {
    const sinceDate = new Date(1700000000 * 1000)
    const chatId = 'frank@c.us'
    const oldMsg = makeMsg({ id: { _serialized: 'old-inc@c.us' }, timestamp: 1700000000 })     // equal — should skip
    const veryOldMsg = makeMsg({ id: { _serialized: 'very-old@c.us' }, timestamp: 1699999999 }) // before — skip
    const newMsg = makeMsg({ id: { _serialized: 'new-inc@c.us' }, timestamp: 1700000001 })      // after — keep

    const client: WhatsAppClient = {
      getChats: async () => [makeChat({ id: { _serialized: chatId } })],
      fetchMessages: async () => [oldMsg, veryOldMsg, newMsg],
      getContactName: async () => 'Frank',
      destroy: async () => {},
    }

    await runIncrementalImpl(client, sinceDate)

    const msgs = getDb().prepare("SELECT external_id FROM messages").all() as { external_id: string }[]
    const ids = msgs.map(m => m.external_id)
    expect(ids).not.toContain('old-inc@c.us')
    expect(ids).not.toContain('very-old@c.us')
    expect(ids).toContain('new-inc@c.us')
  })

  it('imports no messages when all are at or before since', async () => {
    const since = new Date(1700000000 * 1000)
    const client: WhatsAppClient = {
      getChats: async () => [makeChat({ id: { _serialized: 'grace@c.us' } })],
      fetchMessages: async () => [
        makeMsg({ id: { _serialized: 'old-1@c.us' }, timestamp: 1699999999 }),
        makeMsg({ id: { _serialized: 'old-2@c.us' }, timestamp: 1700000000 }),
      ],
      getContactName: async () => 'Grace',
      destroy: async () => {},
    }

    await runIncrementalImpl(client, since)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).toEqual({ n: 0 })
  })
})
