import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a fake child process. exitCode=0 means success; non-zero means failure.
 * The process resolves its 'close' event asynchronously so serial ordering can
 * be observed.
 */
function makeFakeChild(exitCode = 0): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  // Schedule the 'close' event to fire on the next microtask tick
  Promise.resolve().then(() => child.emit('close', exitCode))
  return child
}

// ── Mock child_process ─────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runAllPlatforms', () => {
  let spawnMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const cp = await import('child_process')
    spawnMock = vi.mocked(cp.spawn)
    spawnMock.mockImplementation(() => makeFakeChild(0))
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('spawns exactly 8 children, one per platform', async () => {
    const { runAllPlatforms } = await import('../src/sync-all')
    await runAllPlatforms([])
    expect(spawnMock).toHaveBeenCalledTimes(8)
  })

  it('spawns platforms in fixed serial order: telegram first, signal last', async () => {
    const order: string[] = []
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      // args[1] is the script path like 'src/platforms/<p>/sync.ts'
      const match = /platforms\/(\w+)\/sync\.ts/.exec(args[1] ?? '')
      if (match) order.push(match[1])
      return makeFakeChild(0)
    })

    const { runAllPlatforms } = await import('../src/sync-all')
    await runAllPlatforms([])

    expect(order[0]).toBe('telegram')
    expect(order[order.length - 1]).toBe('signal')
    expect(new Set(order).size).toBe(8) // all unique
  })

  it('forwards --force flag to all 8 children', async () => {
    const { runAllPlatforms } = await import('../src/sync-all')
    await runAllPlatforms(['--force'])

    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[]
      expect(args).toContain('--force')
    }
  })

  it('forwards --backfill flag to all 8 children', async () => {
    const { runAllPlatforms } = await import('../src/sync-all')
    await runAllPlatforms(['--backfill'])

    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[]
      expect(args).toContain('--backfill')
    }
  })

  it('adds --backfill-only to telegram child only', async () => {
    const { runAllPlatforms } = await import('../src/sync-all')
    await runAllPlatforms([])

    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[]
      const isTelegram = args.some(a => a.includes('telegram'))
      if (isTelegram) {
        expect(args).toContain('--backfill-only')
      } else {
        expect(args).not.toContain('--backfill-only')
      }
    }
  })

  it('continues to the next platform when one child fails (does not abort early)', async () => {
    let callCount = 0
    spawnMock.mockImplementation(() => {
      callCount++
      // fail on the first platform (telegram)
      return makeFakeChild(callCount === 1 ? 1 : 0)
    })

    const { runAllPlatforms } = await import('../src/sync-all')
    await runAllPlatforms([])

    // All 8 must have been spawned despite the first failing
    expect(spawnMock).toHaveBeenCalledTimes(8)
  })

  it('returns true (aggregate success) when all children exit 0', async () => {
    spawnMock.mockImplementation(() => makeFakeChild(0))

    const { runAllPlatforms } = await import('../src/sync-all')
    const anyFailed = await runAllPlatforms([])
    expect(anyFailed).toBe(false)
  })

  it('returns false (aggregate failure) when at least one child exits non-zero', async () => {
    let callCount = 0
    spawnMock.mockImplementation(() => {
      callCount++
      return makeFakeChild(callCount === 3 ? 2 : 0) // third platform fails
    })

    const { runAllPlatforms } = await import('../src/sync-all')
    const anyFailed = await runAllPlatforms([])
    expect(anyFailed).toBe(true)
  })

  it('logs a failure message when a child exits non-zero', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    spawnMock.mockImplementationOnce(() => makeFakeChild(1)) // telegram fails
      .mockImplementation(() => makeFakeChild(0))

    const { runAllPlatforms } = await import('../src/sync-all')
    await runAllPlatforms([])

    const messages = consoleSpy.mock.calls.map(c => String(c[0]))
    const hasFailMsg = messages.some(m => /telegram/i.test(m) && /\b1\b/.test(m))
    expect(hasFailMsg).toBe(true)
    consoleSpy.mockRestore()
  })
})
