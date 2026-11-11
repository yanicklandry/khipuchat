/**
 * signal-cli JSON-RPC transport (NDJSON over a UNIX/TCP socket).
 *
 * Arm's-length IPC: KhipuChat speaks the signal-cli daemon's newline-delimited
 * JSON-RPC 2.0 wire format only. No signal-cli source is imported, linked, or
 * vendored (GPLv3 stays at the process boundary — mere aggregation).
 */

import net from 'net'
import os from 'os'
import path from 'path'
import { extractEnvelope } from './cli-types'
import type {
  JsonRpcParams,
  ReceiveHandler,
  RpcSocket,
  SignalCliClient,
  SignalCliConnectOptions,
  ConnectResult,
} from './cli-types'

// Re-export the wire types and pure helper so existing importers of
// './cli-client' keep working after the split into ./cli-types.
export { extractEnvelope } from './cli-types'
export type {
  JsonRpcParams,
  SignalAttachment,
  SignalQuote,
  SignalDataMessage,
  SignalSentMessage,
  SignalEnvelope,
  ReceiveHandler,
  SignalCliClient,
  ConnectResult,
  SignalCliConnectOptions,
  RpcSocket,
} from './cli-types'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/**
 * Build a JSON-RPC client over any line-oriented duplex socket. Correlates
 * responses to requests by `id`; delivers `receive` notifications (no `id`) to
 * registered handlers. This is the unit-testable core (pass a fake socket).
 */
export function createRpcClient(socket: RpcSocket): SignalCliClient {
  const pending = new Map<number, Pending>()
  const receivers: ReceiveHandler[] = []
  let buffer = ''
  let nextId = 1
  let closed = false

  const failAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  socket.on('data', (...args: unknown[]) => {
    const chunk = args[0]
    buffer += typeof chunk === 'string' ? chunk : String(chunk)
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.trim().length > 0) dispatch(line)
      idx = buffer.indexOf('\n')
    }
  })
  socket.on('error', (...args: unknown[]) => {
    failAll(args[0] instanceof Error ? args[0] : new Error(String(args[0])))
  })
  socket.on('close', () => {
    closed = true
    failAll(new Error('signal-cli socket closed'))
  })

  function dispatch(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const obj = msg as Record<string, unknown>
    const id = obj['id']
    if (typeof id === 'number' && pending.has(id)) {
      const p = pending.get(id)!
      pending.delete(id)
      if (obj['error']) {
        const e = obj['error'] as { message?: string }
        p.reject(new Error(e.message ?? 'signal-cli JSON-RPC error'))
      } else {
        p.resolve(obj['result'])
      }
      return
    }
    if (obj['method'] === 'receive') {
      const params = obj['params'] as Record<string, unknown> | undefined
      const env = extractEnvelope(params?.['envelope'] ?? params)
      if (env) for (const h of receivers) h(env)
    }
  }

  return {
    request<T>(method: string, params?: JsonRpcParams): Promise<T> {
      if (closed) return Promise.reject(new Error('signal-cli socket is closed'))
      const id = nextId++
      const payload = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id }) + '\n'
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        try {
          socket.write(payload)
        } catch (err) {
          pending.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
    onReceive(handler: ReceiveHandler): void {
      receivers.push(handler)
    },
    close(): void {
      closed = true
      socket.destroy()
    },
  }
}

/** Resolve the default daemon socket path (override via SIGNAL_CLI_SOCKET). */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['SIGNAL_CLI_SOCKET']
  if (override) return override
  const runtime = env['XDG_RUNTIME_DIR']
  if (runtime) return path.join(runtime, 'signal-cli', 'socket')
  return path.join(os.homedir(), '.local', 'share', 'signal-cli', 'socket')
}

/**
 * Connect to a running signal-cli daemon. Returns a typed result distinguishing
 * an unreachable/not-installed daemon from a usable client; never throws.
 */
export function connectSignalCli(opts: SignalCliConnectOptions = {}): Promise<ConnectResult> {
  return new Promise((resolve) => {
    let settled = false
    let socket: net.Socket
    try {
      socket = opts.tcp
        ? net.connect({ host: opts.tcp.host, port: opts.tcp.port })
        : net.connect({ path: opts.socketPath ?? defaultSocketPath() })
    } catch (err) {
      resolve({ ok: false, reason: 'unreachable', message: err instanceof Error ? err.message : String(err) })
      return
    }
    socket.once('connect', () => {
      if (settled) return
      settled = true
      socket.setEncoding('utf8')
      resolve({ ok: true, client: createRpcClient(socket as unknown as RpcSocket) })
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      const reason = err.code === 'ENOENT' ? 'not_installed' : 'unreachable'
      const hint = reason === 'not_installed'
        ? "No signal-cli socket found. Install signal-cli and run 'signal-cli daemon --socket'."
        : `Cannot reach the signal-cli daemon (${err.code ?? err.message}). Ensure 'signal-cli daemon --socket' is running.`
      resolve({ ok: false, reason, message: hint })
    })
  })
}
