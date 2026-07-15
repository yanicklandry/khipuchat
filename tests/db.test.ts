import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDb,
  upsertChat,
  insertMessage,
  getChats,
  getMessages,
  searchMessages,
  listArchiveMessages,
  getLastSyncedId,
  getPlatformLastSyncedAt,
  setPlatformLastSyncedAt,
  updateMessageMedia,
  getMessageIdByExternalId,
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

  it('chats table has a platform column', () => {
    const db = initDb(':memory:')
    const cols = (db.pragma('table_info(chats)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('platform')
  })

  it('messages table has a platform column', () => {
    const db = initDb(':memory:')
    const cols = (db.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('platform')
  })

  it('messages table has external_id column (not telegram_id)', () => {
    const db = initDb(':memory:')
    const cols = (db.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('external_id')
    expect(cols).not.toContain('telegram_id')
  })

  it('messages table has four media columns (task 1.1)', () => {
    const db = initDb(':memory:')
    const cols = (db.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('media_file_path')
    expect(cols).toContain('media_url')
    expect(cols).toContain('media_width')
    expect(cols).toContain('media_height')
  })
})

// ── upsertChat ────────────────────────────────────────────────────────────────

describe('upsertChat', () => {
  it('inserts a new chat and getChats returns it', () => {
    upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: 'tonylin1115', platform: 'telegram' })
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ name: 'Tony Lin', type: 'user', username: 'tonylin1115', platform: 'telegram' })
  })

  it('stores the platform value', () => {
    upsertChat({ external_id: '1', account: 'default', name: 'iMsg Chat', type: 'user', username: null, platform: 'imessage' })
    expect(getChats()[0].platform).toBe('imessage')
  })

  it('upserting the same identity overwrites name and username', () => {
    upsertChat({ external_id: '1', account: 'default', name: 'Tony', type: 'user', username: null, platform: 'telegram' })
    upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: 'tonylin1115', platform: 'telegram' })
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0].name).toBe('Tony Lin')
    expect(chats[0].username).toBe('tonylin1115')
  })

  it('two different chats coexist — getChats returns both', () => {
    upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: null, platform: 'telegram' })
    upsertChat({ external_id: '2', account: 'default', name: 'Work Group', type: 'group', username: null, platform: 'telegram' })
    expect(getChats()).toHaveLength(2)
  })

  it('returns a number (surrogate id) on insert', () => {
    const id = upsertChat({ external_id: 'ext-1', account: 'default', name: 'Alice', type: 'user', username: null, platform: 'telegram' })
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
  })

  it('is idempotent — same identity returns same surrogate id', () => {
    const id1 = upsertChat({ external_id: 'ext-1', account: 'default', name: 'Alice', type: 'user', username: null, platform: 'telegram' })
    const id2 = upsertChat({ external_id: 'ext-1', account: 'default', name: 'Alice Updated', type: 'user', username: null, platform: 'telegram' })
    expect(id1).toBe(id2)
  })

  it('two different accounts with same external_id on same platform get distinct surrogate ids', () => {
    const id1 = upsertChat({ external_id: 'ext-1', account: 'account-a', name: 'Chat A', type: 'user', username: null, platform: 'telegram' })
    const id2 = upsertChat({ external_id: 'ext-1', account: 'account-b', name: 'Chat B', type: 'user', username: null, platform: 'telegram' })
    expect(id1).not.toBe(id2)
  })
})

// ── insertMessage ─────────────────────────────────────────────────────────────

describe('insertMessage', () => {
  let chatId1: number
  let chatId2: number

  beforeEach(() => {
    chatId1 = upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: null, platform: 'telegram' })
    chatId2 = upsertChat({ external_id: '2', account: 'default', name: 'Other Chat', type: 'group', username: null, platform: 'telegram' })
  })

  it('inserts a message and getMessages returns it with correct fields', () => {
    insertMessage({
      external_id: '100',
      chat_id: chatId1,
      sender_id: '999',
      sender_name: 'Tony Lin',
      text: 'Hello!',
      type: 'text',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'telegram',
    })
    const msgs = getMessages(chatId1, 10)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      external_id: '100',
      chat_id: chatId1,
      sender_name: 'Tony Lin',
      text: 'Hello!',
      type: 'text',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'telegram',
    })
  })

  it('duplicate (external_id, chat_id) does not throw and is silently ignored', () => {
    const msg = {
      external_id: '100', chat_id: chatId1, sender_id: '999', sender_name: 'Tony Lin',
      text: 'Hello!', type: 'text' as const, timestamp: T + 1, is_sender: 0 as const,
      reply_to_external_id: null, platform: 'telegram' as const,
    }
    insertMessage(msg)
    expect(() => insertMessage(msg)).not.toThrow()
    expect(getMessages(chatId1, 10)).toHaveLength(1)
  })

  it('same external_id under a different chat_id is accepted as a distinct row', () => {
    insertMessage({
      external_id: '100', chat_id: chatId1, sender_id: '1', sender_name: 'Tony',
      text: 'Hi', type: 'text', timestamp: T + 1, is_sender: 0, reply_to_external_id: null, platform: 'telegram',
    })
    insertMessage({
      external_id: '100', chat_id: chatId2, sender_id: '2', sender_name: 'Bob',
      text: 'Hey', type: 'text', timestamp: T + 2, is_sender: 0, reply_to_external_id: null, platform: 'telegram',
    })
    expect(getMessages(chatId1, 10)).toHaveLength(1)
    expect(getMessages(chatId2, 10)).toHaveLength(1)
  })
})

// ── getMessages ───────────────────────────────────────────────────────────────

describe('getMessages', () => {
  let chatId1: number
  let chatId2: number

  beforeEach(() => {
    chatId1 = upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: null, platform: 'telegram' })
    chatId2 = upsertChat({ external_id: '2', account: 'default', name: 'Other', type: 'group', username: null, platform: 'telegram' })
    for (let i = 1; i <= 5; i++) {
      insertMessage({
        external_id: String(i), chat_id: chatId1, sender_id: '999', sender_name: 'Tony',
        text: `Message ${i}`, type: 'text', timestamp: T + i, is_sender: 0,
        reply_to_external_id: null, platform: 'telegram',
      })
    }
    insertMessage({
      external_id: '99', chat_id: chatId2, sender_id: '2', sender_name: 'Bob',
      text: 'Other chat msg', type: 'text', timestamp: T + 1, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
  })

  it('returns [] for an unknown chatId', () => {
    expect(getMessages(99, 10)).toEqual([])
  })

  it('returns messages ordered by timestamp ASC', () => {
    const msgs = getMessages(chatId1, 10)
    expect(msgs.map(m => m.external_id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('respects the limit parameter', () => {
    expect(getMessages(chatId1, 3)).toHaveLength(3)
  })

  it('beforeTimestamp returns only rows with timestamp < beforeTimestamp', () => {
    const msgs = getMessages(chatId1, 10, T + 3)
    expect(msgs.map(m => m.external_id)).toEqual(['1', '2'])
  })

  it('does not bleed messages from a different chatId', () => {
    const msgs = getMessages(chatId1, 10)
    expect(msgs.every(m => m.chat_id === chatId1)).toBe(true)
  })
})

// ── searchMessages ────────────────────────────────────────────────────────────

describe('searchMessages', () => {
  let chatId1: number
  let chatId2: number

  beforeEach(() => {
    chatId1 = upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: null, platform: 'telegram' })
    chatId2 = upsertChat({ external_id: '2', account: 'default', name: 'Other Chat', type: 'group', username: null, platform: 'imessage' })
    insertMessage({
      external_id: '1', chat_id: chatId1, sender_id: '1', sender_name: 'Tony',
      text: 'hello world', type: 'text', timestamp: T + 1, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    insertMessage({
      external_id: '2', chat_id: chatId2, sender_id: '2', sender_name: 'Bob',
      text: 'hello there', type: 'text', timestamp: T + 2, is_sender: 0,
      reply_to_external_id: null, platform: 'imessage',
    })
    insertMessage({
      external_id: '3', chat_id: chatId1, sender_id: '1', sender_name: 'Tony',
      text: 'goodbye', type: 'text', timestamp: T + 3, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
  })

  it('returns all matching rows across chats when chatId is omitted', () => {
    expect(searchMessages('hello')).toHaveLength(2)
  })

  it('filters to a single chat when chatId is provided', () => {
    const results = searchMessages('hello', { chatId: chatId1 })
    expect(results).toHaveLength(1)
    expect(results[0].chat_id).toBe(chatId1)
  })

  it('returns [] when query matches nothing', () => {
    expect(searchMessages('zzznomatch')).toEqual([])
  })

  it('result shape includes chat_id, chat_name, sender_name, text, timestamp, platform', () => {
    const [r] = searchMessages('hello', { chatId: chatId1 })
    expect(r).toMatchObject({
      chat_id: chatId1, chat_name: 'Tony Lin', sender_name: 'Tony',
      text: 'hello world', timestamp: T + 1, platform: 'telegram',
    })
  })

  it('result shape includes type field on every result row', () => {
    const results = searchMessages('hello')
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r).toHaveProperty('type')
    }
  })

  it('image message match reports type: image', () => {
    insertMessage({
      external_id: '50', chat_id: chatId1, sender_id: '1', sender_name: 'Tony',
      text: 'hello image caption', type: 'image', timestamp: T + 5, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    const results = searchMessages('hello image caption')
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('image')
  })

  it('platform filter returns only matching platform messages', () => {
    const results = searchMessages('hello', { platform: 'telegram' })
    expect(results).toHaveLength(1)
    expect(results[0].platform).toBe('telegram')
  })

  it('platform filter with chatId returns intersection', () => {
    const results = searchMessages('hello', { chatId: chatId2, platform: 'imessage' })
    expect(results).toHaveLength(1)
    expect(results[0].platform).toBe('imessage')
  })

  it('result shape includes account field derived from chats join', () => {
    const [r] = searchMessages('hello', { chatId: chatId1 })
    expect(r).toMatchObject({ account: 'default' })
  })

  it('account filter returns only messages from chats belonging to that account', () => {
    // chatId1 belongs to 'default', chatId2 belongs to 'default'
    // Add a second account's chat
    const chatIdWork = upsertChat({ external_id: '10', account: 'work', name: 'Work Chat', type: 'group', username: null, platform: 'telegram' })
    insertMessage({
      external_id: '10', chat_id: chatIdWork, sender_id: '5', sender_name: 'Boss',
      text: 'hello from work', type: 'text', timestamp: T + 10, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    const results = searchMessages('hello', { account: 'work' })
    expect(results).toHaveLength(1)
    expect(results[0].account).toBe('work')
    expect(results[0].chat_name).toBe('Work Chat')
  })

  it('account filter for personal returns only personal account messages', () => {
    const chatIdPersonal = upsertChat({ external_id: '20', account: 'personal', name: 'Personal Chat', type: 'user', username: null, platform: 'telegram' })
    insertMessage({
      external_id: '20', chat_id: chatIdPersonal, sender_id: '6', sender_name: 'Friend',
      text: 'hello personal', type: 'text', timestamp: T + 20, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    const workChatId = upsertChat({ external_id: '30', account: 'work', name: 'Work Chat 2', type: 'group', username: null, platform: 'telegram' })
    insertMessage({
      external_id: '30', chat_id: workChatId, sender_id: '7', sender_name: 'Colleague',
      text: 'hello work', type: 'text', timestamp: T + 30, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    const results = searchMessages('hello', { account: 'personal' })
    expect(results).toHaveLength(1)
    expect(results[0].account).toBe('personal')
  })

  it('omitting account returns messages from all accounts', () => {
    const chatIdWork = upsertChat({ external_id: '40', account: 'work', name: 'Work', type: 'group', username: null, platform: 'telegram' })
    insertMessage({
      external_id: '40', chat_id: chatIdWork, sender_id: '8', sender_name: 'Boss',
      text: 'hello all', type: 'text', timestamp: T + 40, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    // beforeEach already inserts 2 'hello' messages (chatId1 + chatId2) + now 1 more
    const results = searchMessages('hello')
    expect(results.length).toBeGreaterThanOrEqual(3)
  })

  it('since filter returns only messages at or after that timestamp', () => {
    // beforeEach: chatId1 has 'hello world' at T+1, chatId2 has 'hello there' at T+2
    const results = searchMessages('hello', { since: T + 2 })
    expect(results).toHaveLength(1)
    expect(results[0].timestamp).toBe(T + 2)
  })

  it('until filter returns only messages at or before that timestamp', () => {
    const results = searchMessages('hello', { until: T + 1 })
    expect(results).toHaveLength(1)
    expect(results[0].timestamp).toBe(T + 1)
  })

  it('since and until together constrain the timestamp range', () => {
    // Insert extra message at T+10
    insertMessage({
      external_id: '10', chat_id: chatId1, sender_id: '1', sender_name: 'Tony',
      text: 'hello late', type: 'text', timestamp: T + 10, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    const results = searchMessages('hello', { since: T + 2, until: T + 5 })
    // only T+2 falls in [T+2, T+5]
    expect(results).toHaveLength(1)
    expect(results[0].timestamp).toBe(T + 2)
  })

  it('type filter returns only messages of the given type', () => {
    // beforeEach inserts text messages; insert an image message with matching text
    insertMessage({
      external_id: '99', chat_id: chatId1, sender_id: '1', sender_name: 'Tony',
      text: 'hello image', type: 'image', timestamp: T + 5, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    const results = searchMessages('hello', { type: 'image' })
    expect(results).toHaveLength(1)
    expect(results[0].text).toBe('hello image')
  })

  it('limit filter caps result count', () => {
    const results = searchMessages('hello', { limit: 1 })
    expect(results).toHaveLength(1)
  })
})

// ── listArchiveMessages ───────────────────────────────────────────────────────

describe('listArchiveMessages', () => {
  let chatId1: number
  let chatId2: number

  beforeEach(() => {
    chatId1 = upsertChat({ external_id: '1', account: 'default', name: 'Chat 1', type: 'user', username: null, platform: 'telegram' })
    chatId2 = upsertChat({ external_id: '2', account: 'work', name: 'Chat 2', type: 'group', username: null, platform: 'imessage' })
    // Insert text messages
    for (let i = 1; i <= 3; i++) {
      insertMessage({
        external_id: `t${i}`, chat_id: chatId1, sender_id: '1', sender_name: 'Alice',
        text: `text msg ${i}`, type: 'text', timestamp: T + i, is_sender: 0,
        reply_to_external_id: null, platform: 'telegram',
      })
    }
    // Insert an image message
    insertMessage({
      external_id: 'img1', chat_id: chatId1, sender_id: '1', sender_name: 'Alice',
      text: null, type: 'image', timestamp: T + 10, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    // Insert a text message in chat2
    insertMessage({
      external_id: 'c2t1', chat_id: chatId2, sender_id: '2', sender_name: 'Bob',
      text: 'work text', type: 'text', timestamp: T + 5, is_sender: 0,
      reply_to_external_id: null, platform: 'imessage',
    })
  })

  it('returns only text messages by default (type defaults to text)', () => {
    const { messages } = listArchiveMessages()
    expect(messages.every(m => m.type === 'text')).toBe(true)
  })

  it('returns messages across all chats when no filters', () => {
    const { messages } = listArchiveMessages()
    // 3 text in chatId1 + 1 text in chatId2 = 4
    expect(messages).toHaveLength(4)
  })

  it('returns messages ordered by timestamp DESC', () => {
    const { messages } = listArchiveMessages()
    const timestamps = messages.map(m => m.timestamp)
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a))
  })

  it('result includes account field from chats join', () => {
    const { messages } = listArchiveMessages({ account: 'work' })
    expect(messages).toHaveLength(1)
    expect(messages[0].account).toBe('work')
  })

  it('platform filter limits to given platform', () => {
    const { messages } = listArchiveMessages({ platform: 'imessage' })
    expect(messages).toHaveLength(1)
    expect(messages[0].platform).toBe('imessage')
  })

  it('since filter returns only messages at or after timestamp', () => {
    const { messages } = listArchiveMessages({ since: T + 3 })
    // T+3, T+5 are text; image at T+10 is excluded by default type=text
    expect(messages.every(m => m.timestamp >= T + 3)).toBe(true)
  })

  it('until filter returns only messages at or before timestamp', () => {
    const { messages } = listArchiveMessages({ until: T + 2 })
    expect(messages.every(m => m.timestamp <= T + 2)).toBe(true)
  })

  it('type override to image returns image messages', () => {
    const { messages } = listArchiveMessages({ type: 'image' })
    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe('image')
  })

  it('limit caps returned messages and has_more is true when more exist', () => {
    const { messages, has_more } = listArchiveMessages({ limit: 2 })
    expect(messages).toHaveLength(2)
    expect(has_more).toBe(true)
  })

  it('has_more is false when total results fit within limit', () => {
    const { messages, has_more } = listArchiveMessages({ limit: 10 })
    expect(messages).toHaveLength(4)
    expect(has_more).toBe(false)
  })

  it('result rows include id, chat_id, sender_name, text, type, timestamp, is_sender, platform, account', () => {
    const { messages } = listArchiveMessages({ account: 'default', limit: 1 })
    expect(messages[0]).toMatchObject({
      chat_id: chatId1,
      sender_name: 'Alice',
      type: 'text',
      platform: 'telegram',
      account: 'default',
    })
    expect(typeof messages[0].id).toBe('number')
    expect(typeof messages[0].timestamp).toBe('number')
  })
})

// ── getLastSyncedId ───────────────────────────────────────────────────────────

describe('getLastSyncedId', () => {
  let chatId1: number
  let chatId2: number

  beforeEach(() => {
    chatId1 = upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: null, platform: 'telegram' })
    chatId2 = upsertChat({ external_id: '2', account: 'default', name: 'Other', type: 'group', username: null, platform: 'telegram' })
  })

  it('returns null when the chat has no messages', () => {
    expect(getLastSyncedId(chatId1)).toBeNull()
  })

  it('returns the external_id of the message with the highest timestamp', () => {
    insertMessage({
      external_id: '100', chat_id: chatId1, sender_id: '1', sender_name: 'Tony',
      text: 'earlier', type: 'text', timestamp: T + 1, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    insertMessage({
      external_id: '200', chat_id: chatId1, sender_id: '1', sender_name: 'Tony',
      text: 'later', type: 'text', timestamp: T + 2, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    expect(getLastSyncedId(chatId1)).toBe('200')
  })

  it('ignores messages belonging to a different chatId', () => {
    insertMessage({
      external_id: '500', chat_id: chatId2, sender_id: '2', sender_name: 'Bob',
      text: 'other chat', type: 'text', timestamp: T + 99, is_sender: 0,
      reply_to_external_id: null, platform: 'telegram',
    })
    expect(getLastSyncedId(chatId1)).toBeNull()
  })
})

// ── insertMessage media fields (task 1.2) ─────────────────────────────────────

describe('insertMessage — media fields', () => {
  let chatId: number

  beforeEach(() => {
    chatId = upsertChat({ external_id: '1', account: 'default', name: 'Signal User', type: 'user', username: null, platform: 'signal' })
  })

  it('persists all four media fields when provided', () => {
    insertMessage({
      external_id: 'img-1',
      chat_id: chatId,
      sender_id: 'user1',
      sender_name: 'Alice',
      text: null,
      type: 'image',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'signal',
      media_file_path: '/tmp/img.jpg',
      media_url: 'https://cdn.example.com/img.jpg',
      media_width: 1920,
      media_height: 1080,
    })
    const msgs = getMessages(chatId, 10)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      media_file_path: '/tmp/img.jpg',
      media_url: 'https://cdn.example.com/img.jpg',
      media_width: 1920,
      media_height: 1080,
    })
  })

  it('does not throw when a non-image Message has no media keys set', () => {
    const msg = {
      external_id: 'txt-1',
      chat_id: chatId,
      sender_id: 'user1',
      sender_name: 'Alice',
      text: 'Hello',
      type: 'text' as const,
      timestamp: T + 1,
      is_sender: 0 as const,
      reply_to_external_id: null,
      platform: 'telegram' as const,
    }
    expect(() => insertMessage(msg)).not.toThrow()
    const msgs = getMessages(chatId, 10)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].media_file_path).toBeNull()
    expect(msgs[0].media_url).toBeNull()
    expect(msgs[0].media_width).toBeNull()
    expect(msgs[0].media_height).toBeNull()
  })
})

// ── sync_state ────────────────────────────────────────────────────────────────

describe('sync_state', () => {
  it('initDb creates the sync_state table', () => {
    const tables = initDb(':memory:')
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .pluck()
      .all() as string[]
    expect(tables).toContain('sync_state')
  })

  it('getPlatformLastSyncedAt returns null for first-time account (no row present)', () => {
    expect(getPlatformLastSyncedAt('slack', 'work')).toBeNull()
  })

  it('getPlatformLastSyncedAt returns stored value after setPlatformLastSyncedAt', () => {
    setPlatformLastSyncedAt('slack', 'work', 1000)
    expect(getPlatformLastSyncedAt('slack', 'work')).toBe(1000)
  })

  it('setPlatformLastSyncedAt overwrites on second call (upsert semantics)', () => {
    setPlatformLastSyncedAt('slack', 'work', 1000)
    setPlatformLastSyncedAt('slack', 'work', 2000)
    expect(getPlatformLastSyncedAt('slack', 'work')).toBe(2000)
  })

  it('different accounts are independent — setting work does not affect personal', () => {
    setPlatformLastSyncedAt('slack', 'work', 1000)
    expect(getPlatformLastSyncedAt('slack', 'personal')).toBeNull()
  })

  it('different platforms are independent', () => {
    setPlatformLastSyncedAt('telegram', 'default', 1000)
    expect(getPlatformLastSyncedAt('slack', 'default')).toBeNull()
  })
})

// ── ocr_text schema (task 1.2) ────────────────────────────────────────────────

describe('schema — ocr_text column (task 1.2)', () => {
  it('messages table has an ocr_text column', () => {
    const database = initDb(':memory:')
    const cols = (database.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('ocr_text')
  })

  it('messages_fts FTS table includes ocr_text column', () => {
    const database = initDb(':memory:')
    const cols = (database.pragma('table_info(messages_fts)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('ocr_text')
  })
})

// ── updateMessageMedia (task 1.2) ─────────────────────────────────────────────

describe('updateMessageMedia', () => {
  let chatId: number
  let msgId: number

  beforeEach(() => {
    chatId = upsertChat({ external_id: 'c1', account: 'default', name: 'Test Chat', type: 'user', username: null, platform: 'telegram' })
    insertMessage({
      external_id: 'ext-1',
      chat_id: chatId,
      sender_id: 'u1',
      sender_name: 'Alice',
      text: 'original text',
      type: 'image',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'telegram',
    })
    const row = getMessageIdByExternalId(chatId, 'ext-1')
    msgId = row!
  })

  it('sets ocr_text without touching text', () => {
    updateMessageMedia(msgId, { ocr_text: 'extracted text' })
    const msgs = getMessages(chatId, 10)
    expect(msgs[0].text).toBe('original text')
    expect(msgs[0].ocr_text).toBe('extracted text')
  })

  it('sets media_file_path without touching other fields', () => {
    updateMessageMedia(msgId, { media_file_path: '/tmp/photo.jpg' })
    const msgs = getMessages(chatId, 10)
    expect(msgs[0].media_file_path).toBe('/tmp/photo.jpg')
    expect(msgs[0].text).toBe('original text')
    expect(msgs[0].ocr_text).toBeNull()
  })

  it('sets multiple media fields at once', () => {
    updateMessageMedia(msgId, { media_width: 1920, media_height: 1080, ocr_text: 'hello' })
    const msgs = getMessages(chatId, 10)
    expect(msgs[0].media_width).toBe(1920)
    expect(msgs[0].media_height).toBe(1080)
    expect(msgs[0].ocr_text).toBe('hello')
    expect(msgs[0].text).toBe('original text')
  })

  it('calling with empty object does not throw and leaves row unchanged', () => {
    expect(() => updateMessageMedia(msgId, {})).not.toThrow()
    const msgs = getMessages(chatId, 10)
    expect(msgs[0].text).toBe('original text')
  })

  it('subsequent call with only ocr_text does not reset media_file_path', () => {
    updateMessageMedia(msgId, { media_file_path: '/tmp/img.jpg' })
    updateMessageMedia(msgId, { ocr_text: 'found text' })
    const msgs = getMessages(chatId, 10)
    expect(msgs[0].media_file_path).toBe('/tmp/img.jpg')
    expect(msgs[0].ocr_text).toBe('found text')
  })
})

// ── searchMessages via ocr_text (FTS guard integration) ──────────────────────

describe('searchMessages — finds image messages by ocr_text', () => {
  let chatId: number
  let msgId: number

  beforeEach(() => {
    chatId = upsertChat({ external_id: 'c1', account: 'default', name: 'OCR Chat', type: 'user', username: null, platform: 'telegram' })
    insertMessage({
      external_id: 'img-ocr-1',
      chat_id: chatId,
      sender_id: 'u1',
      sender_name: 'Alice',
      text: null,
      type: 'image',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'telegram',
    })
    const id = getMessageIdByExternalId(chatId, 'img-ocr-1')
    msgId = id!
  })

  it('returns image message when searched by its ocr_text term', () => {
    updateMessageMedia(msgId, { ocr_text: 'uniqueocrterm' })
    const results = searchMessages('uniqueocrterm')
    expect(results).toHaveLength(1)
    expect(results[0].chat_id).toBe(chatId)
  })

  it('does not return image message before ocr_text is set', () => {
    const results = searchMessages('uniqueocrterm')
    expect(results).toHaveLength(0)
  })

  it('image message matched via ocr_text returns type: image (Req 4.1, 4.3)', () => {
    updateMessageMedia(msgId, { ocr_text: 'uniqueocrterm' })
    const results = searchMessages('uniqueocrterm')
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('image')
  })
})

// ── getMessageIdByExternalId (task 1.2) ───────────────────────────────────────

describe('getMessageIdByExternalId', () => {
  let chatId: number

  beforeEach(() => {
    chatId = upsertChat({ external_id: 'c1', account: 'default', name: 'Test Chat', type: 'user', username: null, platform: 'telegram' })
    insertMessage({
      external_id: 'ext-100',
      chat_id: chatId,
      sender_id: 'u1',
      sender_name: 'Alice',
      text: 'hello',
      type: 'text',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'telegram',
    })
  })

  it('returns a number id for an existing (chat_id, external_id) pair', () => {
    const id = getMessageIdByExternalId(chatId, 'ext-100')
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
  })

  it('returns null for an unknown external_id', () => {
    expect(getMessageIdByExternalId(chatId, 'no-such-id')).toBeNull()
  })

  it('returns null for an unknown chat_id', () => {
    expect(getMessageIdByExternalId(9999, 'ext-100')).toBeNull()
  })

  it('same external_id under different chat_ids returns distinct ids', () => {
    const chatId2 = upsertChat({ external_id: 'c2', account: 'default', name: 'Chat 2', type: 'user', username: null, platform: 'telegram' })
    insertMessage({
      external_id: 'ext-100',
      chat_id: chatId2,
      sender_id: 'u2',
      sender_name: 'Bob',
      text: 'world',
      type: 'text',
      timestamp: T + 2,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'telegram',
    })
    const id1 = getMessageIdByExternalId(chatId, 'ext-100')
    const id2 = getMessageIdByExternalId(chatId2, 'ext-100')
    expect(id1).not.toBeNull()
    expect(id2).not.toBeNull()
    expect(id1).not.toBe(id2)
  })
})
