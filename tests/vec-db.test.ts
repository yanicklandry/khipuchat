import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, getDb } from '../src/db'
import {
  isIndexed,
  upsertEmbeddingMeta,
  upsertMessageVector,
  upsertChatVector,
  getUnindexedMessages,
  getUnindexedChats,
  semanticFindContacts,
  semanticSearchMessages,
} from '../src/vec-db'

/** Build a deterministic 384-dim vector with a given base value */
function makeVec(base: number): Float32Array {
  return new Float32Array(384).fill(base)
}

/**
 * Build a 384-dim vector orthogonal to makeVec(x>0): first half +1, second half -1.
 * Cosine distance from makeVec(0.9) ≈ 1.0, well above the 0.7 threshold → filtered out.
 */
function makeOrthogonalVec(): Float32Array {
  const v = new Float32Array(384)
  for (let i = 0; i < 192; i++) v[i] = 1.0
  for (let i = 192; i < 384; i++) v[i] = -1.0
  return v
}

function seedDb() {
  const db = getDb()
  db.exec(`
    INSERT OR IGNORE INTO chats(id, name, type, platform)
      VALUES (1, 'Alice', 'user', 'telegram'),
             (2, 'Bob', 'user', 'imessage');
    INSERT OR IGNORE INTO messages(external_id, chat_id, sender_name, text, type, timestamp, is_sender, platform)
      VALUES ('m1', 1, 'Alice', 'Hello from Shanghai', 'text', 1000, 0, 'telegram'),
             ('m2', 1, 'Alice', 'See you in 2019',     'text', 2000, 0, 'telegram'),
             ('m3', 2, 'Bob',   'iMessage text',        'text', 3000, 0, 'imessage');
  `)
}

describe('vec-db', () => {
  beforeEach(() => {
    initDb(':memory:')
    seedDb()
  })

  it('vec_version() returns a string (extension loaded)', () => {
    const db = getDb()
    const ver = db.prepare('SELECT vec_version()').pluck().get() as string
    expect(typeof ver).toBe('string')
    expect(ver.length).toBeGreaterThan(0)
  })

  it('isIndexed returns false before upsertEmbeddingMeta', () => {
    expect(isIndexed('messages')).toBe(false)
    expect(isIndexed('chats')).toBe(false)
  })

  it('isIndexed returns true after upsertEmbeddingMeta', () => {
    upsertEmbeddingMeta('messages', Date.now())
    expect(isIndexed('messages')).toBe(true)
  })

  it('upsertMessageVector removes message from unindexed list', () => {
    const before = getUnindexedMessages(100)
    expect(before.some(r => r.id > 0)).toBe(true)

    // Index the first message
    upsertMessageVector(before[0].id, makeVec(0.1))
    const after = getUnindexedMessages(100)
    expect(after.find(r => r.id === before[0].id)).toBeUndefined()
  })

  it('upsertChatVector removes chat from unindexed list', () => {
    const before = getUnindexedChats()
    expect(before).toHaveLength(2)

    upsertChatVector(1, makeVec(0.5))
    const after = getUnindexedChats()
    expect(after.find(c => c.id === 1)).toBeUndefined()
    expect(after.find(c => c.id === 2)).toBeDefined()
  })

  it('semanticFindContacts returns results sorted by ascending distance', () => {
    // Seed vectors: chat 1 close to query (distance ~0), chat 2 orthogonal (distance ~1 → filtered)
    upsertChatVector(1, makeVec(0.9))       // same direction as query → distance 0
    upsertChatVector(2, makeOrthogonalVec()) // orthogonal → distance ~1, above 0.7 threshold

    const results = semanticFindContacts(makeVec(0.9), {})
    // chat 1 should come first (smaller distance)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].chat_id).toBe(1)
    results.forEach(r => expect(r.distance).toBeLessThanOrEqual(0.7))
  })

  it('semanticFindContacts platform filter excludes other platforms', () => {
    upsertChatVector(1, makeVec(0.9))
    upsertChatVector(2, makeVec(0.9))

    const results = semanticFindContacts(makeVec(0.9), { platform: 'imessage' })
    results.forEach(r => expect(r.platform).toBe('imessage'))
    expect(results.find(r => r.platform === 'telegram')).toBeUndefined()
  })

  it('semanticSearchMessages before_timestamp excludes later messages', () => {
    // Seed all 3 messages
    upsertMessageVector(1, makeVec(0.8))
    upsertMessageVector(2, makeVec(0.8))
    upsertMessageVector(3, makeVec(0.8))

    // Only messages with timestamp < 2000
    const results = semanticSearchMessages(makeVec(0.8), { before_timestamp: 2000 })
    results.forEach(r => expect(r.timestamp).toBeLessThan(2000))
    expect(results.find(r => r.timestamp >= 2000)).toBeUndefined()
  })

  it('semanticSearchMessages platform filter excludes other platforms', () => {
    upsertMessageVector(1, makeVec(0.8))
    upsertMessageVector(2, makeVec(0.8))
    upsertMessageVector(3, makeVec(0.8))

    const results = semanticSearchMessages(makeVec(0.8), { platform: 'telegram' })
    results.forEach(r => expect(r.platform).toBe('telegram'))
  })
})
