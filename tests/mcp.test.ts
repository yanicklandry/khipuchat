import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, upsertChat, insertMessage, getDb, rebuildFtsIndex } from '../src/db'
import {
  handleListChats,
  handleFindChatByName,
  handleListMessages,
  handleSearchMessages,
  handleGetChatSummary,
} from '../src/mcp'

const T = 1700000000

function msg(
  externalId: string,
  chatId: number,
  text: string | null,
  type: 'text' | 'voice' | 'image' | 'notice',
  offset: number,
  isSender: 0 | 1 = 0,
  senderName = 'Tony',
  platform: 'telegram' | 'imessage' = 'telegram',
) {
  return {
    external_id: externalId,
    chat_id: chatId,
    sender_id: '999',
    sender_name: senderName,
    text,
    type,
    timestamp: T + offset,
    is_sender: isSender,
    reply_to_external_id: null,
    platform,
  } as const
}

// ── Seed helper ───────────────────────────────────────────────────────────────

function seed() {
  upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: 'tonylin1115', platform: 'telegram' })
  upsertChat({ id: 2, name: 'Work Group', type: 'group', username: null, platform: 'telegram' })
  upsertChat({ id: 3, name: 'iMsg Friend', type: 'user', username: null, platform: 'imessage' })

  // Tony Lin — mixed message types (platform: telegram)
  insertMessage(msg('1', 1, 'hello there', 'text', 1))
  insertMessage(msg('2', 1, null, 'voice', 2))
  insertMessage(msg('3', 1, '', 'text', 3))
  insertMessage(msg('4', 1, 'how are you', 'text', 4))
  insertMessage(msg('5', 1, null, 'image', 5))
  insertMessage(msg('6', 1, 'doing well', 'text', 6, 1, 'Me'))

  // Work Group — a few messages (platform: telegram)
  insertMessage(msg('10', 2, 'meeting at 3', 'text', 10))
  insertMessage(msg('11', 2, 'sounds good', 'text', 11))

  // iMessage chat — one message for platform filter tests
  insertMessage(msg('20', 3, 'hey from imessage', 'text', 20, 0, 'Friend', 'imessage'))
}

beforeEach(() => {
  initDb(':memory:')
  seed()
})

// ── list_chats ────────────────────────────────────────────────────────────────

describe('handleListChats', () => {
  it('returns all chats when no platform filter', () => {
    const results = handleListChats()
    expect(results.length).toBeGreaterThanOrEqual(3)
  })

  it('filters by platform', () => {
    const tg = handleListChats('telegram')
    expect(tg.every(r => r.platform === 'telegram')).toBe(true)
    const im = handleListChats('imessage')
    expect(im).toHaveLength(1)
    expect(im[0].platform).toBe('imessage')
  })

  it('respects limit parameter', () => {
    expect(handleListChats(undefined, 2)).toHaveLength(2)
  })

  it('result shape includes chat_id, name, type, username, message_count, platform', () => {
    const results = handleListChats('telegram')
    const tony = results.find(r => r.name === 'Tony Lin')
    expect(tony).toBeDefined()
    expect(tony).toMatchObject({ chat_id: 1, name: 'Tony Lin', type: 'user', username: 'tonylin1115', platform: 'telegram' })
    expect(typeof tony!.message_count).toBe('number')
  })

  it('sorts by most recent activity (chat with latest message comes first)', () => {
    // iMsg Friend has timestamp T+20, Tony Lin max is T+6, Work Group max is T+11
    const results = handleListChats()
    expect(results[0].name).toBe('iMsg Friend')
  })
})

// ── find_chat_by_name ─────────────────────────────────────────────────────────

describe('handleFindChatByName', () => {
  it('matches by partial name, case-insensitive', () => {
    const results = handleFindChatByName('tony')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('Tony Lin')
  })

  it('matches by username', () => {
    const results = handleFindChatByName('tonylin')
    expect(results).toHaveLength(1)
    expect(results[0].chat_id).toBe(1)
  })

  it('returns empty array when nothing matches', () => {
    expect(handleFindChatByName('zzznomatch')).toEqual([])
  })

  it('result shape includes chat_id, name, type, username, message_count, platform', () => {
    const [r] = handleFindChatByName('Tony')
    expect(r).toMatchObject({ chat_id: 1, name: 'Tony Lin', type: 'user', username: 'tonylin1115', platform: 'telegram' })
    expect(typeof r.message_count).toBe('number')
  })

  it('sorts by message_count descending', () => {
    const results = handleFindChatByName('o')
    expect(results[0].message_count).toBeGreaterThanOrEqual(results[1].message_count)
  })

  it('platform filter returns only telegram chats', () => {
    const results = handleFindChatByName('', 'telegram')
    expect(results.every(r => r.platform === 'telegram')).toBe(true)
    expect(results.some(r => r.name === 'iMsg Friend')).toBe(false)
  })

  it('platform filter returns only imessage chats', () => {
    const results = handleFindChatByName('', 'imessage')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('iMsg Friend')
  })

  it('omitting platform returns chats from all platforms', () => {
    const results = handleFindChatByName('')
    expect(results.length).toBeGreaterThanOrEqual(3)
  })
})

// ── list_messages ─────────────────────────────────────────────────────────────

describe('handleListMessages', () => {
  it('only returns type=text messages with non-null, non-empty text', () => {
    const msgs = handleListMessages(1, 50)
    expect(msgs).toHaveLength(3)
    expect(msgs.every(m => m.type === 'text')).toBe(true)
    expect(msgs.every(m => m.text !== null && m.text !== '')).toBe(true)
  })

  it('returns messages ordered by timestamp ASC', () => {
    const msgs = handleListMessages(1, 50)
    const timestamps = msgs.map(m => m.timestamp)
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b))
  })

  it('defaults to limit 50 when not specified', () => {
    expect(handleListMessages(1)).toHaveLength(3)
  })

  it('caps limit at 200', () => {
    expect(() => handleListMessages(1, 999)).not.toThrow()
    expect(handleListMessages(1, 999)).toHaveLength(3)
  })

  it('supports before_timestamp pagination', () => {
    const msgs = handleListMessages(1, 50, T + 5)
    expect(msgs).toHaveLength(2)
    expect(msgs.map(m => m.text)).toEqual(['hello there', 'how are you'])
  })

  it('returns the N most recent messages before timestamp when more than N exist', () => {
    upsertChat({ id: 10, name: 'Big Chat', type: 'group', username: null, platform: 'telegram' })
    for (let i = 1; i <= 10; i++) {
      insertMessage({
        external_id: String(200 + i), chat_id: 10, sender_id: '1', sender_name: 'Alice',
        text: `message ${i}`, type: 'text', timestamp: T + i * 10, is_sender: 0,
        reply_to_external_id: null, platform: 'telegram',
      })
    }
    const msgs = handleListMessages(10, 3, T + 100)
    expect(msgs).toHaveLength(3)
    expect(msgs.map(m => m.timestamp)).toEqual([T + 70, T + 80, T + 90])
  })

  it('returns results in chronological order even when paginating backwards', () => {
    upsertChat({ id: 11, name: 'Ordered Chat', type: 'group', username: null, platform: 'telegram' })
    for (let i = 1; i <= 5; i++) {
      insertMessage({
        external_id: String(300 + i), chat_id: 11, sender_id: '1', sender_name: 'Bob',
        text: `msg ${i}`, type: 'text', timestamp: T + i * 100, is_sender: 0,
        reply_to_external_id: null, platform: 'telegram',
      })
    }
    const msgs = handleListMessages(11, 3, T + 500)
    const timestamps = msgs.map(m => m.timestamp)
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b))
    expect(timestamps[timestamps.length - 1]).toBeLessThan(T + 500)
  })

  it('result shape includes id, sender_name, text, type, timestamp, is_sender, platform', () => {
    // With limit=1 the single most-recent text message is returned.
    const [r] = handleListMessages(1, 1)
    expect(r).toMatchObject({
      sender_name: 'Me', text: 'doing well', type: 'text', timestamp: T + 6,
      is_sender: 1, platform: 'telegram',
    })
    expect(typeof r.id).toBe('number')
  })

  it('returns the N most recent text messages when no beforeTimestamp', () => {
    upsertChat({ id: 20, name: 'Big Chat', type: 'group', username: null, platform: 'telegram' })
    for (let i = 1; i <= 10; i++) {
      insertMessage({
        external_id: String(500 + i), chat_id: 20, sender_id: '1', sender_name: 'Alice',
        text: `message ${i}`, type: 'text', timestamp: T + i * 10, is_sender: 0,
        reply_to_external_id: null, platform: 'telegram',
      })
    }
    const msgs = handleListMessages(20, 3)
    expect(msgs).toHaveLength(3)
    // Messages 8, 9, 10 are the 3 most recent, returned in chronological (ASC) order.
    expect(msgs.map(m => m.text)).toEqual(['message 8', 'message 9', 'message 10'])
  })
})

// ── search_messages ───────────────────────────────────────────────────────────

describe('handleSearchMessages', () => {
  it('returns FTS matches across all chats', () => {
    const results = handleSearchMessages('meeting')
    expect(results).toHaveLength(1)
    expect(results[0].text).toBe('meeting at 3')
  })

  it('filters to a specific chat when chat_id is provided', () => {
    const results = handleSearchMessages('hello', 1)
    expect(results).toHaveLength(1)
    expect(results[0].chat_id).toBe(1)
  })

  it('finds messages after rebuildFtsIndex restores search', () => {
    getDb().exec("DELETE FROM messages_fts")
    expect(handleSearchMessages('meeting')).toHaveLength(0)
    rebuildFtsIndex()
    expect(handleSearchMessages('meeting')).toHaveLength(1)
  })

  it('returns empty array when query matches nothing', () => {
    expect(handleSearchMessages('zzznomatch')).toEqual([])
  })

  it('result shape includes chat_id, chat_name, sender_name, text, timestamp, platform', () => {
    const [r] = handleSearchMessages('hello')
    expect(r).toMatchObject({
      chat_id: 1, chat_name: 'Tony Lin', sender_name: 'Tony',
      text: 'hello there', platform: 'telegram',
    })
    expect(typeof r.timestamp).toBe('number')
  })

  it('platform filter returns only telegram messages', () => {
    const results = handleSearchMessages('hey', undefined, 'telegram')
    expect(results).toHaveLength(0) // 'hey' only in imessage chat
  })

  it('platform filter returns only imessage messages', () => {
    const results = handleSearchMessages('hey', undefined, 'imessage')
    expect(results).toHaveLength(1)
    expect(results[0].platform).toBe('imessage')
  })

  it('omitting platform returns messages from all platforms', () => {
    const results = handleSearchMessages('hey')
    expect(results).toHaveLength(1) // only in imessage chat
    expect(results[0].platform).toBe('imessage')
  })
})

// ── get_chat_summary ──────────────────────────────────────────────────────────

describe('handleGetChatSummary', () => {
  it('returns correct name, type, username, platform', () => {
    const s = handleGetChatSummary(1)
    expect(s).toMatchObject({ name: 'Tony Lin', type: 'user', username: 'tonylin1115', platform: 'telegram' })
  })

  it('returns total message_count (all types)', () => {
    const s = handleGetChatSummary(1)
    expect(s.message_count).toBe(6)
  })

  it('returns first and last message timestamps', () => {
    const s = handleGetChatSummary(1)
    expect(s.first_message_date).toBe(T + 1)
    expect(s.last_message_date).toBe(T + 6)
  })

  it('returns up to 5 most recent text messages in last_5_texts', () => {
    const s = handleGetChatSummary(1)
    expect(s.last_5_texts).toHaveLength(3)
    expect(s.last_5_texts).toContain('doing well')
    expect(s.last_5_texts).toContain('hello there')
  })

  it('returns null dates and empty last_5_texts for a chat with no messages', () => {
    upsertChat({ id: 99, name: 'Empty', type: 'user', username: null, platform: 'telegram' })
    const s = handleGetChatSummary(99)
    expect(s.message_count).toBe(0)
    expect(s.first_message_date).toBeNull()
    expect(s.last_message_date).toBeNull()
    expect(s.last_5_texts).toEqual([])
  })

  it('result includes platform field', () => {
    const s = handleGetChatSummary(3)
    expect(s.platform).toBe('imessage')
  })
})
