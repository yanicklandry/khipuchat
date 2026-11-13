import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex } from '../src/db'
import { createRemoteMcpApp, archiveHealthCheck } from '../src/remote-mcp/app'
import type { AuditEvent, RemoteMcpAudit } from '../src/remote-mcp/audit'
import { parseRemoteMcpConfig, type RemoteMcpConfig } from '../src/remote-mcp/config'
import { TOOL_DEFINITIONS } from '../src/tool-registry'

const TOKEN = 'muse-token-0123456789abcdef0123456789'
const ACCEPT = 'application/json, text/event-stream'

function configFrom(env: NodeJS.ProcessEnv): RemoteMcpConfig {
  const result = parseRemoteMcpConfig(env, TOOL_DEFINITIONS.map((t) => t.name))
  if (!result.ok) throw new Error(`bad test config: ${result.error.kind}`)
  return result.config
}

function seed(): void {
  const chat = upsertChat({ external_id: '1', account: 'default', name: 'Tony Lin', type: 'user', username: 'tonylin', platform: 'telegram' })
  insertMessage({ external_id: '1', chat_id: chat, sender_id: '9', sender_name: 'Tony', is_sender: 0, reply_to_external_id: null, platform: 'telegram', text: 'hello', type: 'text', timestamp: 1700000001 })
  rebuildFtsIndex()
}

let server: HttpServer | undefined
let events: AuditEvent[]
let healthy: () => boolean
let throwOn: string | undefined

async function start(): Promise<string> {
  events = []
  const audit: RemoteMcpAudit = {
    record: (e) => {
      if (e.op === throwOn) throw new Error('audit secret failure')
      events.push(e)
    },
  }
  const config = configFrom({ MCP_TOKEN_MUSE: TOKEN, MCP_ALLOWED_ORIGINS: 'https://claude.ai' })
  const app = createRemoteMcpApp({ config, audit, healthCheck: () => healthy() })
  server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const auth = { authorization: `Bearer ${TOKEN}` }

function post(base: string, body: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', accept: ACCEPT, ...extra },
    body,
  })
}

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
}

let base: string

beforeEach(async () => {
  initDb(':memory:')
  seed()
  healthy = () => true
  throwOn = undefined
  base = await start()
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

describe('GET /healthz', () => {
  it('returns 200 ok without a token, with security headers', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expectSecurityHeaders(res)
  })

  it('returns 503 when the health check fails or throws', async () => {
    healthy = () => false
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'unavailable' })
    healthy = () => { throw new Error('db gone') }
    const thrown = await fetch(`${base}/healthz`)
    expect(thrown.status).toBe(503)
    expect(await thrown.text()).not.toContain('db gone')
  })

  it('archiveHealthCheck reflects archive readability', () => {
    expect(archiveHealthCheck()).toBe(true)
  })
})

describe('authentication and routing', () => {
  it('unknown path: 401 without token, 404 with token, both with headers', async () => {
    const anon = await fetch(`${base}/nope`)
    expect(anon.status).toBe(401)
    expectSecurityHeaders(anon)
    const authed = await fetch(`${base}/nope`, { headers: auth })
    expect(authed.status).toBe(404)
    expect(await authed.json()).toEqual({ error: 'not found' })
    expectSecurityHeaders(authed)
  })

  it('disallowed Origin gets 403 with headers', async () => {
    const res = await post(base, JSON.stringify(INIT), { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expectSecurityHeaders(res)
  })

  it('GET and DELETE /mcp return 405 with Allow: POST', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method, headers: auth })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
      expectSecurityHeaders(res)
    }
  })
})

describe('POST /mcp body handling', () => {
  it('rejects a 1.5 MiB body with 413 and runs no tool', async () => {
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_chats', arguments: { pad: 'x'.repeat(1.5 * 1024 * 1024) } } }
    const res = await post(base, JSON.stringify(call))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload too large' })
    expectSecurityHeaders(res)
    expect(events.filter((e) => e.op === 'tools/call')).toEqual([])
  })

  const bigCall = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_chats', arguments: { pad: 'x'.repeat(1.5 * 1024 * 1024) } } })

  it.each(['application/jsonx', 'text/plain; q=application/json'])('rejects a 1.5 MiB body sent as %s with 413', async (type) => {
    const res = await post(base, bigCall, { 'content-type': type })
    expect(res.status).toBe(413)
    expect(events.filter((e) => e.op === 'tools/call')).toEqual([])
  })

  it.each(['text/plain', 'APPLICATION/JSON', 'application/json; charset=latin1'])('rejects Content-Type %s with 415 and runs no tool', async (contentType) => {
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_chats', arguments: {} } }
    const res = await post(base, JSON.stringify(call), { 'content-type': contentType })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported media type' })
    expectSecurityHeaders(res)
    expect(events.filter((e) => e.op === 'tools/call')).toEqual([])
  })

  it('maps an unexpected error to a generic 500', async () => {
    throwOn = 'auth-failed'
    const res = await post(base, JSON.stringify(INIT), { authorization: 'Bearer wrong-token' })
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'internal error' })
    expect(text).not.toContain('audit secret failure')
    expectSecurityHeaders(res)
  })

  it('rejects invalid JSON with 400 and a generic body', async () => {
    const res = await post(base, '{"jsonrpc": "2.0", oops')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
    expectSecurityHeaders(res)
  })
})

describe('POST /mcp MCP traffic', () => {
  it('serves initialize and tools/list as JSON and audits both', async () => {
    const init = await post(base, JSON.stringify(INIT))
    expect(init.status).toBe(200)
    expect(init.headers.get('content-type')).toContain('application/json')
    expectSecurityHeaders(init)
    const initBody = (await init.json()) as { result: { serverInfo: { name: string } } }
    expect(initBody.result.serverInfo.name).toBe('khipuchat')

    const list = await post(base, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), { 'mcp-protocol-version': '2025-06-18' })
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } }
    expect(listBody.result.tools.map((t) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name))

    expect(events).toEqual([
      { op: 'initialize', client: 'muse' },
      { op: 'tools/list', client: 'muse' },
    ])
  })

  it('does not audit initialize or tools/list when the transport rejects the request', async () => {
    const res = await post(base, JSON.stringify(INIT), { accept: 'application/json' })
    expect(res.status).toBe(406)
    expect(events).toEqual([])
  })

  it('an audit failure after an accepted response leaves the response intact', async () => {
    throwOn = 'initialize'
    const res = await post(base, JSON.stringify(INIT))
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('audit secret failure')
  })

  it('records the forwarded client address when the proxy is on loopback', async () => {
    const res = await post(base, JSON.stringify(INIT), { authorization: 'Bearer nope', 'x-forwarded-for': '203.0.113.9' })
    expect(res.status).toBe(401)
    expect(events).toContainEqual(expect.objectContaining({ op: 'auth-failed', addr: '203.0.113.9' }))
  })

  it('audits each initialize/tools/list object in a batch body', async () => {
    await post(base, JSON.stringify([{ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { jsonrpc: '2.0', id: 4, method: 'tools/list' }]))
    expect(events.filter((e) => e.op === 'tools/list')).toHaveLength(2)
  })
})
