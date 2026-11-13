import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { initDb } from './db'
import { isClaudeConfigured } from './setup-claude'
import { TOOL_DEFINITIONS, dispatchTool, toToolContent } from './tool-registry'

export {
  parseTemporalFilters,
  handleListChats,
  handleFindChatByName,
  handleListMessages,
  handleListArchiveMessages,
  handleSearchMessages,
  handleGetChatSummary,
  handleSemanticFindContacts,
  handleSemanticSearchMessages,
  type ChatResult,
  type MessageResult,
  type SummaryResult,
} from './query-handlers'

export { handleGetImage, type GetImageResult } from './image-handlers'

// ── MCP server ────────────────────────────────────────────────────────────────

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'khipuchat', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const secret = process.env['MCP_SECRET']
    if (secret) {
      const meta = (req.params as { _meta?: { authorization?: string } })._meta
      if (meta?.authorization !== `Bearer ${secret}`) {
        return { error: { code: -32001, message: 'Unauthorized' } }
      }
    }
    const { name, arguments: a = {} } = req.params
    const result = await dispatchTool(name, a as Record<string, unknown>)
    return toToolContent(result)
  })

  return server
}

// ── Entry point ───────────────────────────────────────────────────────────────

type RemoteRunnerModule = typeof import('./remote-mcp/runner')

export interface McpMainDeps {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  /** Loads the remote runner on demand so stdio never loads the HTTP stack. */
  readonly loadRunner: () => Promise<Pick<RemoteRunnerModule, 'runRemoteMcp'>>
  readonly runStdio: (dbPath: string) => Promise<void>
  /** Loads the project .env into process.env (existing variables win), as other entrypoints do. */
  readonly loadEnvFile: () => void
}

/** `--http` selects the remote MCP endpoint (Req 1.1); anything else stays stdio (Req 1.2). */
export function selectMcpMode(argv: readonly string[]): 'http' | 'stdio' {
  return argv.includes('--http') ? 'http' : 'stdio'
}

/** Arguments other than `--http` are rejected, so a typo never silently falls back to stdio. */
export function unknownMcpArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== '--http')
}

export async function main(deps: McpMainDeps = defaultMainDeps()): Promise<void> {
  const dbPath = require('path').join(__dirname, '..', 'khipuchat.db')
  const unknown = unknownMcpArgs(deps.argv)
  if (unknown.length > 0) {
    process.stderr.write(`khipu mcp: unknown argument ${JSON.stringify(unknown[0])}. Usage: khipu mcp [--http]\n`)
    process.exitCode = 2
    return
  }
  if (selectMcpMode(deps.argv) === 'http') {
    deps.loadEnvFile()
    const { runRemoteMcp } = await deps.loadRunner()
    process.exitCode = await runRemoteMcp({ env: deps.env, dbPath })
    return
  }
  await deps.runStdio(dbPath)
}

function defaultMainDeps(): McpMainDeps {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    loadRunner: () => import('./remote-mcp/runner'),
    runStdio,
    loadEnvFile: () => {
      require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
    },
  }
}

async function runStdio(dbPath: string): Promise<void> {
  initDb(dbPath)
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  if (isClaudeConfigured()) {
    process.stderr.write([
      '',
      '  khipuchat MCP server running.',
      '  Ask Claude: "Use khipuchat to find chat Tony Lin and show me the last 20 messages"',
      '',
    ].join('\n'))
  } else {
    process.stderr.write([
      '',
      '  khipuchat MCP server running, but Claude Desktop is not configured yet.',
      '  Run: npm run setup-claude',
      '',
    ].join('\n'))
  }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
