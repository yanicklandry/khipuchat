import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import {
  handleSearchMessages,
  handleListChats,
  handleListMessages,
  handleListArchiveMessages,
  type QueryFilters,
} from '../src/query-handlers'
import { parseQueryFilters, parseDateArg } from '../src/cli-filters'

// ── Test timestamps ───────────────────────────────────────────────────────────
// T_2024 = 2024-01-01 00:00:00 UTC
const T_2024 = 1704067200
// T_2025 = 2025-01-01 00:00:00 UTC
const T_2025 = 1735689600
// T_MID = 2024-07-01 00:00:00 UTC (between the two)
const T_MID = 1719792000

// ── Seed IDs (populated by seed()) ───────────────────────────────────────────
let ids: { tg1: number; tg2: number; imsg: number }

function seed(): void {
  // 3 chats: telegram/default, imessage/default, telegram/account2
  const tg1 = upsertChat({
    external_id: 'tg1',
    account: 'default',
    name: 'TelegramChat1',
    type: 'user',
    username: null,
    platform: 'telegram',
  })
  const imsg = upsertChat({
    external_id: 'imsg1',
    account: 'default',
    name: 'iMessageChat',
    type: 'user',
    username: null,
    platform: 'imessage',
  })
  const tg2 = upsertChat({
    external_id: 'tg2',
    account: 'account2',
    name: 'TelegramChat2',
    type: 'user',
    username: null,
    platform: 'telegram',
  })
  ids = { tg1, tg2, imsg }

  // Telegram chat 1: 5 text messages at varying timestamps, 2 image messages
  insertMessage({ external_id: 'tg1-t1', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello early 2024', type: 'text', timestamp: T_2024 + 100, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg1-t2', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello mid 2024', type: 'text', timestamp: T_MID, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg1-t3', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello early 2025', type: 'text', timestamp: T_2025 + 100, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg1-t4', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello later 2025', type: 'text', timestamp: T_2025 + 200, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg1-t5', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello june 2025', type: 'text', timestamp: T_2025 + 300, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg1-i1', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello image one', type: 'image', timestamp: T_MID + 1, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg1-i2', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello image two', type: 'image', timestamp: T_MID + 2, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })

  // iMessage chat: 3 text messages
  insertMessage({ external_id: 'im1-t1', chat_id: imsg, sender_id: '2', sender_name: 'Bob', text: 'hello from imessage one', type: 'text', timestamp: T_2024 + 50, is_sender: 0, reply_to_external_id: null, platform: 'imessage' })
  insertMessage({ external_id: 'im1-t2', chat_id: imsg, sender_id: '2', sender_name: 'Bob', text: 'hello from imessage two', type: 'text', timestamp: T_MID + 50, is_sender: 0, reply_to_external_id: null, platform: 'imessage' })
  insertMessage({ external_id: 'im1-t3', chat_id: imsg, sender_id: '2', sender_name: 'Bob', text: 'hello from imessage three', type: 'text', timestamp: T_2025 + 50, is_sender: 0, reply_to_external_id: null, platform: 'imessage' })

  // Telegram chat 2 (account2): 2 text messages
  insertMessage({ external_id: 'tg2-t1', chat_id: tg2, sender_id: '3', sender_name: 'Carol', text: 'hello from account2 one', type: 'text', timestamp: T_2024 + 200, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg2-t2', chat_id: tg2, sender_id: '3', sender_name: 'Carol', text: 'hello from account2 two', type: 'text', timestamp: T_2025 + 400, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
}

beforeEach(() => {
  initDb(':memory:')
  seed()
  rebuildFtsIndex()
})

// ── Search parity: parseQueryFilters vs direct QueryFilters ───────────────────

describe('handleSearchMessages CLI/MCP parity', () => {
  it('platform + limit: parseQueryFilters produces same results as direct QueryFilters', () => {
    const parsed = parseQueryFilters(['--platform', 'telegram', '--limit', '3'])
    if (!parsed.ok) throw new Error(parsed.error)
    const cliFilters = parsed.filters

    const directFilters: QueryFilters = { platform: 'telegram', limit: 3 }

    const cliResults = handleSearchMessages('hello', cliFilters)
    const directResults = handleSearchMessages('hello', directFilters)

    expect(cliResults).toEqual(directResults)
    expect(cliResults.length).toBeLessThanOrEqual(3)
  })

  it('since date: parseDateArg produces the same unix timestamp as MCP numeric path', () => {
    // parseDateArg('2025-01-01') must equal T_2025
    const parsedTs = parseDateArg('2025-01-01')
    expect(parsedTs).toBe(T_2025)

    const cliParsed = parseQueryFilters(['--since', '2025-01-01'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { since: T_2025 }

    const cliResults = handleSearchMessages('hello', cliParsed.filters)
    const directResults = handleSearchMessages('hello', directFilters)

    expect(cliResults).toEqual(directResults)
  })

  it('until date: CLI path and direct numeric path produce identical results', () => {
    const cliParsed = parseQueryFilters(['--until', '2025-01-01'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { until: T_2025 }

    const cliResults = handleSearchMessages('hello', cliParsed.filters)
    const directResults = handleSearchMessages('hello', directFilters)

    expect(cliResults).toEqual(directResults)
  })

  it('type filter: CLI --type and direct type field produce identical results', () => {
    const cliParsed = parseQueryFilters(['--type', 'image'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { type: 'image' }

    const cliResults = handleSearchMessages('hello', cliParsed.filters)
    const directResults = handleSearchMessages('hello', directFilters)

    expect(cliResults).toEqual(directResults)
  })
})

// ── Filters measurably narrow results ─────────────────────────────────────────

describe('filters narrow search results', () => {
  it('--type image returns fewer results than unfiltered', () => {
    const all = handleSearchMessages('hello')
    const images = handleSearchMessages('hello', { type: 'image' })
    expect(images.length).toBeGreaterThan(0)
    expect(images.length).toBeLessThan(all.length)
    expect(images.every(r => r.text !== null)).toBe(true)
  })

  it('--since T_2025 returns fewer results than unfiltered', () => {
    const all = handleSearchMessages('hello')
    const filtered = handleSearchMessages('hello', { since: T_2025 })
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.length).toBeLessThan(all.length)
    expect(filtered.every(r => r.timestamp >= T_2025)).toBe(true)
  })

  it('--until T_MID returns fewer results than unfiltered', () => {
    const all = handleSearchMessages('hello')
    const filtered = handleSearchMessages('hello', { until: T_MID })
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.length).toBeLessThan(all.length)
    expect(filtered.every(r => r.timestamp <= T_MID)).toBe(true)
  })

  it('--limit 2 caps search results to 2', () => {
    const { messages } = handleListArchiveMessages({ limit: 2 })
    expect(messages.length).toBeLessThanOrEqual(2)
  })

  it('list messages with --limit 2 caps results', () => {
    const all = handleSearchMessages('hello')
    const limited = handleSearchMessages('hello', { limit: 2 })
    expect(limited.length).toBe(2)
    expect(all.length).toBeGreaterThan(2)
  })
})

// ── handleListMessages per-chat vs archive-wide ───────────────────────────────

describe('handleListMessages per-chat vs archive-wide', () => {
  it('with chat_id: returns only messages from that chat', () => {
    const { messages } = handleListMessages(ids.tg1)
    // All messages in tg1 are from the telegram platform with chat id tg1
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every(m => m.platform === 'telegram')).toBe(true)
    // iMessage messages should NOT appear
    expect(messages.some(m => m.sender_name === 'Bob')).toBe(false)
  })

  it('handleListArchiveMessages without chat_id lists messages archive-wide', () => {
    const { messages } = handleListArchiveMessages()
    // Should include messages from multiple platforms
    const platforms = new Set(messages.map(m => m.platform))
    expect(platforms.size).toBeGreaterThan(1)
    expect(platforms.has('telegram')).toBe(true)
    expect(platforms.has('imessage')).toBe(true)
  })

  it('per-chat list returns a strict subset of the archive-wide list', () => {
    const { messages: archiveAll } = handleListArchiveMessages()
    const { messages: chatMsgs } = handleListMessages(ids.tg1)
    expect(chatMsgs.length).toBeGreaterThan(0)
    expect(chatMsgs.length).toBeLessThan(archiveAll.length)
  })
})

// ── handleListChats parity ────────────────────────────────────────────────────

describe('handleListChats CLI/MCP parity', () => {
  it('platform filter: parseQueryFilters produces same chats as direct QueryFilters', () => {
    const cliParsed = parseQueryFilters(['--platform', 'telegram'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { platform: 'telegram' }

    const cliResults = handleListChats(cliParsed.filters)
    const directResults = handleListChats(directFilters)

    expect(cliResults).toEqual(directResults)
    expect(cliResults.every(r => r.platform === 'telegram')).toBe(true)
    expect(cliResults.some(r => r.name === 'iMessageChat')).toBe(false)
  })

  it('platform filter narrows results: telegram only vs all platforms', () => {
    const all = handleListChats()
    const telegramOnly = handleListChats({ platform: 'telegram' })
    expect(telegramOnly.length).toBeGreaterThan(0)
    expect(telegramOnly.length).toBeLessThan(all.length)
  })

  it('account filter: CLI --account and direct account field produce identical results', () => {
    const cliParsed = parseQueryFilters(['--account', 'account2'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { account: 'account2' }

    const cliResults = handleListChats(cliParsed.filters)
    const directResults = handleListChats(directFilters)

    expect(cliResults).toEqual(directResults)
    expect(cliResults.every(r => r.account === 'account2')).toBe(true)
  })

  it('limit: CLI --limit and direct limit field produce identical results', () => {
    const cliParsed = parseQueryFilters(['--limit', '1'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { limit: 1 }

    const cliResults = handleListChats(cliParsed.filters)
    const directResults = handleListChats(directFilters)

    expect(cliResults).toEqual(directResults)
    expect(cliResults.length).toBe(1)
  })
})

// ── handleListArchiveMessages parity ─────────────────────────────────────────

describe('handleListArchiveMessages CLI/MCP parity', () => {
  it('platform filter: CLI path and direct QueryFilters produce same messages', () => {
    const cliParsed = parseQueryFilters(['--platform', 'telegram'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { platform: 'telegram' }

    const { messages: cliMsgs } = handleListArchiveMessages(cliParsed.filters)
    const { messages: directMsgs } = handleListArchiveMessages(directFilters)

    expect(cliMsgs).toEqual(directMsgs)
    expect(cliMsgs.every(m => m.platform === 'telegram')).toBe(true)
  })

  it('since filter: CLI --since and direct since field produce identical results', () => {
    const cliParsed = parseQueryFilters(['--since', '2025-01-01'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { since: T_2025 }

    const { messages: cliMsgs } = handleListArchiveMessages(cliParsed.filters)
    const { messages: directMsgs } = handleListArchiveMessages(directFilters)

    expect(cliMsgs).toEqual(directMsgs)
    expect(cliMsgs.every(m => m.timestamp >= T_2025)).toBe(true)
  })

  it('limit: CLI --limit and direct limit field produce identical results', () => {
    const cliParsed = parseQueryFilters(['--limit', '2'])
    if (!cliParsed.ok) throw new Error(cliParsed.error)

    const directFilters: QueryFilters = { limit: 2 }

    const { messages: cliMsgs, has_more: cliHasMore } = handleListArchiveMessages(cliParsed.filters)
    const { messages: directMsgs, has_more: directHasMore } = handleListArchiveMessages(directFilters)

    expect(cliMsgs).toEqual(directMsgs)
    expect(cliHasMore).toBe(directHasMore)
    expect(cliMsgs.length).toBeLessThanOrEqual(2)
  })

  it('platform filter narrows results: fewer messages than archive-wide', () => {
    const { messages: all } = handleListArchiveMessages()
    const { messages: filtered } = handleListArchiveMessages({ platform: 'imessage' })
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.length).toBeLessThan(all.length)
    expect(filtered.every(m => m.platform === 'imessage')).toBe(true)
  })
})
