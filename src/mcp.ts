import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { initDb, type Platform } from './db'
import { isClaudeConfigured } from './setup-claude'

export {
  parseTemporalFilters,
  handleListChats,
  handleFindChatByName,
  handleListMessages,
  handleSearchMessages,
  handleGetChatSummary,
  handleSemanticFindContacts,
  handleSemanticSearchMessages,
  type ChatResult,
  type MessageResult,
  type SummaryResult,
} from './query-handlers'

import {
  handleListChats,
  handleFindChatByName,
  handleListMessages,
  handleSearchMessages,
  handleGetChatSummary,
  handleSemanticFindContacts,
  handleSemanticSearchMessages,
} from './query-handlers'

// ── MCP server ────────────────────────────────────────────────────────────────

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'khipuchat', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'list_chats', description: 'List all synced chats sorted by most recent activity. Use this to discover available chats before querying messages.', inputSchema: { type: 'object', properties: { platform: { type: 'string', description: 'Filter by platform: telegram, imessage, discord, slack, whatsapp' }, account: { type: 'string', description: 'Filter results to a specific account name. Omit to return results from all accounts.' }, limit: { type: 'number', description: 'Max chats to return (default 200)' } } } },
      { name: 'find_chat_by_name', description: 'Find chats by name or username', inputSchema: { type: 'object', properties: { name: { type: 'string' }, platform: { type: 'string' }, account: { type: 'string', description: 'Filter results to a specific account name. Omit to return results from all accounts.' } }, required: ['name'] } },
      { name: 'list_messages', description: 'List text messages in a chat', inputSchema: { type: 'object', properties: { chat_id: { type: 'number' }, limit: { type: 'number' }, before_timestamp: { type: 'number' }, account: { type: 'string', description: 'Filter results to a specific account name. Omit to return results from all accounts.' } }, required: ['chat_id'] } },
      { name: 'search_messages', description: 'Full-text search across messages', inputSchema: { type: 'object', properties: { query: { type: 'string' }, chat_id: { type: 'number' }, platform: { type: 'string' }, account: { type: 'string', description: 'Filter results to a specific account name. Omit to return results from all accounts.' } }, required: ['query'] } },
      { name: 'get_chat_summary', description: 'Get summary and recent texts for a chat', inputSchema: { type: 'object', properties: { chat_id: { type: 'number' } }, required: ['chat_id'] } },
      { name: 'semantic_find_contacts', description: 'Find contacts by meaning (e.g. "old friend from Shanghai around 2019"). Requires khipu index first.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural-language description of the contact or relationship' }, limit: { type: 'number', description: 'Max results (default 10, max 50)' }, before: { type: 'number', description: 'Unix timestamp — restrict to chats last active before this date' }, after: { type: 'number', description: 'Unix timestamp — restrict to chats last active after this date' }, platform: { type: 'string', description: 'Filter by platform' }, account: { type: 'string', description: 'Filter results to a specific account name. Omit to return results from all accounts.' } }, required: ['query'] } },
      { name: 'semantic_search_messages', description: 'Search messages by meaning rather than exact keywords. Requires khipu index first.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural-language description of the message content' }, limit: { type: 'number', description: 'Max results (default 20, max 100)' }, chat_id: { type: 'number' }, platform: { type: 'string' }, before_timestamp: { type: 'number' }, after_timestamp: { type: 'number' }, account: { type: 'string', description: 'Filter results to a specific account name. Omit to return results from all accounts.' } }, required: ['query'] } },
    ],
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
    const args = a as Record<string, unknown>
    const platform = args['platform'] !== undefined ? String(args['platform']) as Platform : undefined
    const account = typeof args['account'] === 'string' ? args['account'] : undefined
    let result: unknown
    if (name === 'list_chats')
      result = handleListChats(platform, account, args['limit'] !== undefined ? Number(args['limit']) : undefined)
    else if (name === 'find_chat_by_name')
      result = handleFindChatByName(String(args['name']), platform, account)
    else if (name === 'list_messages')
      result = handleListMessages(Number(args['chat_id']), { limit: args['limit'] !== undefined ? Number(args['limit']) : undefined, before: args['before_timestamp'] !== undefined ? Number(args['before_timestamp']) : undefined, account })
    else if (name === 'search_messages')
      result = handleSearchMessages(String(args['query']), args['chat_id'] !== undefined ? Number(args['chat_id']) : undefined, platform, account)
    else if (name === 'get_chat_summary')
      result = handleGetChatSummary(Number(args['chat_id']))
    else if (name === 'semantic_find_contacts')
      result = await handleSemanticFindContacts(String(args['query']), {
        limit: args['limit'] !== undefined ? Number(args['limit']) : undefined,
        before: args['before'] !== undefined ? Number(args['before']) : undefined,
        after: args['after'] !== undefined ? Number(args['after']) : undefined,
        platform,
        account,
      })
    else if (name === 'semantic_search_messages')
      result = await handleSemanticSearchMessages(String(args['query']), {
        limit: args['limit'] !== undefined ? Number(args['limit']) : undefined,
        chat_id: args['chat_id'] !== undefined ? Number(args['chat_id']) : undefined,
        platform,
        before_timestamp: args['before_timestamp'] !== undefined ? Number(args['before_timestamp']) : undefined,
        after_timestamp: args['after_timestamp'] !== undefined ? Number(args['after_timestamp']) : undefined,
        account,
      })
    else throw new Error(`Unknown tool: ${name}`)
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
