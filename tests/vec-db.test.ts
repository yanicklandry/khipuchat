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
  clearMessageVectors,
  clearChatVectors,
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
    INSERT OR IGNORE INTO chats(id, name, type, platform, account, external_id)
      VALUES (1, 'Alice', 'user', 'telegram', 'personal', '1'),
             (2, 'Bob', 'user', 'imessage', 'default', '2'),
             (3, 'Charlie', 'user', 'telegram', 'work', '3');
    INSERT OR IGNORE INTO messages(external_id, chat_id, sender_name, text, type, timestamp, is_sender, platform)
      VALUES ('m1', 1, 'Alice', 'Hello from Shanghai', 'text', 1000, 0, 'telegram'),
             ('m2', 1, 'Alice', 'See you in 2019',     'text', 2000, 0, 'telegram'),
             ('m3', 2, 'Bob',   'iMessage text',        'text', 3000, 0, 'imessage'),
             ('m4', 3, 'Charlie', 'Work message',       'text', 4000, 0, 'telegram');
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
    expect(before).toHaveLength(3)

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

  it('semanticFindContacts result contains account field', () => {
    upsertChatVector(1, makeVec(0.9))

    const results = semanticFindContacts(makeVec(0.9), {})
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].account).toBeDefined()
    expect(typeof results[0].account).toBe('string')
  })

  it('semanticSearchMessages result contains account field', () => {
    upsertMessageVector(1, makeVec(0.8))

    const results = semanticSearchMessages(makeVec(0.8), {})
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].account).toBeDefined()
    expect(typeof results[0].account).toBe('string')
  })

  it('semanticFindContacts account filter returns only matching account', () => {
    upsertChatVector(1, makeVec(0.9))  // account='personal'
    upsertChatVector(2, makeVec(0.9))  // account='default'
    upsertChatVector(3, makeVec(0.9))  // account='work'

    const results = semanticFindContacts(makeVec(0.9), { account: 'work' })
    expect(results.length).toBeGreaterThan(0)
    results.forEach(r => expect(r.account).toBe('work'))
    expect(results.find(r => r.account !== 'work')).toBeUndefined()
  })

  it('semanticSearchMessages account filter returns only matching account', () => {
    upsertMessageVector(1, makeVec(0.8))  // chat 1 => account='personal'
    upsertMessageVector(3, makeVec(0.8))  // chat 2 => account='default'
    upsertMessageVector(4, makeVec(0.8))  // chat 3 => account='work'

    const results = semanticSearchMessages(makeVec(0.8), { account: 'work' })
    expect(results.length).toBeGreaterThan(0)
    results.forEach(r => expect(r.account).toBe('work'))
  })

  it('semanticFindContacts without account filter returns results from all accounts', () => {
    upsertChatVector(1, makeVec(0.9))  // account='personal'
    upsertChatVector(2, makeVec(0.9))  // account='default'
    upsertChatVector(3, makeVec(0.9))  // account='work'

    const results = semanticFindContacts(makeVec(0.9), {})
    const accounts = new Set(results.map(r => r.account))
    expect(accounts.size).toBeGreaterThan(1)
  })

  it('semanticSearchMessages without account filter returns results from all accounts', () => {
    upsertMessageVector(1, makeVec(0.8))  // chat 1 => account='personal'
    upsertMessageVector(3, makeVec(0.8))  // chat 2 => account='default'
    upsertMessageVector(4, makeVec(0.8))  // chat 3 => account='work'

    const results = semanticSearchMessages(makeVec(0.8), {})
    const accounts = new Set(results.map(r => r.account))
    expect(accounts.size).toBeGreaterThan(1)
  })

  describe('clearMessageVectors', () => {
    beforeEach(() => {
      // Seed messages 1-4 with vectors: 1,2 on telegram; 3 on imessage; 4 on telegram
      upsertMessageVector(1, makeVec(0.1))
      upsertMessageVector(2, makeVec(0.2))
      upsertMessageVector(3, makeVec(0.3))
      upsertMessageVector(4, makeVec(0.4))
    })

    it('global clear removes all rows from vec_messages', () => {
      clearMessageVectors()
      const count = getDb()
        .prepare('SELECT COUNT(*) AS n FROM vec_messages')
        .pluck()
        .get() as number
      expect(count).toBe(0)
    })

    it('platform-scoped clear removes only that platform\'s vectors', () => {
      // messages 1,2,4 are telegram; message 3 is imessage
      clearMessageVectors('telegram')
      const remaining = getDb()
        .prepare('SELECT rowid FROM vec_messages ORDER BY rowid')
        .pluck()
        .all() as bigint[]
      // Only message 3 (imessage) should remain
      expect(remaining.map(Number)).toEqual([3])
    })

    it('platform-scoped clear leaves other platforms untouched', () => {
      clearMessageVectors('imessage')
      const remaining = getDb()
        .prepare('SELECT rowid FROM vec_messages ORDER BY rowid')
        .pluck()
        .all() as bigint[]
      // Messages 1, 2, 4 (telegram) should remain; message 3 (imessage) gone
      expect(remaining.map(Number)).toEqual([1, 2, 4])
    })
  })

  describe('clearChatVectors', () => {
    beforeEach(() => {
      // Seed chats 1,3 on telegram; chat 2 on imessage
      upsertChatVector(1, makeVec(0.1))
      upsertChatVector(2, makeVec(0.2))
      upsertChatVector(3, makeVec(0.3))
    })

    it('global clear removes all rows from vec_chats', () => {
      clearChatVectors()
      const count = getDb()
        .prepare('SELECT COUNT(*) AS n FROM vec_chats')
        .pluck()
        .get() as number
      expect(count).toBe(0)
    })

    it('platform-scoped clear removes only that platform\'s chat vectors', () => {
      // chats 1,3 are telegram; chat 2 is imessage
      clearChatVectors('telegram')
      const remaining = getDb()
        .prepare('SELECT rowid FROM vec_chats ORDER BY rowid')
        .pluck()
        .all() as bigint[]
      // Only chat 2 (imessage) should remain
      expect(remaining.map(Number)).toEqual([2])
    })

    it('platform-scoped clear leaves other platforms untouched', () => {
      clearChatVectors('imessage')
      const remaining = getDb()
        .prepare('SELECT rowid FROM vec_chats ORDER BY rowid')
        .pluck()
        .all() as bigint[]
      // Chats 1, 3 (telegram) should remain; chat 2 (imessage) gone
      expect(remaining.map(Number)).toEqual([1, 3])
    })
  })
})
