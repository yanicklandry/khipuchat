import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseSyncArgs, runPlatformSync } from '../src/sync-runner'
import type { PlatformAdapter } from '../src/platforms/types'
import Database from 'better-sqlite3-multiple-ciphers'

// ── parseSyncArgs ─────────────────────────────────────────────────────────────

describe('parseSyncArgs', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('returns { force: false } with no flags', () => {
    const result = parseSyncArgs([])
    expect(result).toEqual({ force: false })
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('returns { force: true } with --force and no stderr output', () => {
    const result = parseSyncArgs(['--force'])
    expect(result).toEqual({ force: true })
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('returns { force: true } with --backfill and emits a deprecation warning to stderr', () => {
    const result = parseSyncArgs(['--backfill'])
    expect(result).toEqual({ force: true })
    expect(stderrSpy).toHaveBeenCalledOnce()
    const written = String(stderrSpy.mock.calls[0][0])
    expect(written).toMatch(/--backfill.*deprecated/i)
  })

  it('returns { force: true } with both --force and --backfill', () => {
    const result = parseSyncArgs(['--force', '--backfill'])
    expect(result).toEqual({ force: true })
  })

  it('deprecation warning for --backfill is exactly one line (ends with newline)', () => {
    parseSyncArgs(['--backfill'])
    const written = String(stderrSpy.mock.calls[0][0])
    expect(written.endsWith('\n')).toBe(true)
    // Only one newline: the trailing one
    expect(written.trimEnd().includes('\n')).toBe(false)
  })
})

// ── runPlatformSync ────────────────────────────────────────────────────────────

function makeInMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      platform       TEXT NOT NULL PRIMARY KEY,
      last_synced_at INTEGER NOT NULL
    )
  `)
  return db
}

describe('runPlatformSync', () => {
  let db: Database.Database
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = makeInMemoryDb()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    // Mock the db module so getPlatformLastSyncedAt/setPlatformLastSyncedAt
    // operate on our in-memory db instance directly
    vi.mock('../src/db', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/db')>()
      return {
        ...actual,
        getPlatformLastSyncedAt: vi.fn(),
        setPlatformLastSyncedAt: vi.fn(),
        rebuildFtsIndex: vi.fn(),
      }
    })

    vi.mock('../src/index-embeddings', () => ({
      rebuildEmbeddings: vi.fn().mockResolvedValue(undefined),
    }))
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('routes to backfill and writes sync_state on clean completion (no prior state, no --force)', async () => {
    const { getPlatformLastSyncedAt, setPlatformLastSyncedAt } = await import('../src/db')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(null)

    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = { platform: 'telegram', runBackfill, startListener: vi.fn() }

    const before = Math.floor(Date.now() / 1000)
    await runPlatformSync(adapter, db, [])
    const after = Math.floor(Date.now() / 1000)

    expect(runBackfill).toHaveBeenCalledOnce()
    expect(setPlatformLastSyncedAt).toHaveBeenCalledOnce()
    const [platform, ts] = vi.mocked(setPlatformLastSyncedAt).mock.calls[0]
    expect(platform).toBe('telegram')
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('routes to syncIncremental when since is available and adapter has syncIncremental', async () => {
    const { getPlatformLastSyncedAt, setPlatformLastSyncedAt } = await import('../src/db')
    const since = Math.floor(Date.now() / 1000) - 3600
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(since)

    const syncIncremental = vi.fn().mockResolvedValue(undefined)
    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'telegram',
      runBackfill,
      startListener: vi.fn(),
      syncIncremental,
    }

    await runPlatformSync(adapter, db, [])

    expect(syncIncremental).toHaveBeenCalledOnce()
    expect(runBackfill).not.toHaveBeenCalled()
    // syncIncremental called with the db and a Date
    const [, sinceDate] = vi.mocked(syncIncremental).mock.calls[0]
    expect(sinceDate).toBeInstanceOf(Date)
    expect(sinceDate.getTime()).toBe(since * 1000)
    expect(setPlatformLastSyncedAt).toHaveBeenCalledOnce()
  })

  it('falls back to backfill when since is available but adapter has no syncIncremental', async () => {
    const { getPlatformLastSyncedAt } = await import('../src/db')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(Math.floor(Date.now() / 1000) - 3600)

    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = { platform: 'telegram', runBackfill, startListener: vi.fn() }

    await runPlatformSync(adapter, db, [])

    expect(runBackfill).toHaveBeenCalledOnce()
  })

  it('routes to backfill on --force regardless of since', async () => {
    const { getPlatformLastSyncedAt } = await import('../src/db')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(Math.floor(Date.now() / 1000) - 3600)

    const syncIncremental = vi.fn().mockResolvedValue(undefined)
    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = {
      platform: 'telegram',
      runBackfill,
      startListener: vi.fn(),
      syncIncremental,
    }

    await runPlatformSync(adapter, db, ['--force'])

    expect(runBackfill).toHaveBeenCalledOnce()
    expect(syncIncremental).not.toHaveBeenCalled()
  })

  it('calls rebuildFtsIndex and rebuildEmbeddings on --force success', async () => {
    const { getPlatformLastSyncedAt, rebuildFtsIndex } = await import('../src/db')
    const { rebuildEmbeddings } = await import('../src/index-embeddings')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(null)

    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = { platform: 'telegram', runBackfill, startListener: vi.fn() }

    await runPlatformSync(adapter, db, ['--force'])

    expect(rebuildFtsIndex).toHaveBeenCalledOnce()
    expect(rebuildEmbeddings).toHaveBeenCalledOnce()
    expect(rebuildEmbeddings).toHaveBeenCalledWith('telegram')
  })

  it('does NOT call rebuildFtsIndex or rebuildEmbeddings without --force', async () => {
    const { getPlatformLastSyncedAt, rebuildFtsIndex } = await import('../src/db')
    const { rebuildEmbeddings } = await import('../src/index-embeddings')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(null)

    const runBackfill = vi.fn().mockResolvedValue(undefined)
    const adapter: PlatformAdapter = { platform: 'telegram', runBackfill, startListener: vi.fn() }

    await runPlatformSync(adapter, db, [])

    expect(rebuildFtsIndex).not.toHaveBeenCalled()
    expect(rebuildEmbeddings).not.toHaveBeenCalled()
  })

  it('prints "backfill" to stdout before invoking the adapter on first run', async () => {
    const { getPlatformLastSyncedAt } = await import('../src/db')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(null)

    const calls: string[] = []
    stdoutSpy.mockImplementation((s) => { calls.push(String(s)); return true })

    let printedBeforeCall = false
    const runBackfill = vi.fn().mockImplementation(async () => {
      printedBeforeCall = calls.includes('backfill\n')
    })
    const adapter: PlatformAdapter = { platform: 'telegram', runBackfill, startListener: vi.fn() }

    await runPlatformSync(adapter, db, [])

    expect(printedBeforeCall).toBe(true)
    expect(calls).toContain('backfill\n')
    expect(calls).not.toContain('incremental\n')
  })

  it('prints "incremental" to stdout before invoking syncIncremental', async () => {
    const { getPlatformLastSyncedAt } = await import('../src/db')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(Math.floor(Date.now() / 1000) - 3600)

    const calls: string[] = []
    stdoutSpy.mockImplementation((s) => { calls.push(String(s)); return true })

    let printedBeforeCall = false
    const syncIncremental = vi.fn().mockImplementation(async () => {
      printedBeforeCall = calls.includes('incremental\n')
    })
    const adapter: PlatformAdapter = {
      platform: 'telegram',
      runBackfill: vi.fn(),
      startListener: vi.fn(),
      syncIncremental,
    }

    await runPlatformSync(adapter, db, [])

    expect(printedBeforeCall).toBe(true)
    expect(calls).toContain('incremental\n')
    expect(calls).not.toContain('backfill\n')
  })

  it('does NOT write sync_state when the adapter throws', async () => {
    const { getPlatformLastSyncedAt, setPlatformLastSyncedAt } = await import('../src/db')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(null)

    const runBackfill = vi.fn().mockRejectedValue(new Error('adapter boom'))
    const adapter: PlatformAdapter = { platform: 'telegram', runBackfill, startListener: vi.fn() }

    await expect(runPlatformSync(adapter, db, [])).rejects.toThrow('adapter boom')
    expect(setPlatformLastSyncedAt).not.toHaveBeenCalled()
  })

  it('runStartedAt snapshot is taken before fetch (not after)', async () => {
    // Verify that the timestamp written is <= the time the adapter was called
    const { getPlatformLastSyncedAt, setPlatformLastSyncedAt } = await import('../src/db')
    vi.mocked(getPlatformLastSyncedAt).mockReturnValue(null)

    let adapterCallTime = 0
    const runBackfill = vi.fn().mockImplementation(async () => {
      adapterCallTime = Math.floor(Date.now() / 1000)
    })
    const adapter: PlatformAdapter = { platform: 'telegram', runBackfill, startListener: vi.fn() }

    await runPlatformSync(adapter, db, [])

    const [, ts] = vi.mocked(setPlatformLastSyncedAt).mock.calls[0]
    expect(ts).toBeLessThanOrEqual(adapterCallTime)
  })
})
