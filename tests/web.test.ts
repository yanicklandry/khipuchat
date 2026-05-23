import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'

import { initDb, upsertChat, insertMessage } from '../src/db'
import { createApp } from '../src/web/server'
import { HTML_PAGE } from '../src/web/ui'

vi.mock('../src/vec-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vec-db')>()
  return {
    ...actual,
    isIndexed: vi.fn().mockReturnValue(false),
    semanticSearchMessages: vi.fn().mockReturnValue([]),
  }
})

vi.mock('../src/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings')>()
  return {
    ...actual,
    embedOne: vi.fn().mockResolvedValue(new Float32Array(384)),
  }
})

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

  it('contains no external resource references (CDN, remote scripts, etc.)', () => {
    // SVG xmlns namespace URIs (http://www.w3.org/...) are stripped from inline SVGs,
    // so any remaining http(s) URLs would be unwanted external resource loads.
    const withoutSvgNamespace = HTML_PAGE.replace(/xmlns="[^"]+"/g, '')
    expect(withoutSvgNamespace).not.toMatch(/https?:\/\//)
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

  it('returns 200 with { messages: [], has_more: false } for unknown chatId', async () => {
    const res = await request(makeApp()).get('/api/messages/9999')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('messages')
    expect(Array.isArray(res.body.messages)).toBe(true)
    expect(res.body.has_more).toBe(false)
  })

  it('returns 200 with { messages, has_more } for a seeded chat', async () => {
    const app = seedChat()
    const res = await request(app).get('/api/messages/1')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('messages')
    expect(res.body).toHaveProperty('has_more')
    expect(Array.isArray(res.body.messages)).toBe(true)
    const [msg] = res.body.messages as { sender_name: string; text: string; is_sender: number; platform: string }[]
    expect(typeof msg.text).toBe('string')
    expect(typeof msg.is_sender).toBe('number')
    expect(msg.platform).toBe('imessage')
  })

  it('returns 400 for non-integer before param', async () => {
    const res = await request(makeApp()).get('/api/messages/1?before=abc')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid before parameter' })
  })

  it('returns 400 for negative before param', async () => {
    const res = await request(makeApp()).get('/api/messages/1?before=-1')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid before parameter' })
  })

  it('returns 400 for limit out of range (> 100)', async () => {
    const res = await request(makeApp()).get('/api/messages/1?limit=200')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid limit parameter' })
  })

  it('returns 400 for non-integer limit param', async () => {
    const res = await request(makeApp()).get('/api/messages/1?limit=abc')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid limit parameter' })
  })

  it('returns 400 for limit of 0', async () => {
    const res = await request(makeApp()).get('/api/messages/1?limit=0')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid limit parameter' })
  })

  it('returns messages with has_more: false for before timestamp beyond all messages', async () => {
    const app = seedChat()
    const res = await request(app).get('/api/messages/1?before=99999')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.messages)).toBe(true)
    expect(res.body.has_more).toBe(false)
  })

  it('returns 400 for before=0', async () => {
    const res = await request(makeApp()).get('/api/messages/1?before=0')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid before parameter' })
  })

  it('without before returns most recent messages (not oldest), sorted ascending', async () => {
    initDb(':memory:')
    upsertChat({ id: 2, name: 'Bob', type: 'private', username: null, platform: 'imessage' })
    // Insert 5 messages with distinct timestamps
    for (let i = 1; i <= 5; i++) {
      insertMessage({
        external_id: `msg-ts-${i}`, chat_id: 2, sender_id: null, sender_name: 'Bob',
        text: `Message ${i}`, type: 'text', timestamp: 1700000000 + i * 100,
        is_sender: 0, reply_to_external_id: null, platform: 'imessage',
      })
    }
    const app = createApp()
    // With limit=3, should return messages 3, 4, 5 (most recent), not 1, 2, 3 (oldest)
    const res = await request(app).get('/api/messages/2?limit=3')
    expect(res.status).toBe(200)
    const msgs = res.body.messages as { text: string; timestamp: number }[]
    expect(msgs).toHaveLength(3)
    // Must be sorted ascending
    expect(msgs[0].timestamp).toBeLessThan(msgs[1].timestamp)
    expect(msgs[1].timestamp).toBeLessThan(msgs[2].timestamp)
    // The most recent 3 are timestamps 300, 400, 500 (messages 3, 4, 5)
    expect(msgs[0].text).toBe('Message 3')
    expect(msgs[2].text).toBe('Message 5')
    // has_more should be true since there are 2 more older messages
    expect(res.body.has_more).toBe(true)
  })
})

// ── GET /api/semantic-search ──────────────────────────────────────────────────

describe('GET /api/semantic-search', () => {
  beforeEach(async () => {
    const { isIndexed, semanticSearchMessages } = await import('../src/vec-db')
    const { embedOne } = await import('../src/embeddings')
    vi.mocked(isIndexed).mockReturnValue(false)
    vi.mocked(semanticSearchMessages).mockReturnValue([])
    vi.mocked(embedOne).mockResolvedValue(new Float32Array(384))
  })

  it('returns 200 with [] when q is absent', async () => {
    const res = await request(makeApp()).get('/api/semantic-search')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns 200 results array matching SearchResult shape when index is seeded', async () => {
    const { isIndexed, semanticSearchMessages } = await import('../src/vec-db')
    vi.mocked(isIndexed).mockReturnValue(true)
    vi.mocked(semanticSearchMessages).mockReturnValue([
      {
        chat_id: 1,
        chat_name: 'Alice',
        sender_name: 'Alice',
        text: 'Hello there',
        timestamp: 1700000000,
        platform: 'imessage',
        distance: 0.1,
      },
    ])

    const res = await request(makeApp()).get('/api/semantic-search?q=hello')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const [r] = res.body as { chat_id: number; chat_name: string; sender_name: string; text: string; timestamp: number; platform: string }[]
    expect(typeof r.chat_id).toBe('number')
    expect(typeof r.chat_name).toBe('string')
    expect(typeof r.sender_name).toBe('string')
    expect(typeof r.text).toBe('string')
    expect(typeof r.timestamp).toBe('number')
    expect(typeof r.platform).toBe('string')
  })

  it('returns 200 with error and empty results when index is not built', async () => {
    const { isIndexed } = await import('../src/vec-db')
    vi.mocked(isIndexed).mockReturnValue(false)

    const res = await request(makeApp()).get('/api/semantic-search?q=hello')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('error')
    expect(Array.isArray(res.body.results)).toBe(true)
    expect(res.body.results).toHaveLength(0)
  })

  it('returns 400 for invalid limit parameter', async () => {
    const res = await request(makeApp()).get('/api/semantic-search?q=hello&limit=abc')
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
  })
})
