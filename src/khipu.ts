import { spawn } from 'child_process'
import * as path from 'path'
import { PLATFORMS } from './sync-all'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CommandResolution {
  readonly kind: 'run' | 'help' | 'error'
  readonly script?: string
  readonly args?: readonly string[]
  readonly message?: string
  readonly exitCode?: number
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
  mcp                   Start the MCP server (stdio)
  web                   Start the web UI (port 3333)
  sync all              Sync all platforms
  sync <platform>       Sync a specific platform (${PLATFORMS.join(', ')})
  setup-claude          Run Claude Desktop setup
  setup-sync            Run sync setup
  index                 Index embeddings

Query commands (forwarded to cli.ts):
  search, semantic-search, semantic-contacts, list-chats,
  find-chat, messages, summary
`.trim()

// ── Pure resolver ─────────────────────────────────────────────────────────────

export function resolveCommand(argv: readonly string[]): CommandResolution {
  const [sub, arg] = argv

  if (!sub) {
    return { kind: 'help', message: USAGE, exitCode: 0 }
  }

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
    if (!arg || arg === 'all') {
      return {
        kind: 'run',
        script: path.join(SRC, 'sync-all.ts'),
        args: argv.slice(2),
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
  const resolution = resolveCommand(argv)

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
