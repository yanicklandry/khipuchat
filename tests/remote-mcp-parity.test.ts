import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { initDb, getDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import { createMcpServer } from '../src/mcp'
import { createRemoteMcpApp } from '../src/remote-mcp/app'
import { parseRemoteMcpConfig } from '../src/remote-mcp/config'
import { TOOL_DEFINITIONS } from '../src/tool-registry'
import { isIndexed } from '../src/vec-db'

// Parity: every registry tool returns identical content through the stdio server's
// call handler and through the remote endpoint, and the remote calls leave the
// archive unmodified (Req 1.2, 4.7, 5.2).

const TOKEN = 'parity-token-0123456789abcdef0123456789'
const IMAGE_FILE = path.join(os.tmpdir(), `khipuchat-remote-parity-${process.pid}.jpg`)

let ids: { tony: number; work: number; image: number }

function seed(): void {
  const tony = upsertChat({ external_id: 'p1', account: 'default', name: 'Tony Lin', type: 'user', username: 'tonylin', platform: 'telegram' })
  const work = upsertChat({ external_id: 'p2', account: 'default', name: 'Work Group', type: 'group', username: null, platform: 'telegram' })
  const base = { sender_id: '9', sender_name: 'Tony', is_sender: 0, reply_to_external_id: null, platform: 'telegram' } as const
  insertMessage({ ...base, chat_id: tony, external_id: 'm1', text: 'hello there', type: 'text', timestamp: 1700000001 })
  insertMessage({ ...base, chat_id: tony, external_id: 'm2', text: 'how are you', type: 'text', timestamp: 1700000002 })
  insertMessage({ ...base, chat_id: work, external_id: 'm3', text: 'meeting at 3', type: 'text', timestamp: 1700000003 })
  insertMessage({ ...base, chat_id: tony, external_id: 'm4', text: null, type: 'image', timestamp: 1700000004, media_file_path: IMAGE_FILE, ocr_text: 'receipt total' })
  rebuildFtsIndex()
  const row = getDb().prepare("SELECT id FROM messages WHERE external_id = 'm4'").get() as { id: number }
  ids = { tony, work, image: row.id }
}

// One argument set per registry tool. A registry tool without an entry fails the test,
// so every future tool must be added here.
function argsTable(): Record<string, Record<string, unknown>> {
  return {
    list_chats: {},
    find_chat_by_name: { name: 'Tony' },
    list_messages: { chat_id: ids.tony, limit: 10 },
    search_messages: { query: 'meeting' },
    get_chat_summary: { chat_id: ids.tony },
    semantic_find_contacts: { query: 'old friend' },
    semantic_search_messages: { query: 'meeting plans' },
    get_image: { message_id: ids.image },
  }
}

type CallHandler = (req: unknown) => Promise<{ content?: unknown }>

function stdioCallHandler(): CallHandler {
  const server = createMcpServer()
  const handler = (server as unknown as { _requestHandlers: Map<string, CallHandler> })._requestHandlers.get('tools/call')
  if (!handler) throw new Error('stdio server has no tools/call handler')
  return handler
}

let server: HttpServer
let client: Client
let savedSecret: string | undefined

beforeAll(async () => {
  savedSecret = process.env['MCP_SECRET']
  delete process.env['MCP_SECRET']
  fs.writeFileSync(IMAGE_FILE, Buffer.from('fakeimagedata'))
  initDb(':memory:')
  seed()
  const parsed = parseRemoteMcpConfig({ MCP_TOKEN_PARITY: TOKEN }, TOOL_DEFINITIONS.map((t) => t.name))
  if (!parsed.ok) throw new Error(`bad test config: ${parsed.error.kind}`)
  const app = createRemoteMcpApp({ config: parsed.config, audit: { record: () => {} }, healthCheck: () => true })
  server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } })
  client = new Client({ name: 'parity', version: '0.0.0' })
  await client.connect(transport)
})

afterAll(async () => {
  await client.close().catch(() => {})
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(IMAGE_FILE, { force: true })
  if (savedSecret === undefined) delete process.env['MCP_SECRET']
  else process.env['MCP_SECRET'] = savedSecret
})

function totalChanges(): number {
  return (getDb().prepare('SELECT total_changes() AS n').get() as { n: number }).n
}

describe('remote MCP parity with stdio', () => {
  it('semantic tools run against an unindexed archive (no embedding model needed)', () => {
    expect(isIndexed('chats')).toBe(false)
    expect(isIndexed('messages')).toBe(false)
  })

  it('every registry tool has an argument entry', () => {
    const table = argsTable()
    const missing = TOOL_DEFINITIONS.map((t) => t.name).filter((name) => !(name in table))
    expect(missing).toEqual([])
  })

  it('every registry tool returns identical content on both sides, with no archive change', async () => {
    const table = argsTable()
    const stdio = stdioCallHandler()
    const stdioResults = new Map<string, unknown>()
    for (const { name } of TOOL_DEFINITIONS) {
      const args = table[name]
      if (args === undefined) throw new Error(`no parity arguments for tool ${name}`)
      const result = await stdio({ method: 'tools/call', params: { name, arguments: args } })
      stdioResults.set(name, result.content)
    }

    const before = totalChanges()
    for (const { name } of TOOL_DEFINITIONS) {
      const remote = await client.callTool({ name, arguments: table[name] })
      expect(remote.isError ?? false, `${name} errored remotely`).toBe(false)
      expect(remote.content, `${name} content differs`).toEqual(stdioResults.get(name))
    }
    expect(totalChanges()).toBe(before)
  })

  it('compared results are real data, not empty or error payloads', () => {
    const contentOf = async (name: string): Promise<string> => {
      const result = await client.callTool({ name, arguments: argsTable()[name] })
      return (result.content as Array<{ text: string }>)[0]?.text ?? ''
    }
    return Promise.all([
      contentOf('search_messages').then((t) => expect(t).toContain('meeting at 3')),
      contentOf('get_image').then((t) => expect(t).toContain('"file_available":true')),
      contentOf('semantic_search_messages').then((t) => expect(t).toContain('Embedding index not built')),
    ])
  })
})
