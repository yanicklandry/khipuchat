import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request, RequestHandler, Response } from 'express'
import type { AuthFailureReason, RemoteMcpAudit } from './audit'
import type { RemoteMcpClient, RemoteMcpConfig } from './config'

// Request authentication for the remote MCP endpoint (Req 3.1 to 3.7, 2.6).
// Step 1: a present Origin outside the allowed list => 403 (3.6); no Origin passes (3.7).
// Step 2: only `Authorization: Bearer <token>` is accepted (3.2). Every token
// failure gets the same 401 body and challenge so the response never reveals
// which check failed (3.3). The presented credential is never logged or echoed (3.5).
// Paths are not special-cased here: the app mounts /healthz before this middleware.

const FORBIDDEN_BODY = { error: 'forbidden' } as const
const UNAUTHORIZED_BODY = { error: 'unauthorized' } as const
const BEARER = /^bearer (\S+)$/i
const QUERY_TOKEN_KEYS: readonly string[] = ['token', 'access_token', 'key', 'auth']

type TokenCheck =
  | { readonly ok: true; readonly client: RemoteMcpClient }
  | { readonly ok: false; readonly reason: AuthFailureReason }

/**
 * Digest the presented token once, then compare it with every client digest in
 * constant time. The loop never exits early, so its duration does not depend on
 * which client (if any) matched or how many leading characters matched (3.4).
 */
export function findClient(
  clients: readonly RemoteMcpClient[],
  presentedToken: string,
): RemoteMcpClient | undefined {
  const presented = createHash('sha256').update(presentedToken, 'utf8').digest()
  let match: RemoteMcpClient | undefined
  for (const client of clients) {
    const digest = client.tokenDigest
    const equal = digest.length === presented.length && timingSafeEqual(digest, presented)
    if (equal && match === undefined) match = client
  }
  return match
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '')
}

function hasQueryToken(url: string): boolean {
  const start = url.indexOf('?')
  if (start === -1) return false
  const end = url.indexOf('#', start)
  const params = new URLSearchParams(url.slice(start + 1, end === -1 ? undefined : end))
  for (const key of params.keys()) {
    if (QUERY_TOKEN_KEYS.includes(key.toLowerCase())) return true
  }
  return false
}

function checkToken(req: Request, clients: readonly RemoteMcpClient[]): TokenCheck {
  const header = headerValue(req.headers.authorization)
  if (header === undefined) {
    return { ok: false, reason: hasQueryToken(req.originalUrl) ? 'query-token' : 'missing' }
  }
  const parsed = BEARER.exec(header)
  if (parsed === null) return { ok: false, reason: 'malformed' }
  const client = findClient(clients, parsed[1])
  return client ? { ok: true, client } : { ok: false, reason: 'unknown-token' }
}

function clientAddress(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

export function createRemoteMcpAuth(deps: {
  readonly config: RemoteMcpConfig
  readonly audit: RemoteMcpAudit
}): RequestHandler {
  const { config, audit } = deps

  const reject = (req: Request, reason: AuthFailureReason): void => {
    audit.record({
      op: 'auth-failed',
      reason,
      method: req.method,
      path: req.originalUrl,
      addr: clientAddress(req),
    })
  }

  return (req: Request, res: Response, next) => {
    const origin = headerValue(req.headers.origin)
    if (origin !== undefined && !config.allowedOrigins.has(normalizeOrigin(origin))) {
      reject(req, 'origin')
      res.status(403).json(FORBIDDEN_BODY)
      return
    }

    const result = checkToken(req, config.clients)
    if (!result.ok) {
      reject(req, result.reason)
      res.status(401).set('WWW-Authenticate', 'Bearer').json(UNAUTHORIZED_BODY)
      return
    }

    res.locals.remoteClient = result.client
    next()
  }
}
