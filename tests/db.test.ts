import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDb,
  upsertChat,
  insertMessage,
  getChats,
  getMessages,
  searchMessages,
  getLastSyncedId,
} from '../src/db'

const T = 1700000000

beforeEach(() => {
  initDb(':memory:')
})

// ── Schema ────────────────────────────────────────────────────────────────────

describe('schema', () => {
  it('creates chats and messages tables', () => {
    const tables = initDb(':memory:')
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .pluck()
      .all() as string[]
    expect(tables).toContain('chats')
    expect(tables).toContain('messages')
  })

  it('creates the messages_fts FTS5 virtual table', () => {
    const tables = initDb(':memory:')
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .pluck()
      .all() as string[]
    expect(tables).toContain('messages_fts')
  })

  it('creates index on messages(chat_id, timestamp)', () => {
    const indexes = initDb(':memory:')
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .pluck()
      .all() as string[]
    expect(indexes).toContain('idx_messages_chat_timestamp')
  })

  it('creates index on messages(chat_id, type)', () => {
    const indexes = initDb(':memory:')
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .pluck()
      .all() as string[]
    expect(indexes).toContain('idx_messages_chat_type')
  })
})

// ── upsertChat ────────────────────────────────────────────────────────────────

describe('upsertChat', () => {
  it('inserts a new chat and getChats returns it', () => {
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: 'tonylin1115' })
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ id: 1, name: 'Tony Lin', type: 'user', username: 'tonylin1115' })
  })

  it('upserting the same id overwrites name and username', () => {
    upsertChat({ id: 1, name: 'Tony', type: 'user', username: null })
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: 'tonylin1115' })
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0].name).toBe('Tony Lin')
    expect(chats[0].username).toBe('tonylin1115')
  })

  it('two different chats coexist — getChats returns both', () => {
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: null })
    upsertChat({ id: 2, name: 'Work Group', type: 'group', username: null })
    expect(getChats()).toHaveLength(2)
  })
})

// ── insertMessage ─────────────────────────────────────────────────────────────

describe('insertMessage', () => {
  beforeEach(() => {
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: null })
    upsertChat({ id: 2, name: 'Other Chat', type: 'group', username: null })
  })

  it('inserts a message and getMessages returns it with correct fields', () => {
    insertMessage({
      telegram_id: '100',
      chat_id: 1,
      sender_id: '999',
      sender_name: 'Tony Lin',
      text: 'Hello!',
      type: 'text',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_telegram_id: null,
    })
    const msgs = getMessages(1, 10)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      telegram_id: '100',
      chat_id: 1,
      sender_name: 'Tony Lin',
      text: 'Hello!',
      type: 'text',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_telegram_id: null,
    })
  })

  it('duplicate (telegram_id, chat_id) does not throw and is silently ignored', () => {
    const msg = {
      telegram_id: '100',
      chat_id: 1,
      sender_id: '999',
      sender_name: 'Tony Lin',
      text: 'Hello!',
      type: 'text',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_telegram_id: null,
    }
    insertMessage(msg)
    expect(() => insertMessage(msg)).not.toThrow()
    expect(getMessages(1, 10)).toHaveLength(1)
  })

  it('same telegram_id under a different chat_id is accepted as a distinct row', () => {
    insertMessage({
      telegram_id: '100', chat_id: 1, sender_id: '1', sender_name: 'Tony',
      text: 'Hi', type: 'text', timestamp: T + 1, is_sender: 0, reply_to_telegram_id: null,
    })
    insertMessage({
      telegram_id: '100', chat_id: 2, sender_id: '2', sender_name: 'Bob',
      text: 'Hey', type: 'text', timestamp: T + 2, is_sender: 0, reply_to_telegram_id: null,
    })
    expect(getMessages(1, 10)).toHaveLength(1)
    expect(getMessages(2, 10)).toHaveLength(1)
  })
})

// ── getMessages ───────────────────────────────────────────────────────────────

describe('getMessages', () => {
  beforeEach(() => {
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: null })
    upsertChat({ id: 2, name: 'Other', type: 'group', username: null })
    for (let i = 1; i <= 5; i++) {
      insertMessage({
        telegram_id: String(i),
        chat_id: 1,
        sender_id: '999',
        sender_name: 'Tony',
        text: `Message ${i}`,
        type: 'text',
        timestamp: T + i,
        is_sender: 0,
        reply_to_telegram_id: null,
      })
    }
    // one message in a different chat — must not appear in chat 1 results
    insertMessage({
      telegram_id: '99', chat_id: 2, sender_id: '2', sender_name: 'Bob',
      text: 'Other chat msg', type: 'text', timestamp: T + 1, is_sender: 0, reply_to_telegram_id: null,
    })
  })

  it('returns [] for an unknown chatId', () => {
    expect(getMessages(99, 10)).toEqual([])
  })

  it('returns messages ordered by timestamp ASC', () => {
    const msgs = getMessages(1, 10)
    expect(msgs.map(m => m.telegram_id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('respects the limit parameter', () => {
    expect(getMessages(1, 3)).toHaveLength(3)
  })

  it('beforeTimestamp returns only rows with timestamp < beforeTimestamp', () => {
    // T+1, T+2 are < T+3; T+3, T+4, T+5 are not
    const msgs = getMessages(1, 10, T + 3)
    expect(msgs.map(m => m.telegram_id)).toEqual(['1', '2'])
  })

  it('does not bleed messages from a different chatId', () => {
    const msgs = getMessages(1, 10)
    expect(msgs.every(m => m.chat_id === 1)).toBe(true)
  })
})

// ── searchMessages ────────────────────────────────────────────────────────────

describe('searchMessages', () => {
  beforeEach(() => {
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: null })
    upsertChat({ id: 2, name: 'Other Chat', type: 'group', username: null })
    insertMessage({
      telegram_id: '1', chat_id: 1, sender_id: '1', sender_name: 'Tony',
      text: 'hello world', type: 'text', timestamp: T + 1, is_sender: 0, reply_to_telegram_id: null,
    })
    insertMessage({
      telegram_id: '2', chat_id: 2, sender_id: '2', sender_name: 'Bob',
      text: 'hello there', type: 'text', timestamp: T + 2, is_sender: 0, reply_to_telegram_id: null,
    })
    insertMessage({
      telegram_id: '3', chat_id: 1, sender_id: '1', sender_name: 'Tony',
      text: 'goodbye', type: 'text', timestamp: T + 3, is_sender: 0, reply_to_telegram_id: null,
    })
  })

  it('returns all matching rows across chats when chatId is omitted', () => {
    expect(searchMessages('hello')).toHaveLength(2)
  })

  it('filters to a single chat when chatId is provided', () => {
    const results = searchMessages('hello', 1)
    expect(results).toHaveLength(1)
    expect(results[0].chat_id).toBe(1)
  })

  it('returns [] when query matches nothing', () => {
    expect(searchMessages('zzznomatch')).toEqual([])
  })

  it('result shape includes chat_id, chat_name, sender_name, text, timestamp', () => {
    const [r] = searchMessages('hello', 1)
    expect(r).toMatchObject({
      chat_id: 1,
      chat_name: 'Tony Lin',
      sender_name: 'Tony',
      text: 'hello world',
      timestamp: T + 1,
    })
  })
})

// ── getLastSyncedId ───────────────────────────────────────────────────────────

describe('getLastSyncedId', () => {
  beforeEach(() => {
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: null })
    upsertChat({ id: 2, name: 'Other', type: 'group', username: null })
  })

  it('returns null when the chat has no messages', () => {
    expect(getLastSyncedId(1)).toBeNull()
  })

  it('returns the telegram_id of the message with the highest timestamp', () => {
    insertMessage({
      telegram_id: '100', chat_id: 1, sender_id: '1', sender_name: 'Tony',
      text: 'earlier', type: 'text', timestamp: T + 1, is_sender: 0, reply_to_telegram_id: null,
    })
    insertMessage({
      telegram_id: '200', chat_id: 1, sender_id: '1', sender_name: 'Tony',
      text: 'later', type: 'text', timestamp: T + 2, is_sender: 0, reply_to_telegram_id: null,
    })
    expect(getLastSyncedId(1)).toBe('200')
  })

  it('ignores messages belonging to a different chatId', () => {
    insertMessage({
      telegram_id: '500', chat_id: 2, sender_id: '2', sender_name: 'Bob',
      text: 'other chat', type: 'text', timestamp: T + 99, is_sender: 0, reply_to_telegram_id: null,
    })
    expect(getLastSyncedId(1)).toBeNull()
  })
})
