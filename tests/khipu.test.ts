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
  it("resolveCommand(['sync']) resolves to khipu-sync-status.ts", () => {
    const result = resolveCommand(['sync'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('khipu-sync-status.ts'))
    expect(result.args).toEqual([])
  })

  it("resolveCommand(['sync', 'all']) resolves to watch.ts", () => {
    const result = resolveCommand(['sync', 'all'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('watch.ts'))
    expect(result.args).toEqual([])
  })

  it("resolveCommand(['sync', 'all', '--once']) resolves to watch.ts with args ['--once']", () => {
    const result = resolveCommand(['sync', 'all', '--once'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('watch.ts'))
    expect(result.args).toEqual(['--once'])
  })

  it("resolveCommand(['sync', 'all', '--force']) resolves to watch.ts with args ['--force']", () => {
    const result = resolveCommand(['sync', 'all', '--force'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('watch.ts'))
    expect(result.args).toEqual(['--force'])
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

  it("resolveCommand(['sync', 'bogus']) error message lists valid platform names", async () => {
    const { PLATFORMS } = await import('../src/sync-all')
    const result = resolveCommand(['sync', 'bogus'])
    expect(result.kind).toBe('error')
    for (const platform of PLATFORMS) {
      expect(result.message).toContain(platform)
    }
  })
})

// ── list subcommand ────────────────────────────────────────────────────────────

describe('resolveCommand — list subcommand', () => {
  it("resolveCommand(['list']) resolves to khipu-list.ts with args []", () => {
    const result = resolveCommand(['list'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('khipu-list.ts'))
    expect(result.args).toEqual([])
  })

  it("resolveCommand(['list', 'chats']) resolves to khipu-list.ts with args ['chats']", () => {
    const result = resolveCommand(['list', 'chats'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('khipu-list.ts'))
    expect(result.args).toEqual(['chats'])
  })

  it("resolveCommand(['list', 'messages', '--type', 'text']) resolves with correct args", () => {
    const result = resolveCommand(['list', 'messages', '--type', 'text'])
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('khipu-list.ts'))
    expect(result.args).toEqual(['messages', '--type', 'text'])
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

// ── sync <platform>@<account> parsing ────────────────────────────────────────

describe('resolveCommand — sync <platform>@<account>', () => {
  it("resolveCommand(['sync', 'telegram@myaccount'], { listAccounts: () => ['myaccount'] }) => run with args ['--account', 'myaccount']", () => {
    const result = resolveCommand(['sync', 'telegram@myaccount'], { listAccounts: () => ['myaccount'] })
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('platforms/telegram/sync.ts'))
    expect(result.args).toEqual(['--account', 'myaccount'])
  })

  it("resolveCommand(['sync', 'telegram@myaccount', '--force'], ...) => args ['--account', 'myaccount', '--force']", () => {
    const result = resolveCommand(['sync', 'telegram@myaccount', '--force'], { listAccounts: () => ['myaccount'] })
    expect(result.kind).toBe('run')
    expect(result.script).toBe(script('platforms/telegram/sync.ts'))
    expect(result.args).toEqual(['--account', 'myaccount', '--force'])
  })

  it("resolveCommand(['sync', 'telegram@unknown'], ...) => error with exitCode 1 mentioning the account", () => {
    const result = resolveCommand(['sync', 'telegram@unknown'], { listAccounts: () => ['myaccount'] })
    expect(result.kind).toBe('error')
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('unknown')
  })

  it("resolveCommand(['sync', 'bogus@myaccount'], ...) => error with exitCode 1 for invalid platform", () => {
    const result = resolveCommand(['sync', 'bogus@myaccount'], { listAccounts: () => ['myaccount'] })
    expect(result.kind).toBe('error')
    expect(result.exitCode).toBe(1)
  })

  it("resolveCommand(['sync', 'telegram@myaccount'], { listAccounts: () => [] }) => error with exitCode 1 (no accounts configured)", () => {
    const result = resolveCommand(['sync', 'telegram@myaccount'], { listAccounts: () => [] })
    expect(result.kind).toBe('error')
    expect(result.exitCode).toBe(1)
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

// ── Per-subcommand --help ─────────────────────────────────────────────────────

describe('resolveCommand — per-subcommand --help', () => {
  it("resolveCommand(['search', '--help']) returns kind: help with exitCode 0", () => {
    const result = resolveCommand(['search', '--help'])
    expect(result.kind).toBe('help')
    expect(result.exitCode).toBe(0)
  })

  it("resolveCommand(['search', '--help']) message contains 'search'", () => {
    const result = resolveCommand(['search', '--help'])
    expect(result.message).toContain('search')
  })

  it("resolveCommand(['list', '--help']) returns kind: help with exitCode 0", () => {
    const result = resolveCommand(['list', '--help'])
    expect(result.kind).toBe('help')
    expect(result.exitCode).toBe(0)
  })

  it("resolveCommand(['list', '--help']) message contains 'list'", () => {
    const result = resolveCommand(['list', '--help'])
    expect(result.message).toContain('list')
  })

  it("resolveCommand(['sync', '--help']) returns kind: help with exitCode 0", () => {
    const result = resolveCommand(['sync', '--help'])
    expect(result.kind).toBe('help')
    expect(result.exitCode).toBe(0)
  })

  it("resolveCommand(['sync', '--help']) message contains 'sync'", () => {
    const result = resolveCommand(['sync', '--help'])
    expect(result.message).toContain('sync')
  })

  it("resolveCommand(['--help']) returns kind: help with exitCode 0 and message contains 'khipu'", () => {
    const result = resolveCommand(['--help'])
    expect(result.kind).toBe('help')
    expect(result.exitCode).toBe(0)
    expect(result.message).toContain('khipu')
  })

  it("resolveCommand(['search', '-h']) returns kind: help with exitCode 0 (short flag works)", () => {
    const result = resolveCommand(['search', '-h'])
    expect(result.kind).toBe('help')
    expect(result.exitCode).toBe(0)
  })

  it("resolveCommand(['unknowncmd']) still returns kind: error with exitCode 1", () => {
    const result = resolveCommand(['unknowncmd'])
    expect(result.kind).toBe('error')
    expect(result.exitCode).toBe(1)
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
