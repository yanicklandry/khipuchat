import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { initDb } from '../db'
import { TOOL_DEFINITIONS } from '../tool-registry'
import { archiveHealthCheck, createRemoteMcpApp } from './app'
import { createStderrAudit } from './audit'
import { formatConfigError, isLoopbackHost, parseRemoteMcpConfig, type RemoteMcpConfig } from './config'

// Process lifecycle for the remote MCP endpoint (Req 1.3, 1.5, 1.6, 1.7, 2.2 to 2.4,
// 4.5, 4.6, 5.7). Resolves with the exit status instead of calling process.exit,
// so the caller owns the process. No log line ever carries a token.

export interface RunRemoteMcpOptions {
  readonly env: NodeJS.ProcessEnv
  readonly dbPath: string
  /** Test injection; default process. */
  readonly signals?: NodeJS.EventEmitter
  /** Line sink for startup, error, and audit lines; default stderr. */
  readonly log?: (line: string) => void
  /** Called once the server is listening. */
  readonly onListening?: (address: AddressInfo) => void
  /** How long in-flight requests may run after a stop signal; default 10 s. */
  readonly drainMs?: number
}

const DEFAULT_DRAIN_MS = 10_000
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const stderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

/** `host:port`, with IPv6 hosts in brackets. */
function formatAddress(host: string, port: number): string {
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`
}

function startupLines(config: RemoteMcpConfig): string[] {
  const total = TOOL_DEFINITIONS.length
  const lines = [`remote MCP listening on http://${formatAddress(config.host, config.port)}/mcp`]
  for (const client of config.clients) lines.push(`client=${client.name} tools=${client.tools.size}/${total}`)
  if (!isLoopbackHost(config.host)) {
    lines.push(
      `remote MCP warning: ${config.host} is not a loopback address; the endpoint is reachable from the network without TLS. Publish it through a TLS tunnel instead.`,
    )
  }
  return lines
}

function listen(server: Server, config: RemoteMcpConfig): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => resolve(err)
    server.once('error', onError)
    server.listen(config.port, config.host.replace(/^\[(.*)\]$/, '$1'), () => {
      server.off('error', onError)
      resolve(undefined)
    })
  })
}

function listenErrorLine(err: NodeJS.ErrnoException, address: string): string {
  if (err.code === 'EADDRINUSE') return `Remote MCP: cannot listen on ${address}: address already in use.`
  return `Remote MCP: cannot listen on ${address} (${err.code ?? 'error'}).`
}

/**
 * Waits for SIGINT/SIGTERM, then stops accepting, drains, and force-closes after drainMs.
 * While stopping, each finished response also drops its now idle keep-alive connection,
 * so close() resolves as soon as the in-flight requests are done.
 */
function stopOnSignal(server: Server, signals: NodeJS.EventEmitter, drainMs: number): Promise<number> {
  return new Promise((resolve) => {
    let stopping = false
    server.on('request', (_req: IncomingMessage, res: ServerResponse) => {
      res.on('finish', () => {
        if (stopping) setImmediate(() => server.closeIdleConnections())
      })
    })
    const onSignal = (): void => {
      if (stopping) return
      stopping = true
      // Listeners stay attached until the server has closed: a loader such as tsx exits the
      // process on a signal once no other listener remains, which would skip the drain.
      const timer = setTimeout(() => server.closeAllConnections(), drainMs)
      timer.unref()
      server.close(() => {
        clearTimeout(timer)
        for (const signal of STOP_SIGNALS) signals.off(signal, onSignal)
        resolve(0)
      })
    }
    for (const signal of STOP_SIGNALS) signals.on(signal, onSignal)
  })
}

export async function runRemoteMcp(opts: RunRemoteMcpOptions): Promise<number> {
  const log = opts.log ?? stderrLine
  const signals = opts.signals ?? process
  const parsed = parseRemoteMcpConfig(opts.env, TOOL_DEFINITIONS.map((t) => t.name))
  if (!parsed.ok) {
    log(formatConfigError(parsed.error))
    return 1
  }
  const { config } = parsed

  initDb(opts.dbPath)
  const app = createRemoteMcpApp({ config, audit: createStderrAudit(log), healthCheck: archiveHealthCheck })
  const server = createServer(app)

  const listenError = await listen(server, config)
  if (listenError) {
    log(listenErrorLine(listenError, formatAddress(config.host, config.port)))
    return 1
  }

  for (const line of startupLines(config)) log(line)
  const stopped = stopOnSignal(server, signals, opts.drainMs ?? DEFAULT_DRAIN_MS)
  opts.onListening?.(server.address() as AddressInfo)
  return stopped
}
