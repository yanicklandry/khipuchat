import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import {
  handleListChats,
  handleFindChatByName,
  handleListMessages,
  handleSearchMessages,
  listArchiveAccounts,
} from '../src/query-handlers'

const T = 1700000000

function seedMsg(
  externalId: string,
  chatId: number,
  text: string,
  offset: number,
  platform: 'telegram' | 'imessage' = 'telegram',
) {
  insertMessage({
    external_id: externalId,
    chat_id: chatId,
    sender_id: '1',
    sender_name: 'Alice',
    text,
    type: 'text',
    timestamp: T + offset,
    is_sender: 0,
    reply_to_external_id: null,
    platform,
  })
}

let ids: { personal: number; work: number; imsg: number }

function seed() {
  const personal = upsertChat({ external_id: '1', account: 'personal', name: 'Alice', type: 'user', username: null, platform: 'telegram' })
  const work = upsertChat({ external_id: '2', account: 'work', name: 'Bob', type: 'user', username: null, platform: 'telegram' })
  const imsg = upsertChat({ external_id: '3', account: 'work', name: 'Carol', type: 'user', username: null, platform: 'imessage' })
  ids = { personal, work, imsg }

  seedMsg('1', personal, 'hello from personal', 1)
  seedMsg('2', work, 'hello from work', 2)
  seedMsg('3', imsg, 'hello from imsg', 3, 'imessage')
}

beforeEach(() => {
  initDb(':memory:')
  seed()
  rebuildFtsIndex()
})

// ── handleListChats — account field ──────────────────────────────────────────

describe('handleListChats account filter', () => {
  it('each result contains an account field', () => {
    const results = handleListChats()
    expect(results.length).toBeGreaterThanOrEqual(3)
    for (const r of results) {
      expect(typeof r.account).toBe('string')
    }
  })

  it('account field reflects the actual chat account', () => {
    const results = handleListChats()
    const alice = results.find(r => r.name === 'Alice')
    const bob = results.find(r => r.name === 'Bob')
    expect(alice?.account).toBe('personal')
    expect(bob?.account).toBe('work')
  })

  it('filtering by account=personal returns only personal chats', () => {
    const results = handleListChats(undefined, 'personal')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.every(r => r.account === 'personal')).toBe(true)
    expect(results.some(r => r.name === 'Alice')).toBe(true)
    expect(results.some(r => r.name === 'Bob')).toBe(false)
  })

  it('filtering by account=work returns only work chats', () => {
    const results = handleListChats(undefined, 'work')
    expect(results.every(r => r.account === 'work')).toBe(true)
    expect(results.some(r => r.name === 'Bob')).toBe(true)
    expect(results.some(r => r.name === 'Alice')).toBe(false)
  })

  it('omitting account returns chats from all accounts', () => {
    const results = handleListChats()
    const accounts = new Set(results.map(r => r.account))
    expect(accounts.has('personal')).toBe(true)
    expect(accounts.has('work')).toBe(true)
  })
})

// ── handleFindChatByName — account field ─────────────────────────────────────

describe('handleFindChatByName account filter', () => {
  it('each result contains an account field', () => {
    const results = handleFindChatByName('')
    for (const r of results) {
      expect(typeof r.account).toBe('string')
    }
  })

  it('filtering by account returns only matching chats', () => {
    const results = handleFindChatByName('', undefined, 'personal')
    expect(results.every(r => r.account === 'personal')).toBe(true)
  })

  it('omitting account returns chats from all accounts', () => {
    const results = handleFindChatByName('')
    const accounts = new Set(results.map(r => r.account))
    expect(accounts.has('personal')).toBe(true)
    expect(accounts.has('work')).toBe(true)
  })
})

// ── handleListMessages — account field ───────────────────────────────────────

describe('handleListMessages account field', () => {
  it('each message result contains an account field', () => {
    const { messages } = handleListMessages(ids.personal)
    expect(messages.length).toBeGreaterThanOrEqual(1)
    for (const m of messages) {
      expect(typeof m.account).toBe('string')
    }
  })

  it('account field reflects the chat account', () => {
    const { messages: personalMsgs } = handleListMessages(ids.personal)
    expect(personalMsgs[0].account).toBe('personal')

    const { messages: workMsgs } = handleListMessages(ids.work)
    expect(workMsgs[0].account).toBe('work')
  })
})

// ── handleSearchMessages — account filter ─────────────────────────────────────

describe('handleSearchMessages account filter', () => {
  it('returns results from all accounts when account omitted', () => {
    const results = handleSearchMessages('hello')
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('filtering by account=personal returns only personal results', () => {
    const results = handleSearchMessages('hello', undefined, undefined, 'personal')
    expect(results.every(r => r.account === 'personal')).toBe(true)
    expect(results.some(r => r.chat_name === 'Alice')).toBe(true)
    expect(results.some(r => r.chat_name === 'Bob')).toBe(false)
  })

  it('filtering by account=work returns only work results', () => {
    const results = handleSearchMessages('hello', undefined, undefined, 'work')
    expect(results.every(r => r.account === 'work')).toBe(true)
    expect(results.some(r => r.chat_name === 'Bob')).toBe(true)
    expect(results.some(r => r.chat_name === 'Alice')).toBe(false)
  })
})

// ── listArchiveAccounts ───────────────────────────────────────────────────────

describe('listArchiveAccounts', () => {
  it('returns empty array when DB has no chats', () => {
    initDb(':memory:')
    // fresh DB with no seed — no chats
    const results = listArchiveAccounts()
    expect(results).toEqual([])
  })

  it('returns one entry per platform when single account per platform (account = default)', () => {
    initDb(':memory:')
    upsertChat({ external_id: '1', account: 'default', name: 'Alice', type: 'user', username: null, platform: 'telegram' })
    upsertChat({ external_id: '2', account: 'default', name: 'Bob', type: 'user', username: null, platform: 'telegram' })
    const results = listArchiveAccounts()
    expect(results).toEqual([{ platform: 'telegram', account: 'default' }])
  })

  it('returns one entry per (platform, account) pair sorted by platform then account', () => {
    // beforeEach seed has: telegram/personal, telegram/work, imessage/work
    const results = listArchiveAccounts()
    expect(results).toEqual([
      { platform: 'imessage', account: 'work' },
      { platform: 'telegram', account: 'personal' },
      { platform: 'telegram', account: 'work' },
    ])
  })

  it('deduplicates: multiple chats under same platform+account count as one entry', () => {
    initDb(':memory:')
    upsertChat({ external_id: '1', account: 'alice', name: 'Chat1', type: 'user', username: null, platform: 'telegram' })
    upsertChat({ external_id: '2', account: 'alice', name: 'Chat2', type: 'user', username: null, platform: 'telegram' })
    upsertChat({ external_id: '3', account: 'bob', name: 'Chat3', type: 'user', username: null, platform: 'telegram' })
    const results = listArchiveAccounts()
    expect(results).toEqual([
      { platform: 'telegram', account: 'alice' },
      { platform: 'telegram', account: 'bob' },
    ])
  })
})
