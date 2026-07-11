/**
 * Tests for CLI --account flag parsing and multi-account output formatting.
 * Covers requirement 5.1: account filter on CLI list and search.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import {
  parseAccountArg,
  formatPlatformLabel,
} from '../src/cli'
import {
  handleListChats,
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

let ids: { personal: number; work: number }

function seed() {
  const personal = upsertChat({ external_id: '1', account: 'personal', name: 'Alice', type: 'user', username: null, platform: 'telegram' })
  const work = upsertChat({ external_id: '2', account: 'work', name: 'Bob', type: 'user', username: null, platform: 'telegram' })
  ids = { personal, work }

  seedMsg('1', personal, 'hello from personal', 1)
  seedMsg('2', work, 'hello from work', 2)
}

beforeEach(() => {
  initDb(':memory:')
  seed()
  rebuildFtsIndex()
})

// ── parseAccountArg ───────────────────────────────────────────────────────────

describe('parseAccountArg', () => {
  it('returns undefined when --account is absent', () => {
    const { account, rest } = parseAccountArg(['list-chats'])
    expect(account).toBeUndefined()
    expect(rest).toEqual(['list-chats'])
  })

  it('parses --account <name> and removes both tokens from rest', () => {
    const { account, rest } = parseAccountArg(['--account', 'work', 'list-chats'])
    expect(account).toBe('work')
    expect(rest).toEqual(['list-chats'])
  })

  it('parses --account at end of args without a value', () => {
    const { account, rest } = parseAccountArg(['list-chats', '--account'])
    expect(account).toBeUndefined()
    expect(rest).toEqual(['list-chats'])
  })

  it('parses --account that appears after other args', () => {
    const { account, rest } = parseAccountArg(['search', 'query text', '--account', 'personal'])
    expect(account).toBe('personal')
    expect(rest).toEqual(['search', 'query text'])
  })

  it('works alongside --min-similarity being separately parsed', () => {
    // Simulate the rest array that remains after --min-similarity is already stripped
    const { account, rest } = parseAccountArg(['search', 'query', '--account', 'work'])
    expect(account).toBe('work')
    expect(rest).toEqual(['search', 'query'])
  })
})

// ── formatPlatformLabel ───────────────────────────────────────────────────────

describe('formatPlatformLabel', () => {
  it('returns just the platform when isMultiAccount is false', () => {
    expect(formatPlatformLabel('telegram', 'work', false)).toBe('telegram')
  })

  it('returns "platform/account" when isMultiAccount is true', () => {
    expect(formatPlatformLabel('telegram', 'work', true)).toBe('telegram/work')
  })

  it('returns just the platform for default account when single account', () => {
    expect(formatPlatformLabel('telegram', 'default', false)).toBe('telegram')
  })

  it('returns "platform/default" for default account when multi-account', () => {
    expect(formatPlatformLabel('telegram', 'default', true)).toBe('telegram/default')
  })
})

// ── integration: listArchiveAccounts drives multi-account detection ────────────

describe('multi-account detection via listArchiveAccounts', () => {
  it('detects multiple accounts when archive has more than one distinct account', () => {
    const accounts = listArchiveAccounts()
    // seed has personal + work on telegram
    const uniqueAccounts = new Set(accounts.map(a => a.account))
    expect(uniqueAccounts.size).toBeGreaterThan(1)
  })

  it('handleListChats filtered by account=work returns only work chats', () => {
    const results = handleListChats(undefined, 'work')
    expect(results.every(r => r.account === 'work')).toBe(true)
    expect(results.some(r => r.name === 'Bob')).toBe(true)
    expect(results.some(r => r.name === 'Alice')).toBe(false)
  })

  it('handleListChats without account returns chats from all accounts', () => {
    const results = handleListChats()
    const accounts = new Set(results.map(r => r.account))
    expect(accounts.has('personal')).toBe(true)
    expect(accounts.has('work')).toBe(true)
  })

  it('handleSearchMessages filtered by account=personal returns only personal results', () => {
    const results = handleSearchMessages('hello', undefined, undefined, 'personal')
    expect(results.every(r => r.account === 'personal')).toBe(true)
    expect(results.some(r => r.chat_name === 'Alice')).toBe(true)
    expect(results.some(r => r.chat_name === 'Bob')).toBe(false)
  })

  it('handleSearchMessages without account returns results from all accounts', () => {
    const results = handleSearchMessages('hello')
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('single-account install: --account work returns empty result (unknown account)', () => {
    // Fresh DB with only default account
    initDb(':memory:')
    upsertChat({ external_id: '1', account: 'default', name: 'Chat1', type: 'user', username: null, platform: 'telegram' })
    rebuildFtsIndex()
    const results = handleListChats(undefined, 'work')
    expect(results).toEqual([])
  })
})
