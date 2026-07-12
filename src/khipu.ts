import { spawn } from 'child_process'
import * as path from 'path'
import { PLATFORMS } from './sync-all'
import { loadRegistry } from './account-registry'
import type { Platform } from './db'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CommandResolution {
  readonly kind: 'run' | 'help' | 'error'
  readonly script?: string
  readonly args?: readonly string[]
  readonly message?: string
  readonly exitCode?: number
}

export interface ResolveDeps {
  /** Configured account names for a platform; defaults to a loadRegistry-backed impl. */
  listAccounts(platform: string): readonly string[]
}

// ── Constants ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, '..')
const TSX_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
const SRC = path.join(PROJECT_ROOT, 'src')

// Operational subcommand => relative script path (from src/)
const OPERATIONAL_SCRIPTS: Record<string, string> = {
  'mcp':          'mcp.ts',
  'web':          'web/server.ts',
  'setup-claude': 'setup-claude.ts',
  'setup-sync':   'setup-sync.ts',
  'index':        'index-embeddings.ts',
}

// Query subcommands forwarded wholesale to src/cli.ts
const QUERY_COMMANDS = new Set([
  'search',
  'semantic-search',
  'semantic-contacts',
  'list-chats',
  'find-chat',
  'messages',
  'summary',
])

const PLATFORM_SET = new Set<string>(PLATFORMS)

// ── Help text ─────────────────────────────────────────────────────────────────

const USAGE = `
Usage: khipu <command> [args]

Operational commands:
  mcp                        Start the MCP server (stdio)
  web                        Start the web UI (port 3333)
  sync                       Show sync status for all platforms
  sync all [--once] [--force] Run the sync daemon
  sync <platform>[@account]  Sync a specific platform or account
  setup-claude               Run Claude Desktop setup
  setup-sync                 Run sync setup
  index                      Index embeddings

Query commands:
  search <query>   Keyword search (use --help for options)
  list chats       List all chats (use --help for options)
  list messages    List archive messages (use --help for options)
`.trim()

const SUBCOMMAND_USAGE: Record<string, string> = {
  search: `Usage: khipu search <query> [options]

Options:
  --platform <p>    Filter by platform (${PLATFORMS.join(', ')})
  --account <a>     Filter by account name
  --since <date>    Filter since date (YYYY-MM-DD)
  --until <date>    Filter until date (YYYY-MM-DD)
  --type <t>        Filter by message type
  --limit <n>       Max results (default 100)`.trim(),

  list: `Usage: khipu list <chats|messages> [options]

Subcommands:
  chats      List all chats
  messages   List messages from the archive

Options:
  --platform <p>    Filter by platform
  --account <a>     Filter by account name
  --since <date>    Filter since date (YYYY-MM-DD)
  --until <date>    Filter until date (YYYY-MM-DD)
  --type <t>        Filter by type
  --limit <n>       Max results (default 50)`.trim(),

  sync: `Usage: khipu sync [all | <platform>[@<account>]] [options]

Subcommands:
  (none)             Show sync status for all configured platforms
  all                Run the sync daemon (all platforms, all accounts)
  <platform>         Sync a single platform (${PLATFORMS.join(', ')})
  <platform>@<acct>  Sync a specific account on a platform

Options:
  --once   Run one pass and exit (with sync all)
  --force  Full re-read + embeddings rebuild`.trim(),
}

// ── Pure resolver ─────────────────────────────────────────────────────────────

export function resolveCommand(argv: readonly string[], deps?: ResolveDeps): CommandResolution {
  const [sub, ...subRest] = argv

  // No subcommand or root help flag
  if (!sub || sub === '--help' || sub === '-h') {
    return { kind: 'help', message: USAGE, exitCode: 0 }
  }

  // Per-subcommand --help: detect -h/--help as first arg after subcommand
  const isHelpFlag = subRest[0] === '--help' || subRest[0] === '-h'
  if (isHelpFlag) {
    const subUsage = SUBCOMMAND_USAGE[sub]
    if (subUsage) {
      return { kind: 'help', message: subUsage, exitCode: 0 }
    }
    // Unknown subcommand + --help => error
    return { kind: 'error', message: `Unknown command: "${sub}".\n\n${USAGE}`, exitCode: 1 }
  }

  const arg = subRest[0]

  // Operational subcommand
  const opScript = OPERATIONAL_SCRIPTS[sub]
  if (opScript) {
    return {
      kind: 'run',
      script: path.join(SRC, opScript),
      args: argv.slice(1),
    }
  }

  // sync subcommand
  if (sub === 'sync') {
    if (!arg) {
      return {
        kind: 'run',
        script: path.join(SRC, 'khipu-sync-status.ts'),
        args: [],
      }
    }
    if (arg === 'all') {
      return {
        kind: 'run',
        script: path.join(SRC, 'watch.ts'),
        args: argv.slice(2),
      }
    }
    if (arg.includes('@')) {
      const atIdx = arg.indexOf('@')
      const platform = arg.slice(0, atIdx)
      const account = arg.slice(atIdx + 1)
      const rest = argv.slice(2)

      if (!PLATFORM_SET.has(platform)) {
        return {
          kind: 'error',
          message: `Unknown platform: "${platform}". Known platforms: ${PLATFORMS.join(', ')}`,
          exitCode: 1,
        }
      }

      const configuredAccounts = deps?.listAccounts(platform) ?? []
      if (!configuredAccounts.includes(account)) {
        return {
          kind: 'error',
          message: `Account "${account}" is not configured for platform "${platform}"`,
          exitCode: 1,
        }
      }

      return {
        kind: 'run',
        script: path.join(SRC, 'platforms', platform, 'sync.ts'),
        args: ['--account', account, ...rest],
      }
    }

    if (PLATFORM_SET.has(arg)) {
      return {
        kind: 'run',
        script: path.join(SRC, 'platforms', arg, 'sync.ts'),
        args: argv.slice(2),
      }
    }
    return {
      kind: 'error',
      message: `Unknown platform: "${arg}". Known platforms: ${PLATFORMS.join(', ')}`,
      exitCode: 1,
    }
  }

  // list subcommand
  if (sub === 'list') {
    return {
      kind: 'run',
      script: path.join(SRC, 'khipu-list.ts'),
      args: argv.slice(1),
    }
  }

  // Query subcommands forwarded to cli.ts with full argv unchanged
  if (QUERY_COMMANDS.has(sub)) {
    return {
      kind: 'run',
      script: path.join(SRC, 'cli.ts'),
      args: argv,
    }
  }

  return {
    kind: 'error',
    message: `Unknown command: "${sub}".\n\n${USAGE}`,
    exitCode: 1,
  }
}

// ── Impure entry ──────────────────────────────────────────────────────────────

export function spawnScript(script: string, args: readonly string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [TSX_BIN, script, ...args], {
      stdio: 'inherit',
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export function main(argv: readonly string[]): Promise<number> {
  const deps: ResolveDeps = {
    listAccounts: (platform) => loadRegistry().listAccounts(platform as Platform),
  }
  const resolution = resolveCommand(argv, deps)

  if (resolution.kind === 'help') {
    console.log(resolution.message)
    return Promise.resolve(resolution.exitCode ?? 0)
  }

  if (resolution.kind === 'error') {
    console.error(resolution.message)
    return Promise.resolve(resolution.exitCode ?? 1)
  }

  const { script, args = [] } = resolution
  return spawnScript(script!, args)
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code)
  })
}
