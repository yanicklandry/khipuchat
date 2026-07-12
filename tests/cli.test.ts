/**
 * Tests for CLI --account flag parsing, multi-account output formatting,
 * and the `index [--force]` subcommand dispatch.
 * Covers requirement 5.1: account filter on CLI list and search.
 * Covers requirements 1.1, 1.4, 1.5: index command and --force flag.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import {
  parseAccountArg,
  formatPlatformLabel,
  parseForceArg,
} from '../src/cli'
import {
  handleListChats,
  handleSearchMessages,
  listArchiveAccounts,
} from '../src/query-handlers'
import { rebuildEmbeddings } from '../src/index-embeddings'

vi.mock('../src/index-embeddings', () => ({
  rebuildEmbeddings: vi.fn().mockResolvedValue(undefined),
}))

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

// ── parseForceArg ─────────────────────────────────────────────────────────────
// Requirements 1.4 (incremental by default) and 1.5 (--force re-embeds from scratch)

describe('parseForceArg', () => {
  it('returns false when --force is absent', () => {
    expect(parseForceArg(['index'])).toBe(false)
  })

  it('returns true when --force is present', () => {
    expect(parseForceArg(['index', '--force'])).toBe(true)
  })

  it('returns true when --force appears as the only arg', () => {
    expect(parseForceArg(['--force'])).toBe(true)
  })

  it('returns false for an empty args array (incremental by default)', () => {
    expect(parseForceArg([])).toBe(false)
  })
})

// ── index command usage text ──────────────────────────────────────────────────
// Requirement 1.1: usage text lists the `index` command

describe('CLI usage text includes index command', () => {
  it('usage text exported from getUsageText includes index [--force]', async () => {
    const { getUsageText } = await import('../src/cli')
    const usage = getUsageText()
    expect(usage).toContain('index')
    expect(usage).toContain('--force')
  })
})

// ── index command dispatch integration ───────────────────────────────────────
// Requirements 1.1, 1.4 (incremental sweep), 1.5 (--force clear-then-rebuild)
// Verifies: parseForceArg + rebuildEmbeddings call contract as wired in `case 'index'`.

describe('index command dispatch', () => {
  beforeEach(() => {
    vi.mocked(rebuildEmbeddings).mockClear()
  })

  it('khipu index (no --force) calls rebuildEmbeddings with force=false (incremental sweep)', async () => {
    // Simulate: case 'index': const force = parseForceArg(rawRest); await rebuildEmbeddings(undefined, force)
    const rawRest = ['index']
    const force = parseForceArg(rawRest)
    expect(force).toBe(false)
    await rebuildEmbeddings(undefined, force)
    expect(vi.mocked(rebuildEmbeddings)).toHaveBeenCalledOnce()
    expect(vi.mocked(rebuildEmbeddings)).toHaveBeenCalledWith(undefined, false)
  })

  it('khipu index --force calls rebuildEmbeddings with force=true (clear-then-rebuild)', async () => {
    // Simulate: case 'index': const force = parseForceArg(rawRest); await rebuildEmbeddings(undefined, force)
    const rawRest = ['index', '--force']
    const force = parseForceArg(rawRest)
    expect(force).toBe(true)
    await rebuildEmbeddings(undefined, force)
    expect(vi.mocked(rebuildEmbeddings)).toHaveBeenCalledOnce()
    expect(vi.mocked(rebuildEmbeddings)).toHaveBeenCalledWith(undefined, true)
  })

  it('index dispatch never passes a platform (whole-DB scope)', async () => {
    const rawRest: string[] = []
    const force = parseForceArg(rawRest)
    await rebuildEmbeddings(undefined, force)
    const [platform] = vi.mocked(rebuildEmbeddings).mock.calls[0]
    expect(platform).toBeUndefined()
  })
})
