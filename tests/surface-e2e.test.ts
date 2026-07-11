/**
 * Surface E2E tests: MCP handlers, CLI helpers, and Web routes tested
 * against a real SQLite :memory: database with multi-account data.
 *
 * All three surfaces read from the same shared DB state, verifying that
 * account filtering and account field presence are consistent across surfaces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import { handleListChats, handleSearchMessages, handleSemanticSearchMessages, listArchiveAccounts } from '../src/query-handlers'
import { parseAccountArg, formatPlatformLabel } from '../src/cli'
import { createApp } from '../src/web/server'
import * as vecDb from '../src/vec-db'

vi.mock('../src/vec-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vec-db')>()
  return { ...actual, isIndexed: vi.fn().mockReturnValue(false), semanticSearchMessages: vi.fn().mockReturnValue([]) }
})
vi.mock('../src/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings')>()
  return { ...actual, embedOne: vi.fn().mockResolvedValue(new Float32Array(384)) }
})

// ── Shared seed ───────────────────────────────────────────────────────────────

let workChatId: number
let personalChatId: number

function seedMultiAccount() {
  initDb(':memory:')
  workChatId = upsertChat({ external_id: 'w1', account: 'work', name: 'Work Chat', type: 'private', username: null, platform: 'imessage' })
  personalChatId = upsertChat({ external_id: 'p1', account: 'personal', name: 'Personal Chat', type: 'private', username: null, platform: 'imessage' })
  insertMessage({ external_id: 'wm1', chat_id: workChatId, sender_id: null, sender_name: 'Boss', text: 'deploy done', type: 'text', timestamp: 1700000010, is_sender: 0, reply_to_external_id: null, platform: 'imessage' })
  insertMessage({ external_id: 'pm1', chat_id: personalChatId, sender_id: null, sender_name: 'Friend', text: 'see you tonight', type: 'text', timestamp: 1700000020, is_sender: 0, reply_to_external_id: null, platform: 'imessage' })
  insertMessage({ external_id: 'pm2', chat_id: personalChatId, sender_id: null, sender_name: 'Friend', text: 'almost done packing', type: 'text', timestamp: 1700000030, is_sender: 0, reply_to_external_id: null, platform: 'imessage' })
  rebuildFtsIndex()
}

beforeEach(() => {
  seedMultiAccount()
})

// ── MCP surface: handleListChats ──────────────────────────────────────────────

describe('MCP handleListChats', () => {
  it('with account="work" returns only work chats, each with account field', () => {
    const results = handleListChats(undefined, 'work')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.account === 'work')).toBe(true)
    expect(results.some(r => r.name === 'Work Chat')).toBe(true)
    expect(results.some(r => r.name === 'Personal Chat')).toBe(false)
  })

  it('without account returns all chats, every result carries account field', () => {
    const results = handleListChats()
    expect(results.length).toBe(2)
    expect(results.every(r => typeof r.account === 'string')).toBe(true)
    const accounts = new Set(results.map(r => r.account))
    expect(accounts.has('work')).toBe(true)
    expect(accounts.has('personal')).toBe(true)
  })
})

// ── MCP surface: handleSearchMessages ─────────────────────────────────────────

describe('MCP handleSearchMessages', () => {
  it('with account="work" returns only work messages, each with account field', () => {
    const results = handleSearchMessages('deploy', undefined, undefined, 'work')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.account === 'work')).toBe(true)
    expect(results.some(r => r.chat_name === 'Work Chat')).toBe(true)
    expect(results.some(r => r.chat_name === 'Personal Chat')).toBe(false)
  })

  it('without account returns messages from all accounts, each with account field', () => {
    const results = handleSearchMessages('see')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => typeof r.account === 'string')).toBe(true)
  })

  it('with account="personal" returns personal messages and excludes work messages', () => {
    const results = handleSearchMessages('done', undefined, undefined, 'personal')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.account === 'personal')).toBe(true)
  })
})

// ── MCP surface: handleSemanticSearchMessages ─────────────────────────────────

type FakeResult = { account: string; chat_name: string }
const FAKE_RESULTS: FakeResult[] = [
  { account: 'work', chat_name: 'Work Chat' },
  { account: 'personal', chat_name: 'Personal Chat' },
]

describe('MCP handleSemanticSearchMessages', () => {
  afterEach(() => { vi.mocked(vecDb.isIndexed).mockReturnValue(false); vi.mocked(vecDb.semanticSearchMessages).mockReturnValue([]) })

  it('with account="work" passes account filter to vec-db and returns scoped results', async () => {
    vi.mocked(vecDb.isIndexed).mockReturnValue(true)
    vi.mocked(vecDb.semanticSearchMessages).mockImplementation((_v, f) => FAKE_RESULTS.filter(r => !f.account || r.account === f.account) as never[])
    const result = await handleSemanticSearchMessages('hello', { account: 'work' })
    expect(Array.isArray(result)).toBe(true)
    const results = result as FakeResult[]
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.account === 'work')).toBe(true)
    expect(results.some(r => r.account === 'personal')).toBe(false)
  })

  it('without account returns all-account results', async () => {
    vi.mocked(vecDb.isIndexed).mockReturnValue(true)
    vi.mocked(vecDb.semanticSearchMessages).mockImplementation((_v, f) => FAKE_RESULTS.filter(r => !f.account || r.account === f.account) as never[])
    const result = await handleSemanticSearchMessages('hello', {})
    expect(Array.isArray(result)).toBe(true)
    const results = result as FakeResult[]
    expect(results.length).toBe(2)
    expect(results.some(r => r.account === 'work')).toBe(true)
    expect(results.some(r => r.account === 'personal')).toBe(true)
  })
})

// ── CLI surface: parseAccountArg and formatPlatformLabel ──────────────────────

describe('CLI parseAccountArg', () => {
  it('extracts --account work and removes tokens from rest', () => {
    const { account, rest } = parseAccountArg(['list-chats', '--account', 'work'])
    expect(account).toBe('work')
    expect(rest).toEqual(['list-chats'])
  })

  it('returns undefined when flag is absent', () => {
    const { account, rest } = parseAccountArg(['list-chats'])
    expect(account).toBeUndefined()
    expect(rest).toEqual(['list-chats'])
  })
})

describe('CLI formatPlatformLabel', () => {
  it('shows platform only when single account', () => {
    expect(formatPlatformLabel('imessage', 'work', false)).toBe('imessage')
  })

  it('shows platform/account when multiple accounts present', () => {
    expect(formatPlatformLabel('imessage', 'work', true)).toBe('imessage/work')
  })

  it('multi-account label uses listArchiveAccounts to drive isMultiAccount flag', () => {
    const accounts = listArchiveAccounts()
    const uniqueAccounts = new Set(accounts.map(a => a.account))
    const isMultiAccount = uniqueAccounts.size > 1
    expect(isMultiAccount).toBe(true)
    const label = formatPlatformLabel('imessage', 'work', isMultiAccount)
    expect(label).toBe('imessage/work')
  })
})

// ── Web surface: GET /api/chats ───────────────────────────────────────────────

describe('Web GET /api/chats', () => {
  it('with ?account=work returns only work chats with account field', async () => {
    const app = createApp()
    const res = await request(app).get('/api/chats?account=work')
    expect(res.status).toBe(200)
    const chats = res.body as { name: string; account: string }[]
    expect(chats.length).toBeGreaterThan(0)
    expect(chats.every(c => c.account === 'work')).toBe(true)
    expect(chats.some(c => c.name === 'Work Chat')).toBe(true)
    expect(chats.some(c => c.name === 'Personal Chat')).toBe(false)
  })

  it('without ?account returns all chats with account on each object', async () => {
    const app = createApp()
    const res = await request(app).get('/api/chats')
    expect(res.status).toBe(200)
    const chats = res.body as { name: string; account: string }[]
    expect(chats.length).toBe(2)
    expect(chats.every(c => typeof c.account === 'string')).toBe(true)
  })
})

// ── Web surface: GET / account label ─────────────────────────────────────────

describe('Web GET / multi-account UI', () => {
  it('shows account selector when platform has multiple accounts', async () => {
    const app = createApp()
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toContain('<select')
    expect(res.text).toContain('work')
    expect(res.text).toContain('personal')
  })

  it('includes multi-account flag for client JS to show account labels', async () => {
    const app = createApp()
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toMatch(/MULTI_ACCOUNT_PLATFORMS|multiAccountPlatforms/)
  })
})
