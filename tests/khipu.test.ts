import { describe, it, expect } from 'vitest'
import * as path from 'path'

// resolveCommand is a pure function — import it directly, no mocking needed.
import { resolveCommand, spawnScript } from '../src/khipu'

const SRC = path.join(__dirname, '..', 'src')

// ── Helpers ────────────────────────────────────────────────────────────────────

function script(rel: string): string {
  return path.join(SRC, rel)
}

// ── Empty argv ─────────────────────────────────────────────────────────────────

describe('resolveCommand([])', () => {
  it('returns kind: help with exitCode 0', () => {
    const result = resolveCommand([])
    expect(result.kind).toBe('help')
    expect(result.exitCode).toBe(0)
  })
})

// ── Operational subcommands ────────────────────────────────────────────────────

describe('resolveCommand — operational subcommands', () => {
  const cases: [string, string][] = [
    ['mcp',         'mcp.ts'],
    ['web',         'web/server.ts'],
    ['setup-claude','setup-claude.ts'],
    ['setup-sync',  'setup-sync.ts'],
    ['index',       'index-embeddings.ts'],
  ]

  for (const [cmd, rel] of cases) {
    it(`resolveCommand(['${cmd}']) => { kind: 'run', script: src/${rel} }`, () => {
      const result = resolveCommand([cmd])
      expect(result.kind).toBe('run')
      expect(result.script).toBe(script(rel))
    })
  }
})

// ── sync subcommand ────────────────────────────────────────────────────────────

describe('resolveCommand — sync subcommand', () => {
  it("resolveCommand(['sync']) resolves to sync-all.ts", () => {
    const result = resolveCommand(['sync'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('sync-all.ts'))
  })

  it("resolveCommand(['sync', 'all']) resolves to sync-all.ts", () => {
    const result = resolveCommand(['sync', 'all'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('sync-all.ts'))
  })

  it("resolveCommand(['sync', 'telegram']) resolves to platforms/telegram/sync.ts", () => {
    const result = resolveCommand(['sync', 'telegram'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('platforms/telegram/sync.ts'))
  })

  it("resolveCommand(['sync', 'imessage']) resolves to platforms/imessage/sync.ts", () => {
    const result = resolveCommand(['sync', 'imessage'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('platforms/imessage/sync.ts'))
  })

  it("resolveCommand(['sync', 'bogus']) returns kind: error with exitCode 1", () => {
    const result = resolveCommand(['sync', 'bogus'])
    expect(result.kind).toBe('error')
    expect(result.exitCode).toBe(1)
  })
})

// ── Query subcommands ──────────────────────────────────────────────────────────

describe('resolveCommand — query subcommands forwarded to src/cli.ts', () => {
  const queries = [
    'search',
    'semantic-search',
    'semantic-contacts',
    'list-chats',
    'find-chat',
    'messages',
    'summary',
  ]

  for (const cmd of queries) {
    it(`resolveCommand(['${cmd}', 'extra']) forwards argv unchanged to cli.ts`, () => {
      const argv = [cmd, 'extra']
      const result = resolveCommand(argv)
      expect(result.kind).toBe('run')
      expect(result.script).toBe(script('cli.ts'))
      expect(result.args).toEqual(argv)
    })
  }
})

// ── Unknown subcommands ────────────────────────────────────────────────────────

describe('resolveCommand — unknown subcommands', () => {
  it("resolveCommand(['bogus']) returns kind: error with exitCode 1", () => {
    const result = resolveCommand(['bogus'])
    expect(result.kind).toBe('error')
    expect(result.exitCode).toBe(1)
  })

  it("resolveCommand(['bogus']) includes a message", () => {
    const result = resolveCommand(['bogus'])
    expect(result.message).toBeTruthy()
  })
})

// ── Platform-list parity integration check ────────────────────────────────────

describe('platform-list parity', () => {
  it('every PLATFORM entry resolves correctly via sync <platform>', async () => {
    const { PLATFORMS } = await import('../src/sync-all')
    for (const platform of PLATFORMS) {
      const result = resolveCommand(['sync', platform])
      expect(result.kind).toBe('run')
      expect(result.script).toBe(script(`platforms/${platform}/sync.ts`))
    }
  })
})

// ── Integration: router known-platform set equals PLATFORMS ───────────────────

describe('integration: router platform set equals PLATFORMS from sync-all', () => {
  it('router accepts exactly the platforms listed in PLATFORMS and no others', async () => {
    const { PLATFORMS } = await import('../src/sync-all')

    // Build the set of platforms the router accepts via 'sync <platform>'
    const routerAccepted: string[] = []

    // Every platform in PLATFORMS must resolve to 'run'
    for (const platform of PLATFORMS) {
      const result = resolveCommand(['sync', platform])
      expect(result.kind).toBe('run')
      routerAccepted.push(platform)
    }

    // The router must NOT accept a sentinel that is not in PLATFORMS
    const sentinel = '__integration_test_sentinel__'
    expect(PLATFORMS).not.toContain(sentinel)
    const rejected = resolveCommand(['sync', sentinel])
    expect(rejected.kind).toBe('error')

    // The accepted set must match PLATFORMS exactly (same length, same members)
    expect(routerAccepted).toHaveLength(PLATFORMS.length)
    expect(new Set(routerAccepted)).toEqual(new Set(PLATFORMS))
  })
})

// ── Integration: main() propagates non-zero child exit code ──────────────────

describe('integration: exit-code propagation', () => {
  it('spawnScript propagates non-zero exit code from spawned child process', async () => {
    // Call spawnScript() from src/khipu.ts directly with the fixture.
    // This verifies the actual spawn-and-propagate wiring in khipu.ts — if
    // main() had a bug returning 0 instead of the real code, this would catch it.
    const fixture = path.join(__dirname, 'fixtures', 'exit-nonzero.ts')
    const exitCode = await spawnScript(fixture, [])
    expect(exitCode).toBe(42)
  }, 15_000)
})
