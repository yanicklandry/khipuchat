import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import { createRemoteMcpServer } from '../src/remote-mcp/session'
import type { AuditEvent, RemoteMcpAudit } from '../src/remote-mcp/audit'
import type { RemoteMcpClient } from '../src/remote-mcp/config'
import * as registry from '../src/tool-registry'

// Wrap dispatchTool in a spy that still runs the real registry, so tests can
// prove a denied call never reaches dispatch.
vi.mock('../src/tool-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tool-registry')>()
  return { ...actual, dispatchTool: vi.fn(actual.dispatchTool) }
})

const T = 1700000000

function seed(): void {
  const tony = upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: 'tonylin', platform: 'telegram' })
  const work = upsertChat({ external_id: '2', account: 'default', name: 'Work Group', type: 'group', username: null, platform: 'telegram' })
  const base = { sender_id: '999', sender_name: 'Tony', is_sender: 0, reply_to_external_id: null, platform: 'telegram' } as const
  insertMessage({ ...base, external_id: '1', chat_id: tony, text: 'hello there', type: 'text', timestamp: T + 1 })
  insertMessage({ ...base, external_id: '2', chat_id: work, text: 'standup at nine', type: 'text', timestamp: T + 2 })
  rebuildFtsIndex()
}

function makeClient(tools: readonly string[]): RemoteMcpClient {
  return { name: 'muse', setting: 'MCP_TOKEN_MUSE', tokenDigest: Buffer.alloc(32), tools: new Set(tools), allowlisted: true }
}

function captureAudit(): { audit: RemoteMcpAudit; events: AuditEvent[] } {
  const events: AuditEvent[] = []
  return { audit: { record: (e) => { events.push(e) } }, events }
}

let mcpClient: Client

async function connect(client: RemoteMcpClient, audit: RemoteMcpAudit): Promise<Client> {
  const server = createRemoteMcpServer(client, audit)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  mcpClient = new Client({ name: 'session-test', version: '0.0.0' })
  await mcpClient.connect(clientSide)
  return mcpClient
}

async function callError(c: Client, name: string, args: Record<string, unknown> = {}): Promise<McpError> {
  try {
    await c.callTool({ name, arguments: args })
  } catch (err) {
    if (err instanceof McpError) return err
    throw err
  }
  throw new Error(`expected ${name} to fail`)
}

const dispatchSpy = vi.mocked(registry.dispatchTool)

beforeEach(() => {
  initDb(':memory:')
  seed()
  dispatchSpy.mockClear()
})

afterEach(async () => {
  await mcpClient?.close()
})

describe('createRemoteMcpServer: tools/list', () => {
  it('lists only the client tools, in registry order, with definitions unchanged', async () => {
    const { audit } = captureAudit()
    const c = await connect(makeClient(['get_image', 'list_chats', 'search_messages']), audit)
    const { tools } = await c.listTools()
    const expected = registry.TOOL_DEFINITIONS.filter((t) => ['list_chats', 'search_messages', 'get_image'].includes(t.name))
    expect(tools.map((t) => t.name)).toEqual(['list_chats', 'search_messages', 'get_image'])
    expect(tools).toEqual(expected)
  })

  it('lists every registry tool for a client with all tools', async () => {
    const { audit } = captureAudit()
    const c = await connect(makeClient(registry.TOOL_DEFINITIONS.map((t) => t.name)), audit)
    const { tools } = await c.listTools()
    expect(tools).toEqual([...registry.TOOL_DEFINITIONS])
  })
})

describe('createRemoteMcpServer: tools/call', () => {
  it('denies a registry tool outside the client set without dispatching', async () => {
    const { audit, events } = captureAudit()
    const c = await connect(makeClient(['list_chats']), audit)
    const err = await callError(c, 'search_messages', { query: 'hello' })
    expect(err.code).toBe(ErrorCode.InvalidParams)
    expect(err.message).toContain('Tool not available')
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(events).toEqual([{ op: 'tools/call', client: 'muse', tool: 'search_messages', outcome: 'denied', ms: expect.any(Number) }])
  })

  it('denies a name that is not a tool without dispatching', async () => {
    const { audit, events } = captureAudit()
    const c = await connect(makeClient(['list_chats']), audit)
    const err = await callError(c, 'drop_all_tables')
    expect(err.code).toBe(ErrorCode.InvalidParams)
    expect(err.message).toContain('Tool not available')
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ op: 'tools/call', tool: 'drop_all_tables', outcome: 'denied' })
  })

  it('returns content identical to the shared formatter for a permitted call and audits ok', async () => {
    const { audit, events } = captureAudit()
    const c = await connect(makeClient(['list_chats', 'search_messages']), audit)
    const result = await c.callTool({ name: 'search_messages', arguments: { query: 'hello' } })
    const expected = registry.toToolContent(await registry.dispatchTool('search_messages', { query: 'hello' }))
    expect(result.content).toEqual(expected.content)
    expect(result.isError).toBeUndefined()
    expect(expected.content[0]?.text).toContain('hello there')
    expect(dispatchSpy).toHaveBeenCalledWith('search_messages', { query: 'hello' })
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev).toMatchObject({ op: 'tools/call', client: 'muse', tool: 'search_messages', outcome: 'ok' })
    expect(ev?.op === 'tools/call' && ev.ms >= 0).toBe(true)
  })

  it('passes an empty argument object when the call has no arguments', async () => {
    const { audit } = captureAudit()
    const c = await connect(makeClient(['list_chats']), audit)
    const result = await c.callTool({ name: 'list_chats' })
    expect(dispatchSpy).toHaveBeenCalledWith('list_chats', {})
    expect(result.content).toEqual(registry.toToolContent(await registry.dispatchTool('list_chats', {})).content)
  })

  it('returns a generic Tool failed error for a throwing dispatch and audits error and tool-error', async () => {
    const { audit, events } = captureAudit()
    const c = await connect(makeClient(['get_image']), audit)
    const err = await callError(c, 'get_image', { message_id: 424242 })
    expect(err.code).toBe(ErrorCode.InternalError)
    expect(err.message).toContain('Tool failed')
    expect(err.message).not.toContain('424242')
    expect(err.message).not.toContain('not found')
    expect(err.data).toBeUndefined()
    expect(events).toEqual([
      { op: 'tools/call', client: 'muse', tool: 'get_image', outcome: 'error', ms: expect.any(Number) },
      { op: 'tool-error', client: 'muse', tool: 'get_image', message: 'Error' },
    ])
  })

  it('keeps serving after a failed call', async () => {
    const { audit } = captureAudit()
    const c = await connect(makeClient(['get_image', 'list_chats']), audit)
    await callError(c, 'get_image', { message_id: 1 + 424242 })
    const result = await c.callTool({ name: 'list_chats', arguments: {} })
    expect(result.content).toEqual(registry.toToolContent(await registry.dispatchTool('list_chats', {})).content)
  })
})
