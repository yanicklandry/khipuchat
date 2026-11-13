import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { createRemoteMcpAuth, findClient } from '../src/remote-mcp/auth'
import { createStderrAudit, type AuditEvent, type AuthFailureReason } from '../src/remote-mcp/audit'
import { parseRemoteMcpConfig, type RemoteMcpConfig } from '../src/remote-mcp/config'

const MUSE_TOKEN = 'muse-token-0123456789abcdef0123456789'
const BOT_TOKEN = 'bot-token-abcdef0123456789abcdef012345'
const TOOLS = ['list_chats', 'search_messages']

function configFrom(env: NodeJS.ProcessEnv): RemoteMcpConfig {
  const result = parseRemoteMcpConfig(env, TOOLS)
  if (!result.ok) throw new Error(`bad test config: ${result.error.kind}`)
  return result.config
}

const BASE_ENV = {
  MCP_TOKEN_MUSE: MUSE_TOKEN,
  MCP_TOKEN_BOT: BOT_TOKEN,
  MCP_ALLOWED_ORIGINS: 'https://Claude.ai/, https://muse.example',
}

interface FakeReqInit {
  readonly headers?: Record<string, string>
  readonly url?: string
  readonly method?: string
  readonly ip?: string
}

function fakeReq(init: FakeReqInit = {}): Request {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v
  return {
    headers,
    method: init.method ?? 'POST',
    originalUrl: init.url ?? '/mcp',
    url: init.url ?? '/mcp',
    ip: init.ip,
    socket: { remoteAddress: '10.0.0.9' },
  } as unknown as Request
}

interface FakeRes {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  locals: Record<string, unknown>
}

function fakeRes(): { res: Response; state: FakeRes } {
  const state: FakeRes = { statusCode: 200, body: undefined, headers: {}, locals: {} }
  const res = {
    locals: state.locals,
    status(code: number) {
      state.statusCode = code
      return res
    },
    set(name: string, value: string) {
      state.headers[name.toLowerCase()] = value
      return res
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value
      return res
    },
    json(body: unknown) {
      state.body = body
      return res
    },
  }
  return { res: res as unknown as Response, state }
}

function run(init: FakeReqInit, env: NodeJS.ProcessEnv = BASE_ENV) {
  const events: AuditEvent[] = []
  const lines: string[] = []
  const stderrAudit = createStderrAudit((line) => lines.push(line))
  const audit = {
    record(event: AuditEvent) {
      events.push(event)
      stderrAudit.record(event)
    },
  }
  const middleware = createRemoteMcpAuth({ config: configFrom(env), audit })
  const { res, state } = fakeRes()
  const next = vi.fn()
  middleware(fakeReq(init), res, next)
  return { state, next, events, lines }
}

function reasonOf(events: readonly AuditEvent[]): AuthFailureReason | undefined {
  const e = events[0]
  return e && e.op === 'auth-failed' ? e.reason : undefined
}

describe('createRemoteMcpAuth: bearer token accepted (3.2, 3.7)', () => {
  it('accepts a configured token with no Origin header and exposes the client (3.2, 3.7)', () => {
    const { state, next, events } = run({ headers: { Authorization: `Bearer ${MUSE_TOKEN}` } })
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
    expect(events).toEqual([])
    const client = state.locals.remoteClient as { name: string }
    expect(client.name).toBe('muse')
  })

  it('resolves the right client among several (3.2)', () => {
    const { state, next } = run({ headers: { Authorization: `Bearer ${BOT_TOKEN}` } })
    expect(next).toHaveBeenCalledTimes(1)
    expect((state.locals.remoteClient as { name: string }).name).toBe('bot')
  })

  it.each(['bearer', 'BEARER', 'BeArEr'])('treats the scheme %s case-insensitively (3.2)', (scheme) => {
    const { state, next } = run({ headers: { Authorization: `${scheme} ${MUSE_TOKEN}` } })
    expect(next).toHaveBeenCalledTimes(1)
    expect((state.locals.remoteClient as { name: string }).name).toBe('muse')
  })

  it('accepts an allowed Origin after normalization (case and trailing slash) (3.6)', () => {
    const { next } = run({ headers: { Origin: 'HTTPS://claude.ai/', Authorization: `Bearer ${MUSE_TOKEN}` } })
    expect(next).toHaveBeenCalledTimes(1)
  })
})

const FAILURES: ReadonlyArray<readonly [string, FakeReqInit, AuthFailureReason]> = [
  ['no Authorization header', {}, 'missing'],
  ['token only in query string (token)', { url: `/mcp?token=${MUSE_TOKEN}` }, 'query-token'],
  ['token only in query string (access_token)', { url: `/mcp?x=1&access_token=${MUSE_TOKEN}` }, 'query-token'],
  ['token only in query string (key)', { url: `/mcp?key=${MUSE_TOKEN}` }, 'query-token'],
  ['token only in query string (auth)', { url: `/mcp?auth=${MUSE_TOKEN}` }, 'query-token'],
  ['token only in query string (TOKEN, any case)', { url: `/mcp?TOKEN=${MUSE_TOKEN}` }, 'query-token'],
  ['unrelated query string', { url: '/mcp?page=2' }, 'missing'],
  ['Basic scheme', { headers: { Authorization: `Basic ${Buffer.from(`u:${MUSE_TOKEN}`).toString('base64')}` } }, 'malformed'],
  ['Bearer with no token', { headers: { Authorization: 'Bearer ' } }, 'malformed'],
  ['Bearer keyword alone', { headers: { Authorization: 'Bearer' } }, 'malformed'],
  ['two spaces after Bearer', { headers: { Authorization: `Bearer  ${MUSE_TOKEN}` } }, 'malformed'],
  ['raw token with no scheme', { headers: { Authorization: MUSE_TOKEN } }, 'malformed'],
  ['token with extra part', { headers: { Authorization: `Bearer ${MUSE_TOKEN} extra` } }, 'malformed'],
  ['empty Authorization header', { headers: { Authorization: '' } }, 'malformed'],
  ['unknown token', { headers: { Authorization: 'Bearer not-a-configured-token-0123456789abc' } }, 'unknown-token'],
  ['prefix of a valid token', { headers: { Authorization: `Bearer ${MUSE_TOKEN.slice(0, -1)}` } }, 'unknown-token'],
  ['header token wins over query check', { url: '/mcp?token=x', headers: { Authorization: 'Bearer wrong' } }, 'unknown-token'],
]

describe('createRemoteMcpAuth: rejections share one 401 shape (3.3, 3.5)', () => {
  it.each(FAILURES)('%s => 401 with reason', (_label, init, reason) => {
    const { state, next, events } = run(init)
    expect(next).not.toHaveBeenCalled()
    expect(state.statusCode).toBe(401)
    expect(state.body).toEqual({ error: 'unauthorized' })
    expect(state.headers['www-authenticate']).toBe('Bearer')
    expect(events).toHaveLength(1)
    expect(reasonOf(events)).toBe(reason)
  })

  it('answers every failure reason with byte-identical bodies and headers (3.3)', () => {
    const bodies = new Set(FAILURES.map(([, init]) => JSON.stringify(run(init).state.body)))
    const challenges = new Set(FAILURES.map(([, init]) => run(init).state.headers['www-authenticate']))
    expect(bodies.size).toBe(1)
    expect(challenges.size).toBe(1)
  })

  it('records method, path without query, and client address (3.5)', () => {
    const { events, lines } = run({ method: 'DELETE', url: `/mcp/x?token=${MUSE_TOKEN}`, ip: '100.64.0.3' })
    expect(events[0]).toEqual({
      op: 'auth-failed',
      reason: 'query-token',
      method: 'DELETE',
      path: `/mcp/x?token=${MUSE_TOKEN}`,
      addr: '100.64.0.3',
    })
    expect(lines[0]).toContain('path=/mcp/x addr=100.64.0.3')
  })

  it('falls back to the socket address when req.ip is missing (3.5)', () => {
    const { events } = run({})
    expect(events[0]).toMatchObject({ addr: '10.0.0.9' })
  })

  it('never puts presented credential text in any log line or response (3.5)', () => {
    const secrets = [MUSE_TOKEN, 'not-a-configured-token-0123456789abc', MUSE_TOKEN.slice(0, -1)]
    for (const [, init] of FAILURES) {
      const { lines, state } = run(init)
      const text = lines.join('\n') + JSON.stringify(state.body) + JSON.stringify(state.headers)
      for (const s of secrets) expect(text).not.toContain(s)
      expect(text).not.toContain(Buffer.from(`u:${MUSE_TOKEN}`).toString('base64'))
    }
  })
})

describe('createRemoteMcpAuth: Origin check (3.6, 3.7)', () => {
  it('rejects a disallowed Origin with 403 before checking the token (3.6)', () => {
    const { state, next, events } = run({
      headers: { Origin: 'https://evil.example', Authorization: `Bearer ${MUSE_TOKEN}` },
    })
    expect(next).not.toHaveBeenCalled()
    expect(state.statusCode).toBe(403)
    expect(state.body).toEqual({ error: 'forbidden' })
    expect(reasonOf(events)).toBe('origin')
    expect(state.locals.remoteClient).toBeUndefined()
  })

  it('rejects a disallowed Origin with 403 even when the token is missing (3.6)', () => {
    const { state, events } = run({ headers: { Origin: 'https://evil.example' } })
    expect(state.statusCode).toBe(403)
    expect(reasonOf(events)).toBe('origin')
  })

  it('rejects any Origin when no origins are configured (3.6)', () => {
    const env = { MCP_TOKEN_MUSE: MUSE_TOKEN }
    const { state } = run({ headers: { Origin: 'https://claude.ai', Authorization: `Bearer ${MUSE_TOKEN}` } }, env)
    expect(state.statusCode).toBe(403)
  })

  it('passes a request without Origin to the token check (3.7)', () => {
    const { state, events } = run({ headers: { Authorization: 'Bearer wrong' } })
    expect(state.statusCode).toBe(401)
    expect(reasonOf(events)).toBe('unknown-token')
  })
})

describe('findClient: constant-time lookup over all clients (3.4, 2.6)', () => {
  it('returns the matching client or undefined', () => {
    const { clients } = configFrom(BASE_ENV)
    expect(findClient(clients, MUSE_TOKEN)?.name).toBe('muse')
    expect(findClient(clients, BOT_TOKEN)?.name).toBe('bot')
    expect(findClient(clients, 'nope')).toBeUndefined()
    expect(findClient([], MUSE_TOKEN)).toBeUndefined()
  })

  it('reads every client digest even when the first one matches (no early exit) (3.4)', () => {
    const { clients } = configFrom(BASE_ENV)
    const reads: string[] = []
    const spied = clients.map((c) => ({
      ...c,
      get tokenDigest() {
        reads.push(c.name)
        return c.tokenDigest
      },
    }))
    const first = spied[0]
    const token = first.name === 'muse' ? MUSE_TOKEN : BOT_TOKEN
    reads.length = 0
    expect(findClient(spied, token)?.name).toBe(first.name)
    expect(new Set(reads)).toEqual(new Set(clients.map((c) => c.name)))
  })

  it("rejects a removed client's former token after re-parsing the config (2.6)", () => {
    const after = configFrom({ MCP_TOKEN_BOT: BOT_TOKEN })
    expect(findClient(after.clients, MUSE_TOKEN)).toBeUndefined()
    const { state, events } = run({ headers: { Authorization: `Bearer ${MUSE_TOKEN}` } }, { MCP_TOKEN_BOT: BOT_TOKEN })
    expect(state.statusCode).toBe(401)
    expect(reasonOf(events)).toBe('unknown-token')
  })
})
