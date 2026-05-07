import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { getDb, searchMessages, initDb, type Platform } from './db'
import { isClaudeConfigured } from './setup-claude'

// ── Result types ──────────────────────────────────────────────────────────────

export interface ChatResult {
  chat_id: number
  name: string
  type: string
  username: string | null
  message_count: number
  platform: Platform
}

export interface MessageResult {
  id: number
  sender_name: string | null
  text: string
  type: string
  timestamp: number
  is_sender: number
  platform: Platform
}

export interface SummaryResult {
  name: string
  type: string
  username: string | null
  message_count: number
  first_message_date: number | null
  last_message_date: number | null
  last_5_texts: string[]
  platform: Platform
}

// ── Tool handlers (exported for testing) ─────────────────────────────────────

export function handleListChats(platform?: Platform, limit = 200): ChatResult[] {
  const platformClause = platform !== undefined ? 'WHERE c.platform = ?' : ''
  const args = platform !== undefined ? [platform, limit] : [limit]
  return getDb().prepare(`
    SELECT c.id AS chat_id, c.name, c.type, c.username, c.platform,
           COUNT(m.id) AS message_count
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    ${platformClause}
    GROUP BY c.id
    ORDER BY MAX(m.timestamp) DESC NULLS LAST
    LIMIT ?
  `).all(...args) as ChatResult[]
}

export function handleFindChatByName(name: string, platform?: Platform): ChatResult[] {
  const pattern = `%${name}%`
  const platformClause = platform !== undefined ? 'AND c.platform = ?' : ''
  const args = platform !== undefined ? [pattern, pattern, platform] : [pattern, pattern]
  return getDb().prepare(`
    SELECT c.id AS chat_id, c.name, c.type, c.username, c.platform,
           COUNT(m.id) AS message_count
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE (LOWER(c.name) LIKE LOWER(?) OR LOWER(c.username) LIKE LOWER(?)) ${platformClause}
    GROUP BY c.id
    ORDER BY message_count DESC
  `).all(...args) as ChatResult[]
}

export function handleListMessages(
  chatId: number,
  limit = 50,
  beforeTimestamp?: number,
): MessageResult[] {
  const cap = Math.min(limit, 200)
  if (beforeTimestamp !== undefined) {
    return getDb().prepare(`
      SELECT id, sender_name, text, type, timestamp, is_sender, platform FROM (
        SELECT id, sender_name, text, type, timestamp, is_sender, platform
        FROM messages
        WHERE chat_id = ? AND type = 'text' AND text IS NOT NULL AND text != ''
          AND timestamp < ?
        ORDER BY timestamp DESC LIMIT ?
      ) ORDER BY timestamp ASC
    `).all(chatId, beforeTimestamp, cap) as MessageResult[]
  }
  // No beforeTimestamp: return the N most recent messages in chronological order.
  return getDb().prepare(`
    SELECT id, sender_name, text, type, timestamp, is_sender, platform FROM (
      SELECT id, sender_name, text, type, timestamp, is_sender, platform
      FROM messages
      WHERE chat_id = ? AND type = 'text' AND text IS NOT NULL AND text != ''
      ORDER BY timestamp DESC LIMIT ?
    ) ORDER BY timestamp ASC
  `).all(chatId, cap) as MessageResult[]
}

export function handleSearchMessages(query: string, chatId?: number, platform?: Platform) {
  return searchMessages(query, chatId, platform)
}

export function handleGetChatSummary(chatId: number): SummaryResult {
  const row = getDb().prepare(`
    SELECT c.name, c.type, c.username, c.platform,
           COUNT(m.id) AS message_count,
           MIN(m.timestamp) AS first_message_date,
           MAX(m.timestamp) AS last_message_date
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(chatId) as {
    name: string; type: string; username: string | null; platform: Platform
    message_count: number; first_message_date: number | null; last_message_date: number | null
  } | undefined

  if (!row) throw new Error(`Chat ${chatId} not found`)

  const texts = getDb().prepare(`
    SELECT text FROM messages
    WHERE chat_id = ? AND type = 'text' AND text IS NOT NULL AND text != ''
    ORDER BY timestamp DESC LIMIT 5
  `).all(chatId).map((r) => (r as { text: string }).text).reverse()

  return { ...row, last_5_texts: texts }
}

// ── MCP server ────────────────────────────────────────────────────────────────

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'khipuchat', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'list_chats', description: 'List all synced chats sorted by most recent activity. Use this to discover available chats before querying messages.', inputSchema: { type: 'object', properties: { platform: { type: 'string', description: 'Filter by platform: telegram, imessage, discord, slack, whatsapp' }, limit: { type: 'number', description: 'Max chats to return (default 200)' } } } },
      { name: 'find_chat_by_name', description: 'Find chats by name or username', inputSchema: { type: 'object', properties: { name: { type: 'string' }, platform: { type: 'string' } }, required: ['name'] } },
      { name: 'list_messages', description: 'List text messages in a chat', inputSchema: { type: 'object', properties: { chat_id: { type: 'number' }, limit: { type: 'number' }, before_timestamp: { type: 'number' } }, required: ['chat_id'] } },
      { name: 'search_messages', description: 'Full-text search across messages', inputSchema: { type: 'object', properties: { query: { type: 'string' }, chat_id: { type: 'number' }, platform: { type: 'string' } }, required: ['query'] } },
      { name: 'get_chat_summary', description: 'Get summary and recent texts for a chat', inputSchema: { type: 'object', properties: { chat_id: { type: 'number' } }, required: ['chat_id'] } },
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
    let result: unknown
    if (name === 'list_chats')
      result = handleListChats(platform, args['limit'] !== undefined ? Number(args['limit']) : undefined)
    else if (name === 'find_chat_by_name')
      result = handleFindChatByName(String(args['name']), platform)
    else if (name === 'list_messages')
      result = handleListMessages(Number(args['chat_id']), args['limit'] !== undefined ? Number(args['limit']) : undefined, args['before_timestamp'] !== undefined ? Number(args['before_timestamp']) : undefined)
    else if (name === 'search_messages')
      result = handleSearchMessages(String(args['query']), args['chat_id'] !== undefined ? Number(args['chat_id']) : undefined, platform)
    else if (name === 'get_chat_summary')
      result = handleGetChatSummary(Number(args['chat_id']))
    else throw new Error(`Unknown tool: ${name}`)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })

  return server
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbPath = require('path').join(__dirname, '..', 'telegram.db')
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
