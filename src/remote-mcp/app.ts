import express, { type Application, type NextFunction, type Request, type Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { IncomingMessage } from 'node:http'
import { getDb } from '../db'
import type { RemoteMcpAudit } from './audit'
import { createRemoteMcpAuth } from './auth'
import type { RemoteMcpClient, RemoteMcpConfig } from './config'
import { createRemoteMcpServer } from './session'

// HTTP composition for the remote MCP endpoint (Req 1.1, 3.1, 5.1, 5.3, 5.5, 5.6, 6.3).
// Fixed middleware order: security headers, GET /healthz (no auth), auth for every
// other path, JSON body up to 1 MiB, POST /mcp, 405 for GET/DELETE /mcp, 404,
// generic error handler. The app never opens the archive: health is injected.
// The stateless SDK transport requires `Accept: application/json, text/event-stream`
// (otherwise 406) and an application/json Content-Type; any type containing
// application/json is parsed here under the limit, anything else is refused with 415.

export interface RemoteMcpAppDeps {
  readonly config: RemoteMcpConfig
  readonly audit: RemoteMcpAudit
  readonly healthCheck: () => boolean
}

const BODY_LIMIT = '1mb'

/** Same case-sensitive test the SDK transport uses, so every body it accepts is parsed under the limit. */
function isJsonType(req: IncomingMessage): boolean {
  return String(req.headers['content-type'] ?? '').includes('application/json')
}

/** Trivial archive query used by the runner as the health check. */
export function archiveHealthCheck(): boolean {
  getDb().prepare('SELECT 1 FROM messages LIMIT 1').get()
  return true
}

function isHealthy(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}

function auditMethods(body: unknown, client: RemoteMcpClient, audit: RemoteMcpAudit): void {
  const messages: unknown[] = Array.isArray(body) ? body : [body]
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const method: unknown = (message as { method?: unknown }).method
    if (method === 'initialize' || method === 'tools/list') audit.record({ op: method, client: client.name })
  }
}

function errorType(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { type?: unknown }).type : undefined
}

export function createRemoteMcpApp(deps: RemoteMcpAppDeps): Application {
  const { config, audit, healthCheck } = deps
  const app = express()
  app.disable('x-powered-by')

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    next()
  })

  app.get('/healthz', (_req: Request, res: Response) => {
    if (isHealthy(healthCheck)) res.status(200).json({ status: 'ok' })
    else res.status(503).json({ status: 'unavailable' })
  })

  app.use(createRemoteMcpAuth({ config, audit }))
  app.use(express.json({ limit: BODY_LIMIT, type: isJsonType }))

  app.post('/mcp', async (req: Request, res: Response) => {
    // Unparsed body: refuse so the SDK never reads the raw stream without a limit.
    if (req.body === undefined) {
      res.status(415).json({ error: 'unsupported media type' })
      return
    }
    const client = res.locals.remoteClient as RemoteMcpClient
    auditMethods(req.body, client, audit)
    const server = createRemoteMcpServer(client, audit)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' })
  }
  app.get('/mcp', methodNotAllowed)
  app.delete('/mcp', methodNotAllowed)

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' })
  })

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const type = errorType(err)
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'payload too large' })
      return
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'bad request' })
      return
    }
    if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
      res.status(415).json({ error: 'unsupported media type' })
      return
    }
    // Message only, JSON-encoded so it cannot break the line; never sent to the client.
    process.stderr.write(`[remote-mcp] internal error: ${JSON.stringify(err instanceof Error ? err.message : String(err))}\n`)
    if (res.headersSent) return next(err)
    res.status(500).json({ error: 'internal error' })
  })

  return app
}
