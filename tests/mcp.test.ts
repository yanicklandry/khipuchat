import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, upsertChat, insertMessage, getDb, rebuildFtsIndex } from '../src/db'
import {
  handleListChats,
  handleFindChatByName,
  handleListMessages,
  handleSearchMessages,
  handleGetChatSummary,
  handleSemanticFindContacts,
  handleSemanticSearchMessages,
} from '../src/mcp'
import {
  upsertChatVector,
  upsertMessageVector,
  upsertEmbeddingMeta,
} from '../src/vec-db'

vi.mock('../src/embeddings', () => ({
  embedOne: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.9)),
}))

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
    const { messages } = handleListMessages(1, { limit: 50 })
    expect(messages).toHaveLength(3)
    expect(messages.every(m => m.type === 'text')).toBe(true)
    expect(messages.every(m => m.text !== null && m.text !== '')).toBe(true)
  })

  it('returns messages ordered by timestamp ASC', () => {
    const { messages } = handleListMessages(1, { limit: 50 })
    const timestamps = messages.map(m => m.timestamp)
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b))
  })

  it('defaults to limit 50 when not specified', () => {
    expect(handleListMessages(1).messages).toHaveLength(3)
  })

  it('caps limit at 200', () => {
    expect(() => handleListMessages(1, { limit: 999 })).not.toThrow()
    expect(handleListMessages(1, { limit: 999 }).messages).toHaveLength(3)
  })

  it('supports before_timestamp pagination', () => {
    const { messages } = handleListMessages(1, { limit: 50, before: T + 5 })
    expect(messages).toHaveLength(2)
    expect(messages.map(m => m.text)).toEqual(['hello there', 'how are you'])
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
    const { messages } = handleListMessages(10, { limit: 3, before: T + 100 })
    expect(messages).toHaveLength(3)
    expect(messages.map(m => m.timestamp)).toEqual([T + 70, T + 80, T + 90])
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
    const { messages } = handleListMessages(11, { limit: 3, before: T + 500 })
    const timestamps = messages.map(m => m.timestamp)
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b))
    expect(timestamps[timestamps.length - 1]).toBeLessThan(T + 500)
  })

  it('result shape includes id, sender_name, text, type, timestamp, is_sender, platform', () => {
    // With limit=1 the single most-recent text message is returned.
    const { messages } = handleListMessages(1, { limit: 1 })
    const [r] = messages
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
    const { messages } = handleListMessages(20, { limit: 3 })
    expect(messages).toHaveLength(3)
    // Messages 8, 9, 10 are the 3 most recent, returned in chronological (ASC) order.
    expect(messages.map(m => m.text)).toEqual(['message 8', 'message 9', 'message 10'])
  })

  it('returns has_more=true when there are more messages beyond the page', () => {
    upsertChat({ id: 21, name: 'HasMore Chat', type: 'group', username: null, platform: 'telegram' })
    for (let i = 1; i <= 5; i++) {
      insertMessage({
        external_id: String(600 + i), chat_id: 21, sender_id: '1', sender_name: 'Alice',
        text: `msg ${i}`, type: 'text', timestamp: T + i * 10, is_sender: 0,
        reply_to_external_id: null, platform: 'telegram',
      })
    }
    const result = handleListMessages(21, { limit: 3 })
    expect(result.has_more).toBe(true)
    expect(result.messages).toHaveLength(3)
  })

  it('returns has_more=false when all messages fit in the page', () => {
    upsertChat({ id: 22, name: 'Small Chat', type: 'group', username: null, platform: 'telegram' })
    for (let i = 1; i <= 3; i++) {
      insertMessage({
        external_id: String(700 + i), chat_id: 22, sender_id: '1', sender_name: 'Alice',
        text: `msg ${i}`, type: 'text', timestamp: T + i * 10, is_sender: 0,
        reply_to_external_id: null, platform: 'telegram',
      })
    }
    const result = handleListMessages(22, { limit: 10 })
    expect(result.has_more).toBe(false)
    expect(result.messages).toHaveLength(3)
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

// ── semantic_find_contacts ────────────────────────────────────────────────────

const CLOSE_VEC = new Float32Array(384).fill(0.9)
const FAR_VEC = (() => {
  const v = new Float32Array(384)
  for (let i = 0; i < 192; i++) v[i] = 1.0
  for (let i = 192; i < 384; i++) v[i] = -1.0
  return v
})()

describe('handleSemanticFindContacts', () => {
  it('returns error object when chats index is not built', async () => {
    const result = await handleSemanticFindContacts('old friend', {})
    expect(result).toMatchObject({ error: expect.stringContaining('index') })
  })

  it('returns results after index is built and vectors seeded', async () => {
    upsertEmbeddingMeta('chats', Date.now())
    upsertChatVector(1, CLOSE_VEC)  // Tony Lin — close to query
    upsertChatVector(2, FAR_VEC)    // Work Group — far (filtered by distance threshold)
    upsertChatVector(3, CLOSE_VEC)  // iMsg Friend — close

    const result = await handleSemanticFindContacts('old friend', {})
    expect(Array.isArray(result)).toBe(true)
    const results = result as { chat_id: number; name: string; platform: string; distance: number }[]
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.distance <= 0.7)).toBe(true)
    expect(results.find(r => r.chat_id === 1)).toBeDefined()
    expect(results.find(r => r.chat_id === 2)).toBeUndefined() // filtered by threshold
  })

  it('platform filter returns only matching platform', async () => {
    upsertEmbeddingMeta('chats', Date.now())
    upsertChatVector(1, CLOSE_VEC)
    upsertChatVector(3, CLOSE_VEC)

    const result = await handleSemanticFindContacts('friend', { platform: 'imessage' })
    expect(Array.isArray(result)).toBe(true)
    const results = result as { chat_id: number; platform: string }[]
    expect(results.every(r => r.platform === 'imessage')).toBe(true)
    expect(results.find(r => r.platform === 'telegram')).toBeUndefined()
  })

  it('result shape includes chat_id, name, platform, distance', async () => {
    upsertEmbeddingMeta('chats', Date.now())
    upsertChatVector(1, CLOSE_VEC)

    const result = await handleSemanticFindContacts('tony', {})
    const results = result as { chat_id: number; name: string; platform: string; distance: number }[]
    const tony = results.find(r => r.chat_id === 1)
    expect(tony).toMatchObject({ chat_id: 1, name: 'Tony Lin', platform: 'telegram' })
    expect(typeof tony!.distance).toBe('number')
  })
})

// ── semantic_search_messages ──────────────────────────────────────────────────

describe('handleSemanticSearchMessages', () => {
  it('returns error object when messages index is not built', async () => {
    const result = await handleSemanticSearchMessages('hello', {})
    expect(result).toMatchObject({ error: expect.stringContaining('index') })
  })

  it('returns results after index is built and vectors seeded', async () => {
    upsertEmbeddingMeta('messages', Date.now())
    // seed all text messages (IDs 1-3 from Tony Lin, IDs 4-6 from Work Group, ID 7 from iMsg)
    // We don't know exact IDs so seed broadly
    const db = getDb()
    const rows = db.prepare("SELECT id FROM messages WHERE type='text' AND text IS NOT NULL AND text != ''").all() as { id: number }[]
    for (const { id } of rows) upsertMessageVector(id, CLOSE_VEC)

    const result = await handleSemanticSearchMessages('greeting', {})
    expect(Array.isArray(result)).toBe(true)
    const results = result as { id: number; text: string; distance: number }[]
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.distance <= 0.7)).toBe(true)
  })

  it('platform filter returns only matching platform messages', async () => {
    upsertEmbeddingMeta('messages', Date.now())
    const db = getDb()
    const rows = db.prepare("SELECT id FROM messages WHERE type='text' AND text IS NOT NULL AND text != ''").all() as { id: number }[]
    for (const { id } of rows) upsertMessageVector(id, CLOSE_VEC)

    const result = await handleSemanticSearchMessages('hey', { platform: 'imessage' })
    const results = result as { platform: string }[]
    expect(results.every(r => r.platform === 'imessage')).toBe(true)
  })

  it('before_timestamp filter excludes later messages', async () => {
    upsertEmbeddingMeta('messages', Date.now())
    const db = getDb()
    const rows = db.prepare("SELECT id FROM messages WHERE type='text' AND text IS NOT NULL AND text != ''").all() as { id: number }[]
    for (const { id } of rows) upsertMessageVector(id, CLOSE_VEC)

    const cutoff = T + 5
    const result = await handleSemanticSearchMessages('message', { before_timestamp: cutoff })
    const results = result as { timestamp: number }[]
    expect(results.every(r => r.timestamp < cutoff)).toBe(true)
  })

  it('result shape includes id, text, platform, timestamp, distance', async () => {
    upsertEmbeddingMeta('messages', Date.now())
    const db = getDb()
    const rows = db.prepare("SELECT id FROM messages WHERE type='text' AND text IS NOT NULL AND text != ''").all() as { id: number }[]
    for (const { id } of rows) upsertMessageVector(id, CLOSE_VEC)

    const result = await handleSemanticSearchMessages('hello', {})
    const results = result as { chat_id: number; chat_name: string; text: string; platform: string; timestamp: number; distance: number }[]
    expect(results.length).toBeGreaterThan(0)
    const r = results[0]
    expect(typeof r.chat_id).toBe('number')
    expect(typeof r.chat_name).toBe('string')
    expect(typeof r.text).toBe('string')
    expect(typeof r.platform).toBe('string')
    expect(typeof r.timestamp).toBe('number')
    expect(typeof r.distance).toBe('number')
  })
})
