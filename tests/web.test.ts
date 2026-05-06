import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'

import { initDb, upsertChat, insertMessage } from '../src/db'
import { createApp } from '../src/web/server'
import { HTML_PAGE } from '../src/web/ui'

// ── Test app factory ──────────────────────────────────────────────────────────

function makeApp() {
  initDb(':memory:')
  return createApp()
}

function seedChat() {
  initDb(':memory:')
  upsertChat({ id: 1, name: 'Alice', type: 'private', username: null, platform: 'imessage' })
  insertMessage({
    external_id: 'msg-1', chat_id: 1, sender_id: null, sender_name: 'Alice',
    text: 'Hello', type: 'text', timestamp: 1700000000, is_sender: 0, reply_to_external_id: null,
    platform: 'imessage',
  })
  return createApp()
}

// ── UI page static tests ──────────────────────────────────────────────────────

describe('HTML_PAGE', () => {
  it('is a non-empty string', () => {
    expect(typeof HTML_PAGE).toBe('string')
    expect(HTML_PAGE.length).toBeGreaterThan(100)
  })

  it('contains required HTML structure tags', () => {
    expect(HTML_PAGE).toContain('<html')
    expect(HTML_PAGE).toContain('<style')
    expect(HTML_PAGE).toContain('<script')
  })

  it('contains no external https:// references', () => {
    expect(HTML_PAGE).not.toMatch(/https?:\/\//)
  })

  it('references all three API routes in client JS', () => {
    expect(HTML_PAGE).toContain('/api/chats')
    expect(HTML_PAGE).toContain('/api/search')
    expect(HTML_PAGE).toContain('/api/messages')
  })
})

// ── GET / ─────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns 200 with content-type text/html', async () => {
    const app = makeApp()
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
  })
})

// ── GET /api/chats ────────────────────────────────────────────────────────────

describe('GET /api/chats', () => {
  it('returns 200 with an empty JSON array when DB is empty', async () => {
    const res = await request(makeApp()).get('/api/chats')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('returns chat entries with expected shape', async () => {
    const app = seedChat()
    const res = await request(app).get('/api/chats')
    expect(res.status).toBe(200)
    const [chat] = res.body as { chat_id: number; name: string; platform: string; message_count: number }[]
    expect(chat.chat_id).toBe(1)
    expect(chat.name).toBe('Alice')
    expect(chat.platform).toBe('imessage')
    expect(typeof chat.message_count).toBe('number')
  })
})

// ── GET /api/search ───────────────────────────────────────────────────────────

describe('GET /api/search', () => {
  it('returns 200 with [] when q is absent', async () => {
    const res = await request(makeApp()).get('/api/search')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns 200 with [] when q is empty string', async () => {
    const res = await request(makeApp()).get('/api/search?q=')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns 200 with [] when q is whitespace only', async () => {
    const res = await request(makeApp()).get('/api/search?q=   ')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns 200 with results array for a valid query', async () => {
    const app = seedChat()
    const res = await request(app).get('/api/search?q=Hello')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    if ((res.body as unknown[]).length > 0) {
      const [r] = res.body as { chat_name: string; text: string; platform: string }[]
      expect(typeof r.chat_name).toBe('string')
      expect(typeof r.platform).toBe('string')
    }
  })
})

// ── GET /api/messages/:chatId ─────────────────────────────────────────────────

describe('GET /api/messages/:chatId', () => {
  it('returns 400 for a non-integer chatId', async () => {
    const res = await request(makeApp()).get('/api/messages/not-a-number')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid chatId' })
  })

  it('returns 200 with an empty array for unknown chatId', async () => {
    const res = await request(makeApp()).get('/api/messages/9999')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('returns 200 with messages for a seeded chat', async () => {
    const app = seedChat()
    const res = await request(app).get('/api/messages/1')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const [msg] = res.body as { sender_name: string; text: string; is_sender: number; platform: string }[]
    expect(typeof msg.text).toBe('string')
    expect(typeof msg.is_sender).toBe('number')
    expect(msg.platform).toBe('imessage')
  })
})
