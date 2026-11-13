import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { request, type IncomingMessage } from 'node:http'
import { createServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { runRemoteMcp } from '../src/remote-mcp/runner'
import { TOOL_DEFINITIONS } from '../src/tool-registry'

const MUSE_TOKEN = 'muse-token-0123456789abcdef0123456789'
const BOT_TOKEN = 'bot-token-abcdef0123456789abcdef01234'
const TOTAL = TOOL_DEFINITIONS.length
const ACCEPT = 'application/json, text/event-stream'

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

interface Running {
  readonly done: Promise<number>
  readonly signals: EventEmitter
  readonly lines: string[]
  readonly port: number
}

const pending: Running[] = []

async function start(env: NodeJS.ProcessEnv, extra: { drainMs?: number } = {}): Promise<Running> {
  const port = await freePort()
  const signals = new EventEmitter()
  const lines: string[] = []
  let listening!: () => void
  const ready = new Promise<void>((resolve) => (listening = resolve))
  const done = runRemoteMcp({
    env: { ...env, MCP_HTTP_PORT: String(port) },
    dbPath: ':memory:',
    signals,
    log: (line) => lines.push(line),
    onListening: () => listening(),
    ...extra,
  })
  const running: Running = { done, signals, lines, port }
  pending.push(running)
  await Promise.race([ready, done.then((code) => Promise.reject(new Error(`exited ${code}: ${lines.join('\n')}`)))])
  return running
}

afterEach(async () => {
  for (const r of pending.splice(0)) {
    r.signals.emit('SIGTERM')
    await r.done
  }
})

function get(port: number, path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method: 'GET' }, resolve).on('error', reject).end()
  })
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => (text += chunk))
    res.on('end', () => resolve(text))
    res.on('error', reject)
  })
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const BASE_ENV: NodeJS.ProcessEnv = {
  MCP_TOKEN_MUSE: MUSE_TOKEN,
  MCP_TOKEN_BOT: BOT_TOKEN,
  MCP_TOOLS_BOT: 'list_chats,search_messages',
}

describe('runRemoteMcp: configuration errors', () => {
  it('resolves 1 with the formatted error when no client token is configured', async () => {
    const lines: string[] = []
    const code = await runRemoteMcp({ env: {}, dbPath: ':memory:', signals: new EventEmitter(), log: (l) => lines.push(l) })
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('at least one MCP_TOKEN_<CLIENT> setting is required')
  })

  it('names the setting without printing the token when a token is too short', async () => {
    const lines: string[] = []
    const shortToken = 'short-secret-value'
    const code = await runRemoteMcp({
      env: { MCP_TOKEN_MUSE: shortToken },
      dbPath: ':memory:',
      signals: new EventEmitter(),
      log: (l) => lines.push(l),
    })
    expect(code).toBe(1)
    const output = lines.join('\n')
    expect(output).toContain('MCP_TOKEN_MUSE')
    expect(output).not.toContain(shortToken)
  })

  it('resolves 1 for an invalid port', async () => {
    const lines: string[] = []
    const code = await runRemoteMcp({
      env: { ...BASE_ENV, MCP_HTTP_PORT: '0' },
      dbPath: ':memory:',
      signals: new EventEmitter(),
      log: (l) => lines.push(l),
    })
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('MCP_HTTP_PORT')
  })
})

describe('runRemoteMcp: listening', () => {
  it('resolves 1 with a message naming the address when the port is in use', async () => {
    const blocker: NetServer = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as AddressInfo
    const lines: string[] = []
    const signals = new EventEmitter()
    try {
      const code = await runRemoteMcp({
        env: { ...BASE_ENV, MCP_HTTP_PORT: String(port) },
        dbPath: ':memory:',
        signals,
        log: (l) => lines.push(l),
      })
      expect(code).toBe(1)
      expect(lines.join('\n')).toContain(`127.0.0.1:${port}`)
      expect(signals.listenerCount('SIGTERM')).toBe(0)
      expect(signals.listenerCount('SIGINT')).toBe(0)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('logs the listen URL and one line per client with tool counts, never a token', async () => {
    const r = await start(BASE_ENV)
    expect(r.lines[0]).toBe(`remote MCP listening on http://127.0.0.1:${r.port}/mcp`)
    expect(r.lines).toContain(`client=bot tools=2/${TOTAL}`)
    expect(r.lines).toContain(`client=muse tools=${TOTAL}/${TOTAL}`)
    const output = r.lines.join('\n')
    expect(output).not.toContain(MUSE_TOKEN)
    expect(output).not.toContain(BOT_TOKEN)
    expect(output).not.toMatch(/TLS/)
  })

  it('serves the app on the configured address with the archive opened', async () => {
    const r = await start(BASE_ENV)
    const res = await get(r.port, '/healthz')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(await readBody(res))).toEqual({ status: 'ok' })
  })

  it('warns that a non-loopback host is reachable from the network without TLS', async () => {
    const r = await start({ ...BASE_ENV, MCP_HTTP_HOST: '0.0.0.0' })
    expect(r.lines[0]).toBe(`remote MCP listening on http://0.0.0.0:${r.port}/mcp`)
    expect(r.lines.some((l) => /warning/i.test(l) && /network/.test(l) && /TLS/.test(l))).toBe(true)
  })
})

describe('runRemoteMcp: graceful stop', () => {
  it('lets an in-flight request finish, refuses new connections, then resolves 0', async () => {
    const r = await start(BASE_ENV)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const half = Math.floor(body.length / 2)
    const req = request({
      host: '127.0.0.1',
      port: r.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        authorization: `Bearer ${BOT_TOKEN}`,
        accept: ACCEPT,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    })
    const response = new Promise<IncomingMessage>((resolve, reject) => req.on('response', resolve).on('error', reject))
    req.write(body.slice(0, half))
    await settle(100)

    let exitCode: number | undefined
    void r.done.then((code) => (exitCode = code))
    r.signals.emit('SIGTERM')
    await settle(100)
    expect(exitCode).toBeUndefined()
    // Listeners stay attached while draining, so a loader's fallback exit handler never fires.
    expect(r.signals.listenerCount('SIGTERM')).toBe(1)
    await expect(get(r.port, '/healthz')).rejects.toThrow()

    req.end(body.slice(half))
    const res = await response
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(await readBody(res)) as { result: { tools: { name: string }[] } }
    expect(parsed.result.tools.map((t) => t.name)).toEqual(['list_chats', 'search_messages'])

    expect(await r.done).toBe(0)
    expect(r.signals.listenerCount('SIGTERM')).toBe(0)
    expect(r.signals.listenerCount('SIGINT')).toBe(0)
  })

  it('closes connections still open after the drain window and resolves 0 on SIGINT', async () => {
    const r = await start(BASE_ENV, { drainMs: 50 })
    const req = request({
      host: '127.0.0.1',
      port: r.port,
      path: '/mcp',
      method: 'POST',
      headers: { authorization: `Bearer ${BOT_TOKEN}`, accept: ACCEPT, 'content-type': 'application/json', 'content-length': 1000 },
    })
    const failed = new Promise<Error>((resolve) => req.on('error', resolve))
    req.write('{"jsonrpc"')
    await settle(100)
    r.signals.emit('SIGINT')
    expect(await r.done).toBe(0)
    expect(await failed).toBeInstanceOf(Error)
  })
})
