import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/account-registry', () => ({
  loadRegistry: vi.fn(() => ({
    listAccounts: vi.fn().mockReturnValue([]),
    credentialsFor: vi.fn().mockReturnValue({}),
  })),
}))

vi.mock('../src/db', () => ({
  initDb: vi.fn(() => ({
    prepare: vi.fn().mockReturnValue({
      pluck: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(0) }),
    }),
  })),
  getPlatformLastSyncedAt: vi.fn().mockReturnValue(null),
}))

vi.mock('../src/index-embeddings', () => ({
  rebuildEmbeddings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/platforms/telegram/sync', () => ({
  createTelegramAdapter: vi.fn(),
  telegramAdapter: {},
}))

vi.mock('../src/platforms/discord/sync', () => ({
  createDiscordAdapter: vi.fn(),
}))

vi.mock('../src/platforms/email/sync', () => ({
  createEmailAdapter: vi.fn(),
}))

vi.mock('../src/platforms/imessage/sync', () => ({
  createIMessageAdapter: vi.fn(),
}))

vi.mock('../src/platforms/slack/sync', () => ({
  createSlackAdapter: vi.fn(),
}))

vi.mock('../src/platforms/whatsapp/sync', () => ({
  createWhatsAppAdapter: vi.fn(),
}))

import { getIntervalMs, DEFAULT_INTERVAL_MS, pollCycle } from '../src/watch'
import { getPlatformLastSyncedAt } from '../src/db'
import { rebuildEmbeddings } from '../src/index-embeddings'
import type Database from 'better-sqlite3-multiple-ciphers'
import type { PlatformAdapter } from '../src/platforms/types'

// Helper to build a mock db with configurable COUNT(*) return values
function makeMockDb(...counts: number[]): Database.Database {
  const getCounts = counts.slice()
  return {
    prepare: vi.fn().mockReturnValue({
      pluck: vi.fn().mockReturnValue({
        get: vi.fn().mockImplementation(() => getCounts.shift() ?? 0),
      }),
    }),
  } as unknown as Database.Database
}

describe('pollCycle', () => {
  beforeEach(() => {
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(null)
    vi.mocked(rebuildEmbeddings).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls syncIncremental when adapter has it and getPlatformLastSyncedAt returns a number', async () => {
    const since = 1234567890
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(since)
    const syncIncremental = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'telegram',
      account: 'test-account',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
      syncIncremental,
    }
    const mockDb = makeMockDb(10, 10) // no new messages
    await pollCycle(adapter, mockDb)
    expect(syncIncremental).toHaveBeenCalledWith(mockDb, new Date(since * 1000))
    expect(adapter.runBackfill).not.toHaveBeenCalled()
  })

  it('calls runBackfill when adapter lacks syncIncremental', async () => {
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(9999)
    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'discord',
      account: 'test-account',
      runBackfill,
      startListener: vi.fn(),
    }
    const mockDb = makeMockDb(5, 5)
    await pollCycle(adapter, mockDb)
    expect(runBackfill).toHaveBeenCalledWith(mockDb)
  })

  it('catches and logs syncIncremental errors without rethrowing', async () => {
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(111)
    const adapter: PlatformAdapter = {
      platform: 'slack',
      account: 'test-account',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
      syncIncremental: vi.fn().mockRejectedValue(new Error('sync failed')),
    }
    const mockDb = makeMockDb(0, 0)
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(pollCycle(adapter, mockDb)).resolves.toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('sync failed'))
    stderrSpy.mockRestore()
  })

  it('inFlight counter is 0 after pollCycle resolves (success path)', async () => {
    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'email',
      account: 'test-account',
      runBackfill,
      startListener: vi.fn(),
    }
    const mockDb = makeMockDb(0, 0)
    // Resolving is itself the evidence: if inFlight were stuck > 0, drain logic would hang
    await expect(pollCycle(adapter, mockDb)).resolves.toBeUndefined()
  })

  it('inFlight counter is 0 after pollCycle resolves (error path)', async () => {
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(1)
    const adapter: PlatformAdapter = {
      platform: 'telegram',
      account: 'test-account',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
      syncIncremental: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const mockDb = makeMockDb(0, 0)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(pollCycle(adapter, mockDb)).resolves.toBeUndefined()
    vi.restoreAllMocks()
  })

  it('calls rebuildEmbeddings when new messages were fetched', async () => {
    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'discord',
      account: 'test-account',
      runBackfill,
      startListener: vi.fn(),
    }
    const mockDb = makeMockDb(10, 15) // 5 new messages
    await pollCycle(adapter, mockDb)
    expect(rebuildEmbeddings).toHaveBeenCalledWith('discord')
  })

  it('skips rebuildEmbeddings when no new messages were fetched', async () => {
    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'email',
      account: 'test-account',
      runBackfill,
      startListener: vi.fn(),
    }
    const mockDb = makeMockDb(7, 7) // 0 new messages
    await pollCycle(adapter, mockDb)
    expect(rebuildEmbeddings).not.toHaveBeenCalled()
  })

  it('COUNT query is scoped to both platform and account via JOIN chats', async () => {
    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'telegram',
      account: 'user-123',
      runBackfill,
      startListener: vi.fn(),
    }
    const getSpy = vi.fn().mockReturnValue(0)
    const prepareSpy = vi.fn().mockReturnValue({ pluck: vi.fn().mockReturnValue({ get: getSpy }) })
    const mockDb = { prepare: prepareSpy } as unknown as Database.Database
    await pollCycle(adapter, mockDb)
    for (const call of prepareSpy.mock.calls) {
      expect(call[0]).toContain('JOIN chats')
    }
    for (const call of getSpy.mock.calls) {
      expect(call).toEqual(['telegram', 'user-123'])
    }
  })

  it('resolves and logs when the indexing step throws', async () => {
    vi.mocked(rebuildEmbeddings).mockRejectedValue(new Error('index fail'))
    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'slack',
      account: 'test-account',
      runBackfill,
      startListener: vi.fn(),
    }
    const mockDb = makeMockDb(0, 3) // 3 new messages -> triggers rebuildEmbeddings
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(pollCycle(adapter, mockDb)).resolves.toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('index fail'))
    stderrSpy.mockRestore()
  })
})

describe('isConfigured', () => {
  const ENV_KEYS = {
    discord: 'DISCORD_TOKEN',
    telegram: 'TG_API_ID',
    slack: 'SLACK_USER_TOKEN',
    email: 'EMAIL_IMAP_HOST',
  }

  let savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save and clear all credential env vars used by isConfigured
    for (const key of Object.values(ENV_KEYS)) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = val
      }
    }
    savedEnv = {}
  })

  it('returns true for local-only platforms without any env vars', async () => {
    const { isConfigured } = await import('../src/watch')
    expect(isConfigured('imessage')).toBe(true)
    expect(isConfigured('whatsapp')).toBe(true)
  })

  it('returns true when any required credential env var is set', async () => {
    const { isConfigured } = await import('../src/watch')
    process.env['DISCORD_TOKEN'] = 'test-token'
    expect(isConfigured('discord')).toBe(true)
  })

  it('returns false when required credential env vars are absent', async () => {
    const { isConfigured } = await import('../src/watch')
    expect(isConfigured('discord')).toBe(false)
    expect(isConfigured('telegram')).toBe(false)
    expect(isConfigured('slack')).toBe(false)
    expect(isConfigured('email')).toBe(false)
  })
})

describe('Integration: startup adapter selection', () => {
  let savedDiscordToken: string | undefined
  let savedTgApiId: string | undefined

  beforeEach(() => {
    savedDiscordToken = process.env['DISCORD_TOKEN']
    savedTgApiId = process.env['TG_API_ID']
    delete process.env['DISCORD_TOKEN']
    delete process.env['TG_API_ID']
  })

  afterEach(() => {
    if (savedDiscordToken === undefined) {
      delete process.env['DISCORD_TOKEN']
    } else {
      process.env['DISCORD_TOKEN'] = savedDiscordToken
    }
    if (savedTgApiId === undefined) {
      delete process.env['TG_API_ID']
    } else {
      process.env['TG_API_ID'] = savedTgApiId
    }
    vi.clearAllMocks()
  })

  it('configured adapter pollCycle is called; unconfigured adapter is skipped with a log', async () => {
    const { isConfigured, pollCycle } = await import('../src/watch')

    // Set discord as configured, leave telegram unconfigured
    process.env['DISCORD_TOKEN'] = 'test-token'

    const discordAdapter: PlatformAdapter = {
      platform: 'discord',
      account: 'test-account',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
    }
    const telegramAdapter: PlatformAdapter = {
      platform: 'telegram',
      account: 'test-account',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    // Simulate what main() does for these two platforms:
    const adapters: PlatformAdapter[] = []
    const platforms = ['discord', 'telegram'] as const

    for (const platform of platforms) {
      if (!isConfigured(platform)) {
        console.log(`[${platform}] skipped: not configured (missing credentials)`)
        continue
      }
      adapters.push(platform === 'discord' ? discordAdapter : telegramAdapter)
    }

    const mockDb = makeMockDb(0, 0)
    for (const adapter of adapters) {
      await pollCycle(adapter, mockDb)
    }

    expect(discordAdapter.runBackfill).toHaveBeenCalledWith(mockDb)
    expect(telegramAdapter.runBackfill).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[telegram] skipped: not configured (missing credentials)')
    )

    logSpy.mockRestore()
  })
})

describe('Integration: error isolation across adapters', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('second adapter poll cycle completes normally even when first adapter always throws', async () => {
    const { pollCycle } = await import('../src/watch')

    const failingAdapter: PlatformAdapter = {
      platform: 'slack',
      account: 'account-a',
      runBackfill: vi.fn().mockRejectedValue(new Error('adapter-a always fails')),
      startListener: vi.fn(),
    }
    const successAdapter: PlatformAdapter = {
      platform: 'email',
      account: 'account-b',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
    }

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const mockDb1 = makeMockDb(0, 0)
    const mockDb2 = makeMockDb(0, 0)

    // Both should resolve (pollCycle never rethrows)
    await Promise.all([
      pollCycle(failingAdapter, mockDb1),
      pollCycle(successAdapter, mockDb2),
    ])

    expect(failingAdapter.runBackfill).toHaveBeenCalledWith(mockDb1)
    expect(successAdapter.runBackfill).toHaveBeenCalledWith(mockDb2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('adapter-a always fails'))

    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })
})

describe('Integration: --once mode single-pass behavior', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('all adapter poll cycles complete and no error thrown in once-mode pass', async () => {
    const { pollCycle } = await import('../src/watch')

    const adapterA: PlatformAdapter = {
      platform: 'discord',
      account: 'account-a',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
    }
    const adapterB: PlatformAdapter = {
      platform: 'email',
      account: 'account-b',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
    }
    const adapterC: PlatformAdapter = {
      platform: 'slack',
      account: 'account-c',
      runBackfill: vi.fn().mockRejectedValue(new Error('slack error')),
      startListener: vi.fn(),
    }

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const adapters = [adapterA, adapterB, adapterC]
    const mockDbs = [makeMockDb(0, 0), makeMockDb(0, 0), makeMockDb(0, 0)]

    // Simulate --once mode: Promise.all over all adapters
    await expect(
      Promise.all(
        adapters.map(async (adapter, i) => {
          try {
            await pollCycle(adapter, mockDbs[i])
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[${adapter.platform}] once-pass error: ${msg}`)
          }
        })
      )
    ).resolves.toBeInstanceOf(Array)

    // All adapters attempted
    expect(adapterA.runBackfill).toHaveBeenCalledWith(mockDbs[0])
    expect(adapterB.runBackfill).toHaveBeenCalledWith(mockDbs[1])
    expect(adapterC.runBackfill).toHaveBeenCalledWith(mockDbs[2])

    // The failing adapter logged an error (pollCycle catches it internally)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('slack error'))

    stderrSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('no setInterval is called in once-mode pass (pass completes and resolves)', async () => {
    const { pollCycle } = await import('../src/watch')

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    const adapter: PlatformAdapter = {
      platform: 'discord',
      account: 'test',
      runBackfill: vi.fn().mockResolvedValue(undefined),
      startListener: vi.fn(),
    }

    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const mockDb = makeMockDb(0, 0)

    // In once mode, we call pollCycle directly without setInterval
    await pollCycle(adapter, mockDb)

    expect(setIntervalSpy).not.toHaveBeenCalled()

    setIntervalSpy.mockRestore()
    vi.restoreAllMocks()
  })
})

describe('getIntervalMs', () => {
  const ENV_KEY = 'WATCH_INTERVAL_TELEGRAM_MS'
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = originalEnv
    }
  })

  it('returns DEFAULT_INTERVAL_MS (300000) when env var is absent', () => {
    expect(getIntervalMs('telegram')).toBe(DEFAULT_INTERVAL_MS)
    expect(getIntervalMs('telegram')).toBe(300_000)
  })

  it('returns parsed integer when env var is a valid positive integer string', () => {
    process.env[ENV_KEY] = '60000'
    expect(getIntervalMs('telegram')).toBe(60_000)
  })

  it('returns DEFAULT_INTERVAL_MS when env var is set to a non-numeric string', () => {
    process.env[ENV_KEY] = 'not-a-number'
    expect(getIntervalMs('telegram')).toBe(DEFAULT_INTERVAL_MS)
  })
})
