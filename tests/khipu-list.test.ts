import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatResult } from '../src/query-handlers'
import type { MessageResult } from '../src/db'

// We test by exercising runList() which accepts injected deps — no real DB needed.
import { runList } from '../src/khipu-list'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChat(overrides: Partial<ChatResult> = {}): ChatResult {
  return {
    chat_id: 1,
    name: 'Test Chat',
    type: 'user',
    username: null,
    message_count: 5,
    platform: 'telegram',
    account: 'alice',
    ...overrides,
  }
}

function makeMessage(overrides: Partial<MessageResult> = {}): MessageResult {
  return {
    id: 1,
    chat_id: 10,
    sender_name: 'Bob',
    text: 'Hello world',
    type: 'text',
    timestamp: 1705320000,
    is_sender: 0,
    platform: 'telegram',
    account: 'alice',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runList', () => {
  let logLines: string[]
  let errLines: string[]
  let exitCode: number | undefined
  let defaultDeps: {
    handleListChats: ReturnType<typeof vi.fn>
    handleListArchiveMessages: ReturnType<typeof vi.fn>
    listArchiveAccounts: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    logLines = []
    errLines = []
    exitCode = undefined
    defaultDeps = {
      handleListChats: vi.fn().mockReturnValue([]),
      handleListArchiveMessages: vi.fn().mockReturnValue({ messages: [], has_more: false }),
      listArchiveAccounts: vi.fn().mockReturnValue([]),
    }
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '))
    })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errLines.push(args.join(' '))
    })
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      exitCode = typeof code === 'number' ? code : 1
      throw new Error(`process.exit(${code})`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function run(args: string[], overrides = {}) {
    const deps = { ...defaultDeps, ...overrides }
    try {
      await runList(args, deps)
    } catch {
      // swallow process.exit throws
    }
  }

  // ── Bare list (no subcommand) ─────────────────────────────────────────────

  it('bare list prints usage and exits non-zero', async () => {
    await run([])
    expect(exitCode).toBeGreaterThan(0)
    expect(errLines.join('\n')).toContain('Usage')
  })

  it('unknown subcommand prints usage and exits non-zero', async () => {
    await run(['bogus'])
    expect(exitCode).toBeGreaterThan(0)
    expect(errLines.join('\n')).toContain('Usage')
  })

  // ── Filter parse errors ───────────────────────────────────────────────────

  it('invalid --platform value exits non-zero with error message', async () => {
    await run(['messages', '--platform', 'bogus'])
    expect(exitCode).toBeGreaterThan(0)
    expect(errLines.join('\n')).toMatch(/invalid platform/i)
  })

  it('invalid --limit value exits non-zero with error message', async () => {
    await run(['messages', '--limit', 'notanumber'])
    expect(exitCode).toBeGreaterThan(0)
    expect(errLines.join('\n')).toMatch(/invalid --limit/i)
  })

  // ── list chats ────────────────────────────────────────────────────────────

  it('list chats calls handleListChats and prints results', async () => {
    const handleListChats = vi.fn().mockReturnValue([makeChat()])
    await run(['chats'], { handleListChats })
    expect(handleListChats).toHaveBeenCalled()
    const output = logLines.join('\n')
    expect(output).toContain('Test Chat')
    expect(exitCode).toBeUndefined()
  })

  it('list chats with empty results prints empty-results message and exits 0', async () => {
    const handleListChats = vi.fn().mockReturnValue([])
    await run(['chats'], { handleListChats })
    const output = logLines.join('\n')
    expect(output).toMatch(/no chats found/i)
    expect(exitCode).toBeUndefined()
  })

  it('list chats passes filters to handleListChats', async () => {
    const handleListChats = vi.fn().mockReturnValue([])
    await run(['chats', '--platform', 'telegram', '--limit', '5'], { handleListChats })
    expect(handleListChats).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'telegram', limit: 5 })
    )
  })

  // ── list messages ─────────────────────────────────────────────────────────

  it('list messages calls handleListArchiveMessages and prints results', async () => {
    const handleListArchiveMessages = vi.fn().mockReturnValue({
      messages: [makeMessage()],
      has_more: false,
    })
    await run(['messages'], { handleListArchiveMessages })
    expect(handleListArchiveMessages).toHaveBeenCalled()
    const output = logLines.join('\n')
    expect(output).toContain('Hello world')
    expect(exitCode).toBeUndefined()
  })

  it('list messages with empty results prints empty-results message and exits 0', async () => {
    const handleListArchiveMessages = vi.fn().mockReturnValue({
      messages: [],
      has_more: false,
    })
    await run(['messages'], { handleListArchiveMessages })
    const output = logLines.join('\n')
    expect(output).toMatch(/no messages found/i)
    expect(exitCode).toBeUndefined()
  })

  it('list messages passes filters to handleListArchiveMessages', async () => {
    const handleListArchiveMessages = vi.fn().mockReturnValue({ messages: [], has_more: false })
    await run(['messages', '--type', 'text', '--limit', '10'], { handleListArchiveMessages })
    expect(handleListArchiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', limit: 10 })
    )
  })

  it('shows sender name in message output when present', async () => {
    const handleListArchiveMessages = vi.fn().mockReturnValue({
      messages: [makeMessage({ sender_name: 'Alice', text: 'hi there' })],
      has_more: false,
    })
    await run(['messages'], { handleListArchiveMessages })
    const output = logLines.join('\n')
    expect(output).toContain('Alice')
    expect(output).toContain('hi there')
  })

  it('shows (more results available) line when has_more is true', async () => {
    const handleListArchiveMessages = vi.fn().mockReturnValue({
      messages: [makeMessage()],
      has_more: true,
    })
    await run(['messages'], { handleListArchiveMessages })
    const output = logLines.join('\n')
    expect(output).toContain('more results available')
  })

  // ── multi-account label ───────────────────────────────────────────────────

  it('shows platform/account label when multiple accounts are present', async () => {
    const listArchiveAccounts = vi.fn().mockReturnValue([
      { platform: 'telegram', account: 'alice' },
      { platform: 'telegram', account: 'bob' },
    ])
    const handleListChats = vi.fn().mockReturnValue([
      makeChat({ platform: 'telegram', account: 'alice' }),
    ])
    await run(['chats'], { listArchiveAccounts, handleListChats })
    const output = logLines.join('\n')
    expect(output).toContain('telegram/alice')
  })

  it('shows only platform label when single account is present', async () => {
    const listArchiveAccounts = vi.fn().mockReturnValue([
      { platform: 'telegram', account: 'alice' },
    ])
    const handleListChats = vi.fn().mockReturnValue([
      makeChat({ platform: 'telegram', account: 'alice' }),
    ])
    await run(['chats'], { listArchiveAccounts, handleListChats })
    const output = logLines.join('\n')
    expect(output).toContain('telegram')
    expect(output).not.toContain('telegram/alice')
  })
})
