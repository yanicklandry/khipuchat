import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import { createRemoteMcpApp } from '../src/remote-mcp/app'
import type { AuditEvent, RemoteMcpAudit } from '../src/remote-mcp/audit'
import { parseRemoteMcpConfig, type RemoteMcpConfig } from '../src/remote-mcp/config'
import { TOOL_DEFINITIONS } from '../src/tool-registry'

// End-to-end: the SDK Streamable HTTP client with a bearer header against the
// remote MCP app on an ephemeral port (Req 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.4,
// 6.1, 6.2, 6.3).

const FULL_TOKEN = 'full-token-0123456789abcdef0123456789'
const LIMITED_TOKEN = 'limited-token-0123456789abcdef01234567'
const WRONG_TOKEN = 'wrong-token-0123456789abcdef0123456789'
const SECRET_QUERY = 'zebraquokka7731'
const MISSING_ID = 987654321

function configFrom(env: NodeJS.ProcessEnv): RemoteMcpConfig {
  const result = parseRemoteMcpConfig(env, TOOL_DEFINITIONS.map((t) => t.name))
  if (!result.ok) throw new Error(`bad test config: ${result.error.kind}`)
  return result.config
}

function seed(): void {
  const chat = upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: 'tonylin', platform: 'telegram' })
  const base = { chat_id: chat, sender_id: '9', sender_name: 'Tony', is_sender: 0, reply_to_external_id: null, platform: 'telegram', type: 'text' } as const
  insertMessage({ ...base, external_id: '1', text: 'hello there', timestamp: 1700000001 })
  insertMessage({ ...base, external_id: '2', text: 'meeting at 3', timestamp: 1700000002 })
  rebuildFtsIndex()
}

let server: HttpServer
let url: URL
const events: AuditEvent[] = []
const open: Client[] = []

beforeAll(async () => {
  initDb(':memory:')
  seed()
  const audit: RemoteMcpAudit = { record: (e) => { events.push(e) } }
  const config = configFrom({
    MCP_TOKEN_FULL: FULL_TOKEN,
    MCP_TOKEN_LIMITED: LIMITED_TOKEN,
    MCP_TOOLS_LIMITED: 'list_chats,search_messages',
  })
  const app = createRemoteMcpApp({ config, audit, healthCheck: () => true })
  server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
})

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})))
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function newClient(token?: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const headers: Record<string, string> = token === undefined ? {} : { Authorization: `Bearer ${token}` }
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } })
  const client = new Client({ name: 'e2e', version: '0.0.0' })
  open.push(client)
  return { client, transport }
}

async function connected(token: string): Promise<Client> {
  const { client, transport } = newClient(token)
  await client.connect(transport)
  return client
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  expect(content[0]?.type).toBe('text')
  return content[0]?.text ?? ''
}

async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  try {
    await client.callTool({ name, arguments: args })
  } catch (err) {
    return err
  }
  throw new Error(`expected ${name} to fail`)
}

describe('remote MCP over HTTP with the SDK client', () => {
  it('unrestricted client initializes, lists every tool, and calls list_chats', async () => {
    const client = await connected(FULL_TOKEN)
    expect(client.getServerVersion()?.name).toBe('khipuchat')

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_DEFINITIONS.map((t) => t.name).sort())

    const result = await client.callTool({ name: 'list_chats', arguments: {} })
    expect(result.isError).not.toBe(true)
    const chats = JSON.parse(firstText(result)) as Array<{ name: string }>
    expect(chats.map((c) => c.name)).toContain('Tony Lin')
  })

  it('allowlisted client sees only its tools and is refused other and unknown tools', async () => {
    const client = await connected(LIMITED_TOKEN)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['list_chats', 'search_messages'])

    const search = await client.callTool({ name: 'search_messages', arguments: { query: SECRET_QUERY } })
    expect(search.isError).not.toBe(true)

    for (const name of ['get_chat_summary', 'no_such_tool']) {
      const err = await callError(client, name, { chat_id: 1 })
      expect(err).toBeInstanceOf(McpError)
      expect((err as McpError).message).toContain('Tool not available')
    }
  })

  it('a missing bearer token fails to connect with 401', async () => {
    const { client, transport } = newClient()
    const err = await client.connect(transport).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(StreamableHTTPError)
    expect((err as StreamableHTTPError).code).toBe(401)
  })

  it('a wrong bearer token fails to connect with 401', async () => {
    const { client, transport } = newClient(WRONG_TOKEN)
    const err = await client.connect(transport).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(StreamableHTTPError)
    expect((err as StreamableHTTPError).code).toBe(401)
  })

  it('a throwing tool returns a generic error and the next call on the same client succeeds', async () => {
    const client = await connected(FULL_TOKEN)
    const err = await callError(client, 'get_image', { message_id: MISSING_ID })
    expect(err).toBeInstanceOf(McpError)
    const message = (err as McpError).message
    expect(message).toContain('Tool failed')
    expect(message).not.toContain(String(MISSING_ID))
    expect(message).not.toContain('not found')

    const next = await client.callTool({ name: 'list_chats', arguments: {} })
    expect(next.isError).not.toBe(true)
    expect(firstText(next)).toContain('Tony Lin')
  })

  it('audit events name the right client per op and never contain call arguments', () => {
    const ops = (client: string): string[] =>
      events.filter((e) => 'client' in e && e.client === client).map((e) => e.op)
    for (const client of ['full', 'limited']) {
      expect(ops(client)).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'tools/call']))
    }

    const calls = events.filter((e): e is Extract<AuditEvent, { op: 'tools/call' }> => e.op === 'tools/call')
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ client: 'full', tool: 'list_chats', outcome: 'ok' }),
      expect.objectContaining({ client: 'full', tool: 'get_image', outcome: 'error' }),
      expect.objectContaining({ client: 'limited', tool: 'search_messages', outcome: 'ok' }),
      expect.objectContaining({ client: 'limited', tool: 'get_chat_summary', outcome: 'denied' }),
      expect.objectContaining({ client: 'limited', tool: 'no_such_tool', outcome: 'denied' }),
    ]))
    expect(events.filter((e) => e.op === 'auth-failed').length).toBeGreaterThanOrEqual(2)

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(SECRET_QUERY)
    expect(serialized).not.toContain(String(MISSING_ID))
    for (const token of [FULL_TOKEN, LIMITED_TOKEN, WRONG_TOKEN]) expect(serialized).not.toContain(token)
  })
})
