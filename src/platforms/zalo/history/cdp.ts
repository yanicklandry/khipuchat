// Minimal Chrome DevTools Protocol client for reading Zalo PC's renderer.
// Only three calls are needed (target list, version, Runtime.evaluate), so this
// uses Node 24's built-in fetch and WebSocket instead of a CDP library.
// Every connection is loopback-only (requirement 2.5, 8.1).
import type { ImportError, Result } from './types'

const HOST = '127.0.0.1'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
/** Extra time on top of the renderer-side timeout before we give up locally. */
const LOCAL_TIMEOUT_SLACK_MS = 5000
const CONNECT_TIMEOUT_MS = 10_000

export interface CdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl: string
}

export interface CdpSession {
  evaluate<T>(expression: string, timeoutMs: number): Promise<Result<T>>
  onClose(handler: () => void): void
  close(): void
}

export interface CdpClient {
  listTargets(port: number): Promise<CdpTarget[]>
  version(port: number): Promise<{ browser: string }>
  connect(target: CdpTarget): Promise<CdpSession>
}

/** The subset of the WHATWG WebSocket API this client uses (tests supply a fake). */
export interface WebSocketLike {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: { data?: unknown }) => void): void
  send(data: string): void
  close(): void
}
export type WebSocketCtor = new (url: string) => WebSocketLike

interface EvaluateReply {
  id: number
  error?: { message?: string }
  result?: {
    result?: { type?: string; value?: unknown }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
}

const attachFailed = (message: string): { ok: false; error: ImportError } => ({
  ok: false,
  error: { kind: 'attach_failed', step: 'attach', message },
})
const connectionLost = (): { ok: false; error: ImportError } => ({
  ok: false,
  error: { kind: 'connection_lost', step: 'read', conversationsDone: 0 },
})

function isTarget(v: unknown): v is CdpTarget {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return ['id', 'type', 'url', 'webSocketDebuggerUrl'].every((k) => typeof t[k] === 'string')
}

/** Returns the URL pinned to 127.0.0.1, or null when it is not loopback. */
export function toLoopbackUrl(wsUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(wsUrl)
  } catch {
    return null
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null
  parsed.hostname = HOST
  return parsed.toString()
}

function decodeReply<T>(reply: EvaluateReply): Result<T> {
  if (reply.error) return attachFailed(reply.error.message ?? 'CDP protocol error')
  const details = reply.result?.exceptionDetails
  if (details) return attachFailed(details.exception?.description ?? details.text ?? 'renderer exception')
  const value = reply.result?.result?.value
  if (typeof value !== 'string') return attachFailed('renderer did not return a JSON string')
  try {
    return { ok: true, value: JSON.parse(value) as T }
  } catch {
    return attachFailed('renderer returned invalid JSON')
  }
}

function openSession(ws: WebSocketLike): CdpSession {
  const pending = new Map<number, (r: Result<unknown>) => void>()
  let nextId = 1
  let lost = false
  let closedByUs = false
  let closeHandler: (() => void) | null = null

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return
    let reply: EvaluateReply
    try {
      reply = JSON.parse(ev.data) as EvaluateReply
    } catch {
      return
    }
    const resolve = pending.get(reply.id)
    if (!resolve) return // events and unknown ids are ignored
    pending.delete(reply.id)
    resolve(decodeReply(reply))
  })

  ws.addEventListener('close', () => {
    if (lost) return
    lost = true
    for (const resolve of pending.values()) resolve(connectionLost())
    pending.clear()
    if (!closedByUs) closeHandler?.()
  })

  return {
    evaluate<T>(expression: string, timeoutMs: number): Promise<Result<T>> {
      if (lost) return Promise.resolve(connectionLost())
      const id = nextId++
      return new Promise<Result<T>>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve(attachFailed(`renderer call timed out after ${timeoutMs}ms`))
        }, timeoutMs + LOCAL_TIMEOUT_SLACK_MS)
        pending.set(id, (r) => {
          clearTimeout(timer)
          resolve(r as Result<T>)
        })
        ws.send(JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
        }))
      })
    },
    /** Fires once when the connection is LOST; our own close() never triggers it. */
    onClose(handler: () => void): void {
      closeHandler = handler
      if (lost && !closedByUs) queueMicrotask(handler)
    },
    close(): void {
      closedByUs = true
      ws.close()
    },
  }
}

export function createCdpClient(deps: { fetch?: typeof fetch; WebSocket?: WebSocketCtor } = {}): CdpClient {
  const doFetch = deps.fetch ?? globalThis.fetch
  const Ws: WebSocketCtor = deps.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor)

  async function getJson(port: number, path: string): Promise<unknown> {
    const res = await doFetch(`http://${HOST}:${port}${path}`)
    if (!res.ok) throw new Error(`CDP ${path} returned HTTP ${res.status}`)
    return res.json()
  }

  return {
    async listTargets(port: number): Promise<CdpTarget[]> {
      const body = await getJson(port, '/json/list')
      if (!Array.isArray(body)) throw new Error('CDP returned a malformed target list')
      return body.filter(isTarget)
    },
    async version(port: number): Promise<{ browser: string }> {
      const body = (await getJson(port, '/json/version')) as { Browser?: unknown }
      return { browser: typeof body.Browser === 'string' ? body.Browser : 'unknown' }
    },
    connect(target: CdpTarget): Promise<CdpSession> {
      const url = toLoopbackUrl(target.webSocketDebuggerUrl)
      if (!url) {
        return Promise.reject(new Error(`Refusing non-loopback CDP target: ${target.webSocketDebuggerUrl}`))
      }
      return new Promise<CdpSession>((resolve, reject) => {
        const ws = new Ws(url)
        let settled = false
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          fn()
        }
        const timer = setTimeout(() => settle(() => {
          ws.close()
          reject(new Error(`Timed out connecting to Zalo PC debugger at ${url}`))
        }), CONNECT_TIMEOUT_MS)
        ws.addEventListener('open', () => settle(() => resolve(openSession(ws))))
        ws.addEventListener('error', () => settle(() => reject(new Error(`Could not connect to Zalo PC debugger at ${url}`))))
      })
    },
  }
}
