import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import Database from 'better-sqlite3-multiple-ciphers'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initDb } from '../src/db'
import { createApp } from '../src/web/server'

// ── DB encryption ─────────────────────────────────────────────────────────────

describe('DB encryption (DB_KEY)', () => {
  let tmpPath: string

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `khipu-sec-${Date.now()}.db`)
    delete process.env['DB_KEY']
  })

  afterEach(() => {
    delete process.env['DB_KEY']
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  })

  it(':memory: DB works whether DB_KEY is set or not', () => {
    process.env['DB_KEY'] = 'supersecret'
    expect(() => initDb(':memory:')).not.toThrow()
    delete process.env['DB_KEY']
  })

  it('unencrypted DB opens normally when DB_KEY is not set', () => {
    initDb(tmpPath)
    expect(fs.existsSync(tmpPath)).toBe(true)
  })

  it('DB encrypted with DB_KEY cannot be opened with plain better-sqlite3-multiple-ciphers', () => {
    process.env['DB_KEY'] = 'mykey'
    initDb(tmpPath)
    delete process.env['DB_KEY']

    // Opening without key should fail on query (SQLITE_NOTADB or encryption error)
    const plain = new Database(tmpPath, { readonly: true })
    expect(() => plain.pragma('user_version')).toThrow()
    try { plain.close() } catch { /* ignore */ }
  })
})

// ── Web auth (WEB_USER / WEB_PASS) ────────────────────────────────────────────

describe('Web auth (WEB_USER + WEB_PASS)', () => {
  beforeEach(() => {
    initDb(':memory:')
    delete process.env['WEB_USER']
    delete process.env['WEB_PASS']
  })

  afterEach(() => {
    delete process.env['WEB_USER']
    delete process.env['WEB_PASS']
  })

  it('GET /api/chats returns 200 when no auth is configured', async () => {
    const app = createApp()
    const res = await request(app).get('/api/chats')
    expect(res.status).toBe(200)
  })

  it('GET / (index) always returns 200 regardless of auth', async () => {
    process.env['WEB_USER'] = 'admin'
    process.env['WEB_PASS'] = 'pass'
    const app = createApp()
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
  })

  it('GET /api/chats returns 401 when auth is configured and no credentials given', async () => {
    process.env['WEB_USER'] = 'admin'
    process.env['WEB_PASS'] = 'secret'
    const app = createApp()
    const res = await request(app).get('/api/chats')
    expect(res.status).toBe(401)
  })

  it('GET /api/chats returns 200 with valid Basic auth credentials', async () => {
    process.env['WEB_USER'] = 'admin'
    process.env['WEB_PASS'] = 'secret'
    const app = createApp()
    const res = await request(app)
      .get('/api/chats')
      .auth('admin', 'secret')
    expect(res.status).toBe(200)
  })

  it('GET /api/chats returns 401 with wrong credentials', async () => {
    process.env['WEB_USER'] = 'admin'
    process.env['WEB_PASS'] = 'secret'
    const app = createApp()
    const res = await request(app)
      .get('/api/chats')
      .auth('admin', 'wrong')
    expect(res.status).toBe(401)
  })
})

// ── MCP bearer token ──────────────────────────────────────────────────────────

import { createMcpServer } from '../src/mcp'

describe('MCP bearer token (MCP_SECRET)', () => {
  beforeEach(() => {
    initDb(':memory:')
    delete process.env['MCP_SECRET']
  })

  afterEach(() => {
    delete process.env['MCP_SECRET']
  })

  it('all tool calls are allowed when MCP_SECRET is not set', async () => {
    const server = createMcpServer()
    const result = await (server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>
    })._requestHandlers.get('tools/call')?.({
      method: 'tools/call',
      params: { name: 'list_chats', arguments: {} },
    })
    // Should get a result with content, not an error
    expect((result as { content?: unknown }).content).toBeDefined()
  })

  it('returns Unauthorized when MCP_SECRET is set and token is missing', async () => {
    process.env['MCP_SECRET'] = 'token123'
    const server = createMcpServer()
    const result = await (server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>
    })._requestHandlers.get('tools/call')?.({
      method: 'tools/call',
      params: { name: 'list_chats', arguments: {}, _meta: {} },
    })
    expect((result as { error?: { code: number; message: string } }).error?.code).toBe(-32001)
    expect((result as { error?: { message: string } }).error?.message).toBe('Unauthorized')
  })

  it('dispatches correctly when correct bearer token is provided', async () => {
    process.env['MCP_SECRET'] = 'token123'
    const server = createMcpServer()
    const result = await (server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>
    })._requestHandlers.get('tools/call')?.({
      method: 'tools/call',
      params: {
        name: 'list_chats', arguments: {},
        _meta: { authorization: 'Bearer token123' },
      },
    })
    expect((result as { content?: unknown }).content).toBeDefined()
  })
})
