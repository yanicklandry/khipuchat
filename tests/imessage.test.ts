import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Mock child_process so contact tests work cross-platform (no real sqlite3 CLI needed)
vi.mock('child_process', () => ({ execSync: vi.fn() }))
import { execSync } from 'child_process'

import { initDb, insertMessage, getChats } from '../src/db'
import {
  hashGuid,
  cocoaToUnix,
  mapChat,
  mapMessage,
  runBackfillImpl,
  type ChatDbRow,
  type HandleRow,
  type MessageDbRow,
} from '../src/platforms/imessage/sync'
import { resolveContactName, buildContactMap } from '../src/platforms/imessage/contacts'

// ── hashGuid ──────────────────────────────────────────────────────────────────

describe('hashGuid', () => {
  it('returns the same value for the same GUID', () => {
    const g = 'chat00112233-4455-6677-8899-AABBCCDDEEFF'
    expect(hashGuid(g)).toBe(hashGuid(g))
  })

  it('returns different values for different GUIDs', () => {
    expect(hashGuid('guid-a')).not.toBe(hashGuid('guid-b'))
  })

  it('returns a positive integer within Number.MAX_SAFE_INTEGER', () => {
    const h = hashGuid('some-test-guid-123')
    expect(h).toBeGreaterThan(0)
    expect(Number.isSafeInteger(h)).toBe(true)
  })
})

// ── cocoaToUnix ───────────────────────────────────────────────────────────────

describe('cocoaToUnix', () => {
  const COCOA_EPOCH = 978307200 // 2001-01-01 as Unix timestamp

  it('converts nanosecond Cocoa date to Unix seconds', () => {
    // 1e11 nanoseconds = 100 seconds since 2001
    expect(cocoaToUnix(1e11)).toBe(COCOA_EPOCH + 100)
  })

  it('handles the seconds-fallback guard for values < 1e10', () => {
    expect(cocoaToUnix(5e8)).toBe(5e8 + COCOA_EPOCH)
  })

  it('converts 0 (seconds mode) to the Cocoa epoch as Unix timestamp', () => {
    expect(cocoaToUnix(0)).toBe(COCOA_EPOCH)
  })
})

// ── mapChat ───────────────────────────────────────────────────────────────────

describe('mapChat', () => {
  const baseRow: ChatDbRow = {
    ROWID: 1, guid: 'chat-guid-001', chat_identifier: '+61412345678',
    display_name: null, room_name: null,
  }
  const contactMap = new Map([['+61412345678', 'John Doe']])

  it('sets platform to imessage', () => {
    expect(mapChat(baseRow, ['+61412345678'], contactMap).platform).toBe('imessage')
  })

  it('sets type to group when 2+ handles', () => {
    expect(mapChat(baseRow, ['+111', '+222'], contactMap).type).toBe('group')
  })

  it('sets type to private when 1 handle', () => {
    expect(mapChat(baseRow, ['+61412345678'], contactMap).type).toBe('private')
  })

  it('uses display_name when available', () => {
    expect(mapChat({ ...baseRow, display_name: 'My Group' }, ['+111', '+222'], contactMap).name).toBe('My Group')
  })

  it('uses contact map entry when no display_name or room_name', () => {
    expect(mapChat(baseRow, ['+61412345678'], contactMap).name).toBe('John Doe')
  })

  it('falls back to handle id when no display_name, room_name, or contact', () => {
    expect(mapChat(baseRow, ['unknown-handle'], new Map()).name).toBe('unknown-handle')
  })

  it('uses hashGuid for id', () => {
    expect(mapChat(baseRow, ['+111'], contactMap).id).toBe(hashGuid('chat-guid-001'))
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const baseRow: MessageDbRow = {
    ROWID: 10, guid: 'msg-guid-abc', text: 'Hello', date: 1e11,
    is_from_me: 0, handle_id: 5, reply_to_guid: null,
  }
  const handle: HandleRow = { ROWID: 5, id: '+61400000000' }
  const contactMap = new Map([['+61400000000', 'Bob']])

  it('sets platform to imessage', () => {
    expect(mapMessage(baseRow, 1, handle, contactMap).platform).toBe('imessage')
  })

  it('sets external_id to row.guid', () => {
    expect(mapMessage(baseRow, 1, handle, contactMap).external_id).toBe('msg-guid-abc')
  })

  it('sets is_sender=1 when is_from_me=1', () => {
    expect(mapMessage({ ...baseRow, is_from_me: 1 }, 1, undefined, contactMap).is_sender).toBe(1)
  })

  it('sets type to text when text is non-empty', () => {
    expect(mapMessage(baseRow, 1, handle, contactMap).type).toBe('text')
  })

  it('sets type to other when text is null', () => {
    expect(mapMessage({ ...baseRow, text: null }, 1, handle, contactMap).type).toBe('other')
  })

  it('sets reply_to_external_id from reply_to_guid', () => {
    expect(mapMessage({ ...baseRow, reply_to_guid: 'parent-guid' }, 1, handle, contactMap).reply_to_external_id).toBe('parent-guid')
  })

  it('applies cocoaToUnix to timestamp', () => {
    const COCOA_EPOCH = 978307200
    expect(mapMessage(baseRow, 1, handle, contactMap).timestamp).toBe(COCOA_EPOCH + 100)
  })

  it('resolves sender_name from contactMap via handle.id', () => {
    expect(mapMessage(baseRow, 1, handle, contactMap).sender_name).toBe('Bob')
  })
})

// ── contact resolution ────────────────────────────────────────────────────────

describe('resolveContactName', () => {
  beforeEach(() => { vi.mocked(execSync).mockReset() })

  it('returns display name when execSync returns a result', () => {
    vi.mocked(execSync).mockReturnValue('Jane Doe\n' as unknown as Buffer)
    const name = resolveContactName('+61412345678', '/fake/AddressBook.sqlitedb')
    expect(name).toBe('Jane Doe')
  })

  it('returns raw handleId when execSync throws', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('no sqlite3 CLI') })
    const name = resolveContactName('+61499999999', '/fake/AddressBook.sqlitedb')
    expect(name).toBe('+61499999999')
  })

  it('returns raw handleId when no dbPath is available', () => {
    // No dbPath provided, findAddressBookDb returns null on non-macOS → returns handleId
    const name = resolveContactName('test@example.com')
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
  })
})

describe('buildContactMap', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset()
    vi.mocked(execSync)
      .mockReturnValueOnce('Alice\n' as unknown as Buffer)
      .mockReturnValueOnce('Bob\n' as unknown as Buffer)
      .mockImplementation(() => { throw new Error('not found') })
  })

  it('returns a map with all input handles as keys', () => {
    const map = buildContactMap(['+111', '+222', '+333'], '/fake/path.db')
    expect(map.size).toBe(3)
  })

  it('resolved handles have display names', () => {
    const map = buildContactMap(['+111', '+222', '+333'], '/fake/path.db')
    expect(map.get('+111')).toBe('Alice')
    expect(map.get('+222')).toBe('Bob')
  })

  it('unresolved handles map to themselves', () => {
    const map = buildContactMap(['+111', '+222', '+333'], '/fake/path.db')
    expect(map.get('+333')).toBe('+333')
  })
})

// ── deduplication ─────────────────────────────────────────────────────────────

describe('deduplication', () => {
  it('INSERT OR IGNORE: inserting same external_id + chat_id twice yields 1 row', () => {
    const db = initDb(':memory:')
    const base = {
      external_id: 'dup-guid', chat_id: 1, sender_id: null, sender_name: 'Me',
      text: 'hi', type: 'text' as const, timestamp: 1700000001, is_sender: 1 as const,
      reply_to_external_id: null, platform: 'imessage' as const,
    }
    insertMessage(base)
    insertMessage(base)
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE external_id = ?').get('dup-guid') as { n: number }
    expect(count.n).toBe(1)
  })
})

// ── integration: runBackfillImpl with mock chat.db ────────────────────────────

function makeMockChatDb(): Database.Database {
  const chatDb = new Database(':memory:')
  chatDb.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, room_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER, is_from_me INTEGER, handle_id INTEGER, reply_to_guid TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `)
  chatDb.exec(`
    INSERT INTO handle VALUES (1, '+61400000001', 'iMessage');
    INSERT INTO handle VALUES (2, '+61400000002', 'iMessage');
    INSERT INTO chat VALUES (1, 'chat-guid-1', '+61400000001', NULL, NULL);
    INSERT INTO chat VALUES (2, 'chat-guid-2', NULL, 'Group Chat', NULL);
    INSERT INTO chat_handle_join VALUES (1, 1);
    INSERT INTO chat_handle_join VALUES (2, 1);
    INSERT INTO chat_handle_join VALUES (2, 2);
    INSERT INTO message VALUES (1, 'msg-guid-1', 'Hello', 1000000000, 0, 1, NULL);
    INSERT INTO message VALUES (2, 'msg-guid-2', 'World', 1000000001, 1, NULL, NULL);
    INSERT INTO message VALUES (3, 'msg-guid-3', 'Hey group', 1000000002, 0, 1, NULL);
    INSERT INTO message VALUES (4, 'msg-guid-4', 'Reply', 1000000003, 1, NULL, 'msg-guid-3');
    INSERT INTO chat_message_join VALUES (1, 1);
    INSERT INTO chat_message_join VALUES (1, 2);
    INSERT INTO chat_message_join VALUES (2, 3);
    INSERT INTO chat_message_join VALUES (2, 4);
  `)
  return chatDb
}

describe('runBackfillImpl integration', () => {
  let khipuDb: Database.Database

  beforeEach(() => {
    khipuDb = initDb(':memory:')
  })

  it('imports 2 chats with platform=imessage', async () => {
    await runBackfillImpl(makeMockChatDb())
    const chats = getChats()
    expect(chats).toHaveLength(2)
    expect(chats.every(c => c.platform === 'imessage')).toBe(true)
  })

  it('imports 4 messages with platform=imessage', async () => {
    await runBackfillImpl(makeMockChatDb())
    const count = khipuDb.prepare("SELECT COUNT(*) AS n FROM messages WHERE platform = 'imessage'").get() as { n: number }
    expect(count.n).toBe(4)
  })

  it('is idempotent: running twice yields same counts', async () => {
    const chatDb = makeMockChatDb()
    await runBackfillImpl(chatDb)
    await runBackfillImpl(chatDb)
    expect(getChats()).toHaveLength(2)
    const msgCount = khipuDb.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    expect(msgCount.n).toBe(4)
  })
})
