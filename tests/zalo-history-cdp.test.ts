import { describe, it, expect, vi } from 'vitest'
import {
  createCdpClient,
  type CdpTarget,
  type WebSocketLike,
  type WebSocketCtor,
} from '../src/platforms/zalo/history/cdp'

// ── Fakes ─────────────────────────────────────────────────────────────────────

type Listener = (ev: { data?: unknown }) => void

class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket | null = null
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  closedByClient = false
  private listeners: Record<string, Listener[]> = {}
  constructor(public url: string) {
    FakeWebSocket.last = this
  }
  addEventListener(type: string, fn: Listener): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as FakeWebSocket['sent'][number])
  }
  close(): void {
    this.closedByClient = true
    this.emit('close')
  }
  emit(type: string, ev: { data?: unknown } = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
  reply(payload: Record<string, unknown>): void {
    const id = this.sent[this.sent.length - 1]!.id
    this.emit('message', { data: JSON.stringify({ id, ...payload }) })
  }
}

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (!(url in routes)) throw new Error(`ECONNREFUSED ${url}`)
    return { ok: true, json: async () => routes[url] } as Response
  }) as typeof fetch
}

const PAGE: CdpTarget = {
  id: 'p1',
  type: 'page',
  url: 'file:///Applications/Zalo.app/Contents/Resources/app.asar/index.html',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p1',
}

async function openSession(target: CdpTarget = PAGE) {
  const client = createCdpClient({ fetch: fakeFetch({}), WebSocket: FakeWebSocket as unknown as WebSocketCtor })
  const pending = client.connect(target)
  FakeWebSocket.last!.emit('open')
  const session = await pending
  return { session, ws: FakeWebSocket.last! }
}

// ── listTargets / version ─────────────────────────────────────────────────────

describe('createCdpClient discovery', () => {
  it('lists targets from 127.0.0.1 only', async () => {
    const client = createCdpClient({ fetch: fakeFetch({ 'http://127.0.0.1:9222/json/list': [PAGE] }) })
    expect(await client.listTargets(9222)).toEqual([PAGE])
  })

  it('reads the browser version', async () => {
    const client = createCdpClient({
      fetch: fakeFetch({ 'http://127.0.0.1:9222/json/version': { Browser: 'Chrome/108.0.5359.215' } }),
    })
    expect(await client.version(9222)).toEqual({ browser: 'Chrome/108.0.5359.215' })
  })

  it('rejects a malformed target list', async () => {
    const client = createCdpClient({ fetch: fakeFetch({ 'http://127.0.0.1:9222/json/list': { nope: 1 } }) })
    await expect(client.listTargets(9222)).rejects.toThrow(/target list/)
  })
})

// ── connect ───────────────────────────────────────────────────────────────────

describe('createCdpClient connect', () => {
  it('refuses a non-loopback debugger URL without opening a socket', async () => {
    FakeWebSocket.last = null
    const client = createCdpClient({ fetch: fakeFetch({}), WebSocket: FakeWebSocket as unknown as WebSocketCtor })
    await expect(
      client.connect({ ...PAGE, webSocketDebuggerUrl: 'ws://192.168.1.5:9222/devtools/page/p1' }),
    ).rejects.toThrow(/loopback/)
    expect(FakeWebSocket.last).toBeNull()
  })

  it('rewrites localhost to 127.0.0.1', async () => {
    const { ws } = await openSession({ ...PAGE, webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/p1' })
    expect(ws.url).toBe('ws://127.0.0.1:9222/devtools/page/p1')
  })

  it('times out when the socket neither opens nor errors, and closes it', async () => {
    vi.useFakeTimers()
    try {
      const client = createCdpClient({ fetch: fakeFetch({}), WebSocket: FakeWebSocket as unknown as WebSocketCtor })
      const pending = client.connect(PAGE)
      const assertion = expect(pending).rejects.toThrow(/Timed out/)
      await vi.advanceTimersByTimeAsync(10_001)
      await assertion
      expect(FakeWebSocket.last!.closedByClient).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects when the socket errors before opening', async () => {
    const client = createCdpClient({ fetch: fakeFetch({}), WebSocket: FakeWebSocket as unknown as WebSocketCtor })
    const pending = client.connect(PAGE)
    FakeWebSocket.last!.emit('error')
    await expect(pending).rejects.toThrow(/connect/)
  })
})

// ── evaluate ──────────────────────────────────────────────────────────────────

describe('CdpSession.evaluate', () => {
  it('sends Runtime.evaluate with awaitPromise/returnByValue and parses the JSON string', async () => {
    const { session, ws } = await openSession()
    const pending = session.evaluate<{ n: number }>('JSON.stringify({n:1})', 5000)
    expect(ws.sent[0]).toMatchObject({
      method: 'Runtime.evaluate',
      params: { expression: 'JSON.stringify({n:1})', awaitPromise: true, returnByValue: true, timeout: 5000 },
    })
    ws.reply({ result: { result: { type: 'string', value: '{"n":1}' } } })
    expect(await pending).toEqual({ ok: true, value: { n: 1 } })
  })

  it('maps a renderer exception to attach_failed with its message', async () => {
    const { session, ws } = await openSession()
    const pending = session.evaluate('boom()', 5000)
    ws.reply({
      result: {
        result: { type: 'object' },
        exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: boom is not defined' } },
      },
    })
    expect(await pending).toEqual({
      ok: false,
      error: { kind: 'attach_failed', step: 'attach', message: 'ReferenceError: boom is not defined' },
    })
  })

  it('maps a protocol error and a non-JSON value to attach_failed', async () => {
    const { session, ws } = await openSession()
    const a = session.evaluate('x', 5000)
    ws.reply({ error: { message: 'Cannot find context' } })
    expect(await a).toMatchObject({ ok: false, error: { kind: 'attach_failed', message: 'Cannot find context' } })
    const b = session.evaluate('y', 5000)
    ws.reply({ result: { result: { type: 'number', value: 3 } } })
    expect(await b).toMatchObject({ ok: false, error: { kind: 'attach_failed' } })
  })

  it('times out locally when the renderer never answers, and ignores a late reply', async () => {
    vi.useFakeTimers()
    try {
      const { session, ws } = await openSession()
      const pending = session.evaluate('hang()', 1000)
      const id = ws.sent[0]!.id
      await vi.advanceTimersByTimeAsync(6001)
      expect(await pending).toMatchObject({ ok: false, error: { kind: 'attach_failed', message: expect.stringMatching(/timed out/) } })
      ws.emit('message', { data: JSON.stringify({ id, result: { result: { type: 'string', value: '1' } } }) })
      // The late reply was dropped; the session still works for the next call.
      const next = session.evaluate<number>('ok()', 1000)
      ws.reply({ result: { result: { type: 'string', value: '2' } } })
      expect(await next).toEqual({ ok: true, value: 2 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('correlates concurrent calls by id', async () => {
    const { session, ws } = await openSession()
    const a = session.evaluate<string>('a', 5000)
    const b = session.evaluate<string>('b', 5000)
    const [idA, idB] = [ws.sent[0]!.id, ws.sent[1]!.id]
    ws.emit('message', { data: JSON.stringify({ id: idB, result: { result: { type: 'string', value: '"B"' } } }) })
    ws.emit('message', { data: JSON.stringify({ id: idA, result: { result: { type: 'string', value: '"A"' } } }) })
    expect(await a).toEqual({ ok: true, value: 'A' })
    expect(await b).toEqual({ ok: true, value: 'B' })
  })
})

// ── connection loss ───────────────────────────────────────────────────────────

describe('CdpSession connection loss', () => {
  it('fails in-flight calls as connection_lost and fires onClose exactly once', async () => {
    const { session, ws } = await openSession()
    let closes = 0
    session.onClose(() => closes++)
    const pending = session.evaluate('slow()', 5000)
    ws.emit('close')
    ws.emit('close')
    expect(await pending).toEqual({ ok: false, error: { kind: 'connection_lost', step: 'read', conversationsDone: 0 } })
    expect(closes).toBe(1)
  })

  it('evaluate after loss fails immediately as connection_lost', async () => {
    const { session, ws } = await openSession()
    ws.emit('close')
    expect(await session.evaluate('x', 5000)).toMatchObject({ ok: false, error: { kind: 'connection_lost' } })
  })

  it('a handler registered after the loss still fires', async () => {
    const { session, ws } = await openSession()
    ws.emit('close')
    let closes = 0
    session.onClose(() => closes++)
    await Promise.resolve()
    expect(closes).toBe(1)
  })

  it('an intentional close() does not fire onClose', async () => {
    const { session, ws } = await openSession()
    let closes = 0
    session.onClose(() => closes++)
    session.close()
    expect(ws.closedByClient).toBe(true)
    expect(closes).toBe(0)
  })
})
