import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { createRpcClient, extractEnvelope, type RpcSocket, type SignalEnvelope } from '../src/platforms/signal/cli-client'

// ── Fake line-oriented socket ─────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  written: string[] = []
  destroyed = false
  write(data: string): void {
    this.written.push(data)
  }
  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
  feed(chunk: string): void {
    this.emit('data', chunk)
  }
  lastId(): number {
    const parsed = JSON.parse(this.written[this.written.length - 1] as string) as { id: number }
    return parsed.id
  }
}

function makeClient(): { socket: FakeSocket; client: ReturnType<typeof createRpcClient> } {
  const socket = new FakeSocket()
  const client = createRpcClient(socket as unknown as RpcSocket)
  return { socket, client }
}

describe('createRpcClient — request/response correlation', () => {
  it('resolves a request with the matching id result', async () => {
    const { socket, client } = makeClient()
    const p = client.request<{ x: number }>('foo', { a: 1 })
    const id = socket.lastId()
    // request framed as a single NDJSON line with jsonrpc 2.0 + method + id
    const sent = JSON.parse(socket.written[0] as string) as Record<string, unknown>
    expect(sent['method']).toBe('foo')
    expect(sent['jsonrpc']).toBe('2.0')
    socket.feed(JSON.stringify({ jsonrpc: '2.0', id, result: { x: 42 } }) + '\n')
    await expect(p).resolves.toEqual({ x: 42 })
  })

  it('rejects a request when the response carries an error', async () => {
    const { socket, client } = makeClient()
    const p = client.request('bad')
    const id = socket.lastId()
    socket.feed(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: 'nope' } }) + '\n')
    await expect(p).rejects.toThrow('nope')
  })

  it('correlates concurrent requests by distinct ids', async () => {
    const { socket, client } = makeClient()
    const p1 = client.request<number>('a')
    const id1 = JSON.parse(socket.written[0] as string).id
    const p2 = client.request<number>('b')
    const id2 = JSON.parse(socket.written[1] as string).id
    expect(id1).not.toBe(id2)
    // respond out of order
    socket.feed(JSON.stringify({ id: id2, result: 2 }) + '\n')
    socket.feed(JSON.stringify({ id: id1, result: 1 }) + '\n')
    await expect(p1).resolves.toBe(1)
    await expect(p2).resolves.toBe(2)
  })
})

describe('createRpcClient — NDJSON framing', () => {
  it('parses two responses arriving in one chunk', async () => {
    const { socket, client } = makeClient()
    const p1 = client.request<number>('a')
    const id1 = socket.lastId()
    const p2 = client.request<number>('b')
    const id2 = socket.lastId()
    socket.feed(
      JSON.stringify({ id: id1, result: 10 }) + '\n' + JSON.stringify({ id: id2, result: 20 }) + '\n',
    )
    await expect(p1).resolves.toBe(10)
    await expect(p2).resolves.toBe(20)
  })

  it('reassembles a response split across two data events', async () => {
    const { socket, client } = makeClient()
    const p = client.request<{ ok: boolean }>('a')
    const id = socket.lastId()
    const line = JSON.stringify({ id, result: { ok: true } }) + '\n'
    const mid = Math.floor(line.length / 2)
    socket.feed(line.slice(0, mid))
    socket.feed(line.slice(mid))
    await expect(p).resolves.toEqual({ ok: true })
  })
})

describe('createRpcClient — receive notification dispatch', () => {
  it('delivers receive-notification envelopes to registered handlers', () => {
    const { socket, client } = makeClient()
    const got: SignalEnvelope[] = []
    client.onReceive((env) => got.push(env))
    const envelope = { timestamp: 111, dataMessage: { message: 'hi' }, sourceUuid: 'u-1' }
    socket.feed(JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: { envelope } }) + '\n')
    expect(got).toHaveLength(1)
    expect(got[0]?.timestamp).toBe(111)
    expect(got[0]?.dataMessage?.message).toBe('hi')
  })

  it('ignores a notification with no id and no envelope', () => {
    const { socket, client } = makeClient()
    const got: SignalEnvelope[] = []
    client.onReceive((env) => got.push(env))
    socket.feed(JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: {} }) + '\n')
    expect(got).toHaveLength(0)
  })

  it('does not throw on malformed JSON lines', () => {
    const { socket } = makeClient()
    expect(() => socket.feed('not json\n')).not.toThrow()
  })
})

describe('createRpcClient — close', () => {
  it('destroys the socket and rejects subsequent requests', async () => {
    const { socket, client } = makeClient()
    client.close()
    expect(socket.destroyed).toBe(true)
    await expect(client.request('foo')).rejects.toThrow(/closed/)
  })

  it('rejects in-flight requests when the socket closes', async () => {
    const { socket, client } = makeClient()
    const p = client.request('foo')
    socket.emit('close')
    await expect(p).rejects.toThrow(/closed/)
  })
})

describe('extractEnvelope', () => {
  it('unwraps an { envelope } item', () => {
    expect(extractEnvelope({ envelope: { timestamp: 5 } })?.timestamp).toBe(5)
  })
  it('accepts a bare envelope', () => {
    expect(extractEnvelope({ timestamp: 7 })?.timestamp).toBe(7)
  })
  it('returns null for a non-envelope', () => {
    expect(extractEnvelope({ foo: 'bar' })).toBeNull()
    expect(extractEnvelope(null)).toBeNull()
  })
})
