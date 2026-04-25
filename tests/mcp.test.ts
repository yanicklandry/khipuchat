import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, upsertChat, insertMessage } from '../src/db'
import {
  handleFindChatByName,
  handleListMessages,
  handleSearchMessages,
  handleGetChatSummary,
} from '../src/mcp'

const T = 1700000000

function msg(
  telegramId: string,
  chatId: number,
  text: string | null,
  type: 'text' | 'voice' | 'image' | 'notice',
  offset: number,
  isSender: 0 | 1 = 0,
  senderName = 'Tony',
) {
  return {
    telegram_id: telegramId,
    chat_id: chatId,
    sender_id: '999',
    sender_name: senderName,
    text,
    type,
    timestamp: T + offset,
    is_sender: isSender,
    reply_to_telegram_id: null,
  } as const
}

// ── Seed helper ───────────────────────────────────────────────────────────────

function seed() {
  upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: 'tonylin1115' })
  upsertChat({ id: 2, name: 'Work Group', type: 'group', username: null })

  // Tony Lin — mixed message types
  insertMessage(msg('1', 1, 'hello there', 'text', 1))
  insertMessage(msg('2', 1, null, 'voice', 2))          // no text — excluded from list_messages
  insertMessage(msg('3', 1, '', 'text', 3))             // empty text — excluded from list_messages
  insertMessage(msg('4', 1, 'how are you', 'text', 4))
  insertMessage(msg('5', 1, null, 'image', 5))          // no text — excluded
  insertMessage(msg('6', 1, 'doing well', 'text', 6, 1, 'Me'))

  // Work Group — a few messages
  insertMessage(msg('10', 2, 'meeting at 3', 'text', 10))
  insertMessage(msg('11', 2, 'sounds good', 'text', 11))
}

beforeEach(() => {
  initDb(':memory:')
  seed()
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

  it('result shape includes chat_id, name, type, username, message_count', () => {
    const [r] = handleFindChatByName('Tony')
    expect(r).toMatchObject({ chat_id: 1, name: 'Tony Lin', type: 'user', username: 'tonylin1115' })
    expect(typeof r.message_count).toBe('number')
  })

  it('sorts by message_count descending', () => {
    // Tony Lin has 6 messages, Work Group has 2 — search "o" matches both
    const results = handleFindChatByName('o')
    expect(results[0].message_count).toBeGreaterThanOrEqual(results[1].message_count)
  })
})

// ── list_messages ─────────────────────────────────────────────────────────────

describe('handleListMessages', () => {
  it('only returns type=text messages with non-null, non-empty text', () => {
    const msgs = handleListMessages(1, 50)
    // telegram_ids 1, 4, 6 are valid text messages; 2 (voice, null), 3 (empty), 5 (image) excluded
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
    // Only 3 valid text messages, all returned — confirms default limit ≥ 3
    expect(handleListMessages(1)).toHaveLength(3)
  })

  it('caps limit at 200', () => {
    // Requesting 999 should be treated as 200 — no error
    expect(() => handleListMessages(1, 999)).not.toThrow()
    expect(handleListMessages(1, 999)).toHaveLength(3) // only 3 exist
  })

  it('supports before_timestamp pagination', () => {
    // Messages at T+1, T+4, T+6 — before T+5 gives T+1 and T+4
    const msgs = handleListMessages(1, 50, T + 5)
    expect(msgs).toHaveLength(2)
    expect(msgs.map(m => m.text)).toEqual(['hello there', 'how are you'])
  })

  it('result shape includes id, sender_name, text, type, timestamp, is_sender', () => {
    const [r] = handleListMessages(1, 1)
    expect(r).toMatchObject({
      sender_name: 'Tony',
      text: 'hello there',
      type: 'text',
      timestamp: T + 1,
      is_sender: 0,
    })
    expect(typeof r.id).toBe('number')
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

  it('returns empty array when query matches nothing', () => {
    expect(handleSearchMessages('zzznomatch')).toEqual([])
  })

  it('result shape includes chat_id, chat_name, sender_name, text, timestamp', () => {
    const [r] = handleSearchMessages('hello')
    expect(r).toMatchObject({
      chat_id: 1,
      chat_name: 'Tony Lin',
      sender_name: 'Tony',
      text: 'hello there',
    })
    expect(typeof r.timestamp).toBe('number')
  })
})

// ── get_chat_summary ──────────────────────────────────────────────────────────

describe('handleGetChatSummary', () => {
  it('returns correct name, type, username', () => {
    const s = handleGetChatSummary(1)
    expect(s).toMatchObject({ name: 'Tony Lin', type: 'user', username: 'tonylin1115' })
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
    // Valid text messages at T+1, T+4, T+6 — all 3 returned
    expect(s.last_5_texts).toHaveLength(3)
    expect(s.last_5_texts).toContain('doing well')
    expect(s.last_5_texts).toContain('hello there')
  })

  it('returns null dates and empty last_5_texts for a chat with no messages', () => {
    upsertChat({ id: 99, name: 'Empty', type: 'user', username: null })
    const s = handleGetChatSummary(99)
    expect(s.message_count).toBe(0)
    expect(s.first_message_date).toBeNull()
    expect(s.last_message_date).toBeNull()
    expect(s.last_5_texts).toEqual([])
  })
})
