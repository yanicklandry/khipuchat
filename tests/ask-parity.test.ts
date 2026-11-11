import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import { handleSearchMessages, handleListChats } from '../src/query-handlers'
import { TOOL_DEFINITIONS, dispatchTool } from '../src/tool-registry'
import { createMcpServer } from '../src/mcp'

// ── Seed (mirrors query-parity.test.ts) ───────────────────────────────────────

const T_2024 = 1704067200
const T_2025 = 1735689600
const T_MID = 1719792000

let ids: { tg1: number; tg2: number; imsg: number }

function seed(): void {
  const tg1 = upsertChat({ external_id: 'tg1', account: 'default', name: 'TelegramChat1', type: 'user', username: null, platform: 'telegram' })
  const imsg = upsertChat({ external_id: 'imsg1', account: 'default', name: 'iMessageChat', type: 'user', username: null, platform: 'imessage' })
  const tg2 = upsertChat({ external_id: 'tg2', account: 'account2', name: 'TelegramChat2', type: 'user', username: null, platform: 'telegram' })
  ids = { tg1, tg2, imsg }

  insertMessage({ external_id: 'tg1-t1', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello early 2024', type: 'text', timestamp: T_2024 + 100, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg1-t2', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello mid 2024', type: 'text', timestamp: T_MID, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'tg1-t3', chat_id: tg1, sender_id: '1', sender_name: 'Alice', text: 'hello early 2025', type: 'text', timestamp: T_2025 + 100, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
  insertMessage({ external_id: 'im1-t1', chat_id: imsg, sender_id: '2', sender_name: 'Bob', text: 'hello from imessage one', type: 'text', timestamp: T_2024 + 50, is_sender: 0, reply_to_external_id: null, platform: 'imessage' })
  insertMessage({ external_id: 'tg2-t1', chat_id: tg2, sender_id: '3', sender_name: 'Carol', text: 'hello from account2 one', type: 'text', timestamp: T_2024 + 200, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
}

beforeEach(() => {
  initDb(':memory:')
  seed()
  rebuildFtsIndex()
})

// ── dispatchTool == direct handler ────────────────────────────────────────────

describe('ask surface parity: dispatchTool mirrors direct handlers', () => {
  it('search_messages: dispatchTool deep-equals handleSearchMessages', async () => {
    const dispatched = await dispatchTool('search_messages', { query: 'hello', platform: 'telegram', limit: 3 })
    const direct = handleSearchMessages('hello', { platform: 'telegram', limit: 3 })
    expect(dispatched).toEqual(direct)
  })

  it('search_messages: unfiltered dispatch deep-equals direct handler', async () => {
    const dispatched = await dispatchTool('search_messages', { query: 'hello' })
    const direct = handleSearchMessages('hello')
    expect(dispatched).toEqual(direct)
  })

  it('list_chats: dispatchTool deep-equals handleListChats', async () => {
    const dispatched = await dispatchTool('list_chats', { platform: 'telegram' })
    const direct = handleListChats({ platform: 'telegram' })
    expect(dispatched).toEqual(direct)
  })

  it('list_chats: account filter dispatch deep-equals direct handler', async () => {
    const dispatched = await dispatchTool('list_chats', { account: 'account2' })
    const direct = handleListChats({ account: 'account2' })
    expect(dispatched).toEqual(direct)
  })

  it('unknown tool name rejects with an unknown-tool error', async () => {
    await expect(dispatchTool('nope', {})).rejects.toThrow(/Unknown tool: nope/)
  })
})

// ── Registry tool set == MCP tool set ─────────────────────────────────────────

type ListToolsResult = { tools: Array<{ name: string }> }

async function mcpToolNames(): Promise<Set<string>> {
  const server = createMcpServer()
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<ListToolsResult>>
  })._requestHandlers.get('tools/list')!
  const { tools } = await handler({ method: 'tools/list', params: {} })
  return new Set(tools.map((t) => t.name))
}

describe('ask surface parity: registry tool set equals MCP tool set', () => {
  it('TOOL_DEFINITIONS names match the MCP tools/list names', async () => {
    const registryNames = new Set(TOOL_DEFINITIONS.map((t) => t.name))
    const mcpNames = await mcpToolNames()
    expect(registryNames).toEqual(mcpNames)
  })

  it('advertises all eight archive tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(8)
  })
})
