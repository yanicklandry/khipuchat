import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { initDb } from './db'
import { isClaudeConfigured } from './setup-claude'
import { TOOL_DEFINITIONS, dispatchTool } from './tool-registry'

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
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })

  return server
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbPath = require('path').join(__dirname, '..', 'khipuchat.db')
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
