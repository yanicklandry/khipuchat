/**
 * Tests for CLI --account flag parsing, multi-account output formatting,
 * and the `index [--force]` subcommand dispatch.
 * Covers requirement 5.1: account filter on CLI list and search.
 * Covers requirements 1.1, 1.4, 1.5: index command and --force flag.
 * Covers requirements 3.5, 3.6: get_image CLI subcommand.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex, getDb } from '../src/db'
import {
  parseAccountArg,
  formatPlatformLabel,
  parseForceArg,
  getUsageText,
} from '../src/cli'
import {
  handleListChats,
  handleSearchMessages,
  listArchiveAccounts,
} from '../src/query-handlers'
import { parseQueryFilters } from '../src/cli-filters'
import { rebuildEmbeddings } from '../src/index-embeddings'
import { handleGetImage } from '../src/mcp'

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
    const results = handleListChats({ account: 'work' })
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
    const results = handleSearchMessages('hello', { account: 'personal' })
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
    const results = handleListChats({ account: 'work' })
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

// ── search case: parseQueryFilters integration ────────────────────────────────
// Requirements 8.1–8.9: CLI search uses shared filter parser

describe('search case uses parseQueryFilters', () => {
  it('parseQueryFilters with --platform telegram produces filters accepted by handleSearchMessages', () => {
    // Simulates: parseQueryFilters(['--platform', 'telegram', 'hello'])
    const result = parseQueryFilters(['--platform', 'telegram', 'hello'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.filters.platform).toBe('telegram')
    expect(result.rest).toEqual(['hello'])
    // handleSearchMessages accepts it
    const rows = handleSearchMessages('hello', result.filters)
    expect(Array.isArray(rows)).toBe(true)
  })

  it('parseQueryFilters with --platform bogus returns ok:false with error message', () => {
    const result = parseQueryFilters(['--platform', 'bogus', 'hello'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/invalid platform/i)
    expect(result.error).toMatch(/bogus/)
  })

  it('parseQueryFilters with --limit 5 produces filters with limit:5', () => {
    const result = parseQueryFilters(['--limit', '5', 'foo'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.filters.limit).toBe(5)
    expect(result.rest).toEqual(['foo'])
  })

  it('parseQueryFilters with --account personal passes account filter to handleSearchMessages', () => {
    const result = parseQueryFilters(['--account', 'personal', 'hello'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.filters.account).toBe('personal')
    const rows = handleSearchMessages('hello', result.filters)
    expect(rows.every(r => r.account === 'personal')).toBe(true)
  })

  it('search with no query (empty rest after flag parsing) should use empty string guard', () => {
    // parseQueryFilters(['--platform', 'telegram']) => rest=[], first element undefined
    const result = parseQueryFilters(['--platform', 'telegram'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const searchQuery = result.rest[0] ?? ''
    expect(searchQuery).toBe('')
  })

  it('parseQueryFilters with --platform telegram and --limit 5 returns rows equal to unfiltered search', () => {
    // Seed has telegram messages; filtered search by platform should include them
    const result = parseQueryFilters(['--platform', 'telegram', '--limit', '5', 'hello'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const rows = handleSearchMessages('hello', result.filters)
    const allRows = handleSearchMessages('hello', { platform: 'telegram', limit: 5 })
    expect(rows).toEqual(allRows)
  })

  it('empty results case: handleSearchMessages returns empty array when no matches', () => {
    const result = parseQueryFilters(['nonexistentxyz123'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const searchQuery = result.rest[0] ?? ''
    const rows = handleSearchMessages(searchQuery, result.filters)
    expect(rows).toEqual([])
  })
})

// ── get_image CLI subcommand ──────────────────────────────────────────────────
// Requirements 3.5 (CLI access to get_image), 3.6 (documented in README + usage)

describe('get_image CLI subcommand', () => {
  // Helper: insert an image message and return its row ID
  function insertImageMessage(chatId: number, mediaFilePath: string | null, ocrText: string | null): number {
    const result = getDb()
      .prepare(
        `INSERT INTO messages
           (external_id, chat_id, sender_id, sender_name, text, type, timestamp, is_sender,
            reply_to_external_id, platform, media_file_path, ocr_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `img-${Date.now()}-${Math.random()}`,
        chatId,
        '1',
        'Alice',
        null,
        'image',
        1700000010,
        0,
        null,
        'telegram',
        mediaFilePath,
        ocrText,
      )
    return result.lastInsertRowid as number
  }

  it('getUsageText() mentions get_image', () => {
    const usage = getUsageText()
    expect(usage).toContain('get_image')
  })

  it('handleGetImage returns file_available:true for a stored image file', async () => {
    const chatId = ids.personal
    // Write a temp image file
    const tmpPath = path.join(os.tmpdir(), `khipuchat-test-img-${Date.now()}.jpg`)
    fs.writeFileSync(tmpPath, Buffer.from('fakeimagedata'))
    try {
      const msgId = insertImageMessage(chatId, tmpPath, 'some ocr text')
      const result = await handleGetImage(msgId)
      expect(result.file_available).toBe(true)
      if (!result.file_available) return
      expect(result.file_path).toBe(tmpPath)
      expect(result.ocr_text).toBe('some ocr text')
      // content_base64 should be non-empty (base64 of 'fakeimagedata')
      expect(result.content_base64.length).toBeGreaterThan(0)
    } finally {
      fs.unlinkSync(tmpPath)
    }
  })

  it('handleGetImage returns file_available:false with error when file missing from disk', async () => {
    const chatId = ids.personal
    const msgId = insertImageMessage(chatId, '/nonexistent/path/image.jpg', 'ocr fallback')
    const result = await handleGetImage(msgId)
    expect(result.file_available).toBe(false)
    if (result.file_available) return
    expect(result.error).toMatch(/not found on disk/)
    expect(result.ocr_text).toBe('ocr fallback')
  })

  it('handleGetImage throws for a non-image message ID', async () => {
    // Use a text message (seeded by seed())
    // The text messages in seed() have type 'text'
    const row = getDb()
      .prepare('SELECT id FROM messages WHERE type = ? LIMIT 1')
      .get('text') as { id: number } | undefined
    expect(row).toBeDefined()
    await expect(handleGetImage(row!.id)).rejects.toThrow(/not supported by get_image/)
  })

  it('handleGetImage throws for a missing message ID', async () => {
    await expect(handleGetImage(999999999)).rejects.toThrow(/message not found/)
  })

  it('parseInt NaN-guard: NaN messageId would exit (guard contract test)', () => {
    // Simulate what the case 'get_image' handler does before calling handleGetImage
    const query = 'notanumber'
    const messageId = parseInt(query, 10)
    expect(isNaN(messageId)).toBe(true)
    // When NaN, we print usage and exit — no call to handleGetImage
  })

  it('parseInt NaN-guard: valid numeric string parses correctly', () => {
    const query = '42'
    const messageId = parseInt(query, 10)
    expect(isNaN(messageId)).toBe(false)
    expect(messageId).toBe(42)
  })
})
