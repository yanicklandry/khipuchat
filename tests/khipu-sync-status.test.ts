import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Platform } from '../src/db'
import type { AccountRegistry } from '../src/account-registry'

// We import printSyncStatus dynamically after mocking console.log
import { printSyncStatus } from '../src/khipu-sync-status'

describe('printSyncStatus', () => {
  let logLines: string[]

  beforeEach(() => {
    logLines = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeRegistry(map: Partial<Record<Platform, string[]>>): AccountRegistry {
    return {
      listAccounts(platform: Platform): readonly string[] {
        return map[platform] ?? []
      },
      credentialsFor(_platform: Platform, _account: string) {
        throw new Error('not needed in tests')
      },
    }
  }

  it('omits platforms with no configured accounts', () => {
    const registry = makeRegistry({ telegram: ['alice'] })
    const getLastSynced = (_p: Platform, _a: string): number | null => null

    printSyncStatus(registry, getLastSynced)

    const output = logLines.join('\n')
    // imessage, wechat, etc. have no accounts — should not appear
    expect(output).not.toContain('imessage')
    expect(output).not.toContain('wechat')
    expect(output).not.toContain('discord')
    expect(output).not.toContain('slack')
    expect(output).not.toContain('email')
    expect(output).not.toContain('whatsapp')
  })

  it('shows platforms that have configured accounts', () => {
    const registry = makeRegistry({ telegram: ['alice'], discord: ['bot'] })
    const getLastSynced = (_p: Platform, _a: string): number | null => null

    printSyncStatus(registry, getLastSynced)

    const output = logLines.join('\n')
    expect(output).toContain('telegram')
    expect(output).toContain('alice')
    expect(output).toContain('discord')
    expect(output).toContain('bot')
  })

  it('shows "never" for accounts that have never been synced (null timestamp)', () => {
    const registry = makeRegistry({ telegram: ['alice'] })
    const getLastSynced = (_p: Platform, _a: string): number | null => null

    printSyncStatus(registry, getLastSynced)

    const output = logLines.join('\n')
    expect(output).toContain('never')
  })

  it('shows a formatted date string for accounts with a sync timestamp', () => {
    const registry = makeRegistry({ telegram: ['alice'] })
    // Unix timestamp for 2024-01-15 12:00:00 UTC
    const fixedTs = 1705320000
    const getLastSynced = (_p: Platform, _a: string): number | null => fixedTs

    printSyncStatus(registry, getLastSynced)

    const output = logLines.join('\n')
    // Should NOT show 'never'
    expect(output).not.toContain('never')
    // Should show some date/time string (locale-dependent, but not raw number)
    expect(output).toContain('alice')
    // The formatted string should be a non-empty, non-"never" string
    const aliceLine = logLines.find(l => l.includes('alice'))
    expect(aliceLine).toBeDefined()
    expect(aliceLine).not.toMatch(/alice:\s*$/)
    expect(aliceLine).not.toContain('never')
  })

  it('handles multiple accounts on the same platform', () => {
    const registry = makeRegistry({ slack: ['workspace-a', 'workspace-b'] })
    const syncMap: Record<string, number | null> = {
      'workspace-a': 1705320000,
      'workspace-b': null,
    }
    const getLastSynced = (_p: Platform, account: string): number | null =>
      syncMap[account] ?? null

    printSyncStatus(registry, getLastSynced)

    const output = logLines.join('\n')
    expect(output).toContain('slack')
    expect(output).toContain('workspace-a')
    expect(output).toContain('workspace-b')
    // workspace-b has no sync => 'never'
    const bLine = logLines.find(l => l.includes('workspace-b'))
    expect(bLine).toContain('never')
    // workspace-a has a timestamp => not 'never'
    const aLine = logLines.find(l => l.includes('workspace-a'))
    expect(aLine).not.toContain('never')
  })

  it('outputs nothing when all platforms have no accounts', () => {
    const registry = makeRegistry({})
    const getLastSynced = (_p: Platform, _a: string): number | null => null

    printSyncStatus(registry, getLastSynced)

    expect(logLines).toHaveLength(0)
  })
})
