import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock heavy ONNX runtime — same pattern as embeddings.test.ts
vi.mock('@huggingface/transformers', () => {
  const makeVec = (seed: number) => new Float32Array(384).fill(seed)
  return {
    pipeline: vi.fn().mockResolvedValue(
      vi.fn().mockImplementation(async (texts: string | string[]) => {
        const arr = Array.isArray(texts) ? texts : [texts]
        const flat = new Float32Array(arr.length * 384)
        arr.forEach((t, i) => flat.set(makeVec(t.length % 10), i * 384))
        return { data: flat, dims: [arr.length, 384], type: 'float32' }
      }),
    ),
    env: { cacheDir: '', allowRemoteModels: true },
  }
})

import { initDb, getDb, upsertChat, insertMessage } from '../src/db'
import { getUnindexedMessages, getUnindexedChats } from '../src/vec-db'
import { rebuildEmbeddings } from '../src/index-embeddings'

function seedDb() {
  const db = getDb()
  db.exec(`
    INSERT OR IGNORE INTO chats(id, name, type, platform)
      VALUES (1, 'Alice', 'user', 'telegram'),
             (2, 'Bob',   'user', 'imessage');
    INSERT OR IGNORE INTO messages(external_id, chat_id, sender_name, text, type, timestamp, is_sender, platform)
      VALUES ('m1', 1, 'Alice', 'Hello from Shanghai', 'text', 1000, 0, 'telegram'),
             ('m2', 1, 'Alice', 'See you tomorrow',    'text', 2000, 0, 'telegram'),
             ('m3', 2, 'Bob',   'iMessage content',    'text', 3000, 0, 'imessage');
  `)
}

describe('rebuildEmbeddings', () => {
  beforeEach(() => {
    initDb(':memory:')
    seedDb()
  })

  it('is exported from index-embeddings', () => {
    expect(typeof rebuildEmbeddings).toBe('function')
  })

  it('with no argument indexes all messages and chats', async () => {
    const unindexedMsgsBefore = getUnindexedMessages(100)
    const unindexedChatsBefore = getUnindexedChats()
    expect(unindexedMsgsBefore).toHaveLength(3)
    expect(unindexedChatsBefore).toHaveLength(2)

    await rebuildEmbeddings()

    expect(getUnindexedMessages(100)).toHaveLength(0)
    expect(getUnindexedChats()).toHaveLength(0)
  })

  it('with platform=telegram indexes only telegram messages', async () => {
    await rebuildEmbeddings('telegram')

    const db = getDb()

    // All telegram messages should be indexed in vec_messages
    const telegramMsgIds = db.prepare(
      `SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.platform = 'telegram'`
    ).all() as Array<{ id: number }>
    for (const { id } of telegramMsgIds) {
      const row = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(id))
      expect(row, `telegram message ${id} should be in vec_messages`).toBeDefined()
    }

    // iMessage messages should NOT be indexed
    const imessageMsgIds = db.prepare(
      `SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.platform = 'imessage'`
    ).all() as Array<{ id: number }>
    for (const { id } of imessageMsgIds) {
      const row = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(id))
      expect(row, `imessage message ${id} should NOT be in vec_messages`).toBeUndefined()
    }
  })

  it('with platform=telegram indexes only telegram chats', async () => {
    await rebuildEmbeddings('telegram')

    const db = getDb()

    // telegram chat (id=1) should be indexed
    const telegramChatRow = db.prepare('SELECT rowid FROM vec_chats WHERE rowid = ?').get(1n)
    expect(telegramChatRow).toBeDefined()

    // imessage chat (id=2) should NOT be indexed
    const imessageChatRow = db.prepare('SELECT rowid FROM vec_chats WHERE rowid = ?').get(2n)
    expect(imessageChatRow).toBeUndefined()
  })

  it('with platform=imessage indexes only imessage messages and chats', async () => {
    await rebuildEmbeddings('imessage')

    const db = getDb()

    // imessage message (m3, chat_id=2) should be indexed
    const imessageMsgIds = db.prepare(
      `SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.platform = 'imessage'`
    ).all() as Array<{ id: number }>
    for (const { id } of imessageMsgIds) {
      const row = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(id))
      expect(row).toBeDefined()
    }

    // telegram messages should NOT be indexed
    const telegramMsgIds = db.prepare(
      `SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.platform = 'telegram'`
    ).all() as Array<{ id: number }>
    for (const { id } of telegramMsgIds) {
      const row = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(id))
      expect(row).toBeUndefined()
    }
  })
})
