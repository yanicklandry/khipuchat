import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { getDb, searchMessages, initDb } from './db'

// ── Result types ──────────────────────────────────────────────────────────────

export interface ChatResult {
  chat_id: number
  name: string
  type: string
  username: string | null
  message_count: number
}

export interface MessageResult {
  id: number
  sender_name: string | null
  text: string
  type: string
  timestamp: number
  is_sender: number
}

export interface SummaryResult {
  name: string
  type: string
  username: string | null
  message_count: number
  first_message_date: number | null
  last_message_date: number | null
  last_5_texts: string[]
}

// ── Tool handlers (exported for testing) ─────────────────────────────────────

export function handleFindChatByName(name: string): ChatResult[] {
  const pattern = `%${name}%`
  return getDb().prepare(`
    SELECT c.id AS chat_id, c.name, c.type, c.username,
           COUNT(m.id) AS message_count
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE LOWER(c.name) LIKE LOWER(?) OR LOWER(c.username) LIKE LOWER(?)
    GROUP BY c.id
    ORDER BY message_count DESC
  `).all(pattern, pattern) as ChatResult[]
}

export function handleListMessages(
  chatId: number,
  limit = 50,
  beforeTimestamp?: number,
): MessageResult[] {
  const cap = Math.min(limit, 200)
  if (beforeTimestamp !== undefined) {
    return getDb().prepare(`
      SELECT id, sender_name, text, type, timestamp, is_sender
      FROM messages
      WHERE chat_id = ? AND type = 'text' AND text IS NOT NULL AND text != ''
        AND timestamp < ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(chatId, beforeTimestamp, cap) as MessageResult[]
  }
  return getDb().prepare(`
    SELECT id, sender_name, text, type, timestamp, is_sender
    FROM messages
    WHERE chat_id = ? AND type = 'text' AND text IS NOT NULL AND text != ''
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(chatId, cap) as MessageResult[]
}

export function handleSearchMessages(query: string, chatId?: number) {
  return searchMessages(query, chatId)
}

export function handleGetChatSummary(chatId: number): SummaryResult {
  const row = getDb().prepare(`
    SELECT c.name, c.type, c.username,
           COUNT(m.id) AS message_count,
           MIN(m.timestamp) AS first_message_date,
           MAX(m.timestamp) AS last_message_date
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(chatId) as {
    name: string; type: string; username: string | null
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
    { name: 'telegram-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'find_chat_by_name', description: 'Find chats by name or username', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      { name: 'list_messages', description: 'List text messages in a chat', inputSchema: { type: 'object', properties: { chat_id: { type: 'number' }, limit: { type: 'number' }, before_timestamp: { type: 'number' } }, required: ['chat_id'] } },
      { name: 'search_messages', description: 'Full-text search across messages', inputSchema: { type: 'object', properties: { query: { type: 'string' }, chat_id: { type: 'number' } }, required: ['query'] } },
      { name: 'get_chat_summary', description: 'Get summary and recent texts for a chat', inputSchema: { type: 'object', properties: { chat_id: { type: 'number' } }, required: ['chat_id'] } },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a = {} } = req.params
    const args = a as Record<string, unknown>
    let result: unknown
    if (name === 'find_chat_by_name') result = handleFindChatByName(String(args['name']))
    else if (name === 'list_messages') result = handleListMessages(Number(args['chat_id']), args['limit'] !== undefined ? Number(args['limit']) : undefined, args['before_timestamp'] !== undefined ? Number(args['before_timestamp']) : undefined)
    else if (name === 'search_messages') result = handleSearchMessages(String(args['query']), args['chat_id'] !== undefined ? Number(args['chat_id']) : undefined)
    else if (name === 'get_chat_summary') result = handleGetChatSummary(Number(args['chat_id']))
    else throw new Error(`Unknown tool: ${name}`)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })

  return server
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initDb('./telegram.db')
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
