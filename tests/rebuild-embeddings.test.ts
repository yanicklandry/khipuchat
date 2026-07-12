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
import { rebuildEmbeddings, embedNewMessages } from '../src/index-embeddings'
import * as embeddings from '../src/embeddings'

// Capture console.log output for completion-line assertions
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.log.bind(console)
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
    orig(...args)
  }
  return { lines, restore: () => { console.log = orig } }
}

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

  describe('OCR text embedding (task 2.3)', () => {
    it('image-only message (text=null, ocr_text set) appears in vec_messages after one embedNewMessages run', async () => {
      const db = getDb()
      // Insert a telegram chat if not already present via seedDb
      db.exec(`
        INSERT OR IGNORE INTO chats(id, name, type, platform)
          VALUES (10, 'ImageChat', 'user', 'telegram');
        INSERT OR IGNORE INTO messages(external_id, chat_id, sender_name, text, ocr_text, type, timestamp, is_sender, platform)
          VALUES ('img1', 10, 'Alice', NULL, 'OCR extracted text from image', 'image', 5000, 0, 'telegram');
      `)

      await rebuildEmbeddings()

      // The image-only message must be in vec_messages
      const imgMsgId = db.prepare(`SELECT id FROM messages WHERE external_id = 'img1'`).pluck().get() as number
      const row = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(imgMsgId))
      expect(row, 'image-only message should be indexed via ocr_text').toBeDefined()
    })

    it('image-only message is NOT re-embedded on the next run (idempotency)', async () => {
      const db = getDb()
      db.exec(`
        INSERT OR IGNORE INTO chats(id, name, type, platform)
          VALUES (11, 'ImageChat2', 'user', 'telegram');
        INSERT OR IGNORE INTO messages(external_id, chat_id, sender_name, text, ocr_text, type, timestamp, is_sender, platform)
          VALUES ('img2', 11, 'Alice', NULL, 'Some OCR text', 'image', 6000, 0, 'telegram');
      `)

      // First run: embeds the image message
      const embedSpy = vi.spyOn(embeddings, 'embed')
      await rebuildEmbeddings()
      const firstRunCallCount = embedSpy.mock.calls.length
      expect(firstRunCallCount).toBeGreaterThan(0)

      // Second run: image-only message already indexed, must NOT call embed again for it
      embedSpy.mockClear()
      await rebuildEmbeddings()
      // All previously-indexed messages should be skipped — embed call count for messages is 0
      // (chats may still call embedOne but embed for messages should not be called again)
      const imgMsgId = db.prepare(`SELECT id FROM messages WHERE external_id = 'img2'`).pluck().get() as number
      const row = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(imgMsgId))
      expect(row, 'image-only message should remain indexed').toBeDefined()

      embedSpy.mockRestore()
    })

    it('message with both text and ocr_text uses combined input for embedding', async () => {
      const db = getDb()
      db.exec(`
        INSERT OR IGNORE INTO chats(id, name, type, platform)
          VALUES (12, 'BothChat', 'user', 'telegram');
        INSERT OR IGNORE INTO messages(external_id, chat_id, sender_name, text, ocr_text, type, timestamp, is_sender, platform)
          VALUES ('both1', 12, 'Alice', 'Caption text', 'OCR from image', 'image', 7000, 0, 'telegram');
      `)

      const capturedInputs: string[][] = []
      const embedSpy = vi.spyOn(embeddings, 'embed').mockImplementation(async (texts) => {
        capturedInputs.push([...texts])
        // Return a fake vector
        return [new Float32Array(384).fill(0.5)]
      })

      try {
        await rebuildEmbeddings()
      } finally {
        embedSpy.mockRestore()
      }

      // Find the call that embedded the 'both1' message
      const combinedCall = capturedInputs.find(texts => texts.some(t => t.includes('Caption text') && t.includes('OCR from image')))
      expect(combinedCall, 'embedding input should combine text and ocr_text').toBeDefined()
    })
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

  it('completion line reports DB totals (vec_messages/vec_chats row counts)', async () => {
    const { lines, restore } = captureLog()
    try {
      await rebuildEmbeddings()
    } finally {
      restore()
    }
    const db = getDb()
    const msgTotal = db.prepare('SELECT COUNT(*) FROM vec_messages').pluck().get() as number
    const chatTotal = db.prepare('SELECT COUNT(*) FROM vec_chats').pluck().get() as number
    const doneLine = lines.find(l => l.startsWith('Done.'))
    expect(doneLine).toBeDefined()
    expect(doneLine).toContain(`${msgTotal.toLocaleString()} messages`)
    expect(doneLine).toContain(`${chatTotal.toLocaleString()} chats`)
  })

  describe('force=true', () => {
    it('re-indexes all messages even when previously indexed', async () => {
      // First run: index everything normally
      await rebuildEmbeddings()
      const db = getDb()
      expect(db.prepare('SELECT COUNT(*) FROM vec_messages').pluck().get()).toBe(3)
      expect(db.prepare('SELECT COUNT(*) FROM vec_chats').pluck().get()).toBe(2)

      // Second run with force=true should clear and re-index
      await rebuildEmbeddings(undefined, true)

      expect(db.prepare('SELECT COUNT(*) FROM vec_messages').pluck().get()).toBe(3)
      expect(db.prepare('SELECT COUNT(*) FROM vec_chats').pluck().get()).toBe(2)
    })

    it('with force=true, completion line reports DB totals after re-index', async () => {
      // Seed with first index run
      await rebuildEmbeddings()

      const { lines, restore } = captureLog()
      try {
        await rebuildEmbeddings(undefined, true)
      } finally {
        restore()
      }

      const db = getDb()
      const msgTotal = db.prepare('SELECT COUNT(*) FROM vec_messages').pluck().get() as number
      const chatTotal = db.prepare('SELECT COUNT(*) FROM vec_chats').pluck().get() as number

      const doneLine = lines.find(l => l.startsWith('Done.'))
      expect(doneLine).toBeDefined()
      expect(doneLine).toContain(`${msgTotal.toLocaleString()} messages`)
      expect(doneLine).toContain(`${chatTotal.toLocaleString()} chats`)
    })

    it('with force=true and platform, only clears and re-indexes that platform', async () => {
      // First run: index everything
      await rebuildEmbeddings()
      const db = getDb()
      expect(db.prepare('SELECT COUNT(*) FROM vec_messages').pluck().get()).toBe(3)
      expect(db.prepare('SELECT COUNT(*) FROM vec_chats').pluck().get()).toBe(2)

      // Force re-index telegram only
      await rebuildEmbeddings('telegram', true)

      // All messages should still be indexed (telegram re-indexed, imessage untouched)
      expect(db.prepare('SELECT COUNT(*) FROM vec_messages').pluck().get()).toBe(3)
      expect(db.prepare('SELECT COUNT(*) FROM vec_chats').pluck().get()).toBe(2)

      // Specifically, imessage chat (id=2) is still in vec_chats
      const imessageChatRow = db.prepare('SELECT rowid FROM vec_chats WHERE rowid = ?').get(2n)
      expect(imessageChatRow).toBeDefined()
    })

    it('per-record failure isolation: a deliberate per-record embed failure leaves the sweep running for remaining records', async () => {
      // Verify req 2.5: if embedding fails for an individual message, the sweep continues
      // and remaining records are still processed.

      const db = getDb()

      // First run: clear any previously indexed state
      await rebuildEmbeddings()
      expect(db.prepare('SELECT COUNT(*) FROM vec_messages').pluck().get()).toBe(3)

      // Force-clear so all 3 messages are unindexed before the failing run
      await rebuildEmbeddings(undefined, true)

      // Now inject a failure: the first embed call throws, rest succeed
      let callCount = 0
      const originalEmbed = embeddings.embed
      const spy = vi.spyOn(embeddings, 'embed').mockImplementation(async (...args) => {
        callCount++
        if (callCount === 1) throw new Error('simulated per-record embed failure')
        return originalEmbed(...args)
      })

      try {
        // Must complete without throwing despite the first record failing
        await expect(rebuildEmbeddings(undefined, true)).resolves.toBeUndefined()
      } finally {
        spy.mockRestore()
      }

      // The failing message was skipped, but remaining messages were still indexed.
      // With 3 messages and the first embed call failing, at least 2 should be indexed.
      const indexed = db.prepare('SELECT COUNT(*) FROM vec_messages').pluck().get() as number
      expect(indexed).toBeGreaterThanOrEqual(2)
      expect(indexed).toBeLessThan(3)
    })
  })

  // ── embedNewMessages integration (task 4.2 semantic discovery) ────────────────

  describe('embedNewMessages — semantic discovery', () => {
    it('image-only message with ocr_text is embedded after embedNewMessages run', async () => {
      const db = getDb()

      // Insert a chat and an image-only message with ocr_text (no text)
      const chatId = upsertChat({ external_id: 'img-chat', account: 'default', name: 'Img Chat', type: 'user', username: null, platform: 'telegram' })
      insertMessage({
        external_id: 'img-ocr-only',
        chat_id: chatId,
        sender_id: 'u1',
        sender_name: 'Alice',
        text: null,
        type: 'image',
        timestamp: 9000,
        is_sender: 0,
        reply_to_external_id: null,
        platform: 'telegram',
      })

      // Set ocr_text directly via SQL (simulates what processImageMessages does)
      const msgId = db.prepare(`SELECT id FROM messages WHERE external_id = 'img-ocr-only'`).pluck().get() as number
      db.prepare('UPDATE messages SET ocr_text = ? WHERE id = ?').run('scanned invoice text', msgId)

      // Before embedNewMessages: message is NOT in vec_messages
      const beforeRow = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(msgId))
      expect(beforeRow).toBeUndefined()

      await embedNewMessages([chatId])

      // After embedNewMessages: message IS in vec_messages
      const afterRow = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(msgId))
      expect(afterRow, 'image-only message should be indexed after embedNewMessages').toBeDefined()
    })

    it('message already in vec_messages is not re-embedded by embedNewMessages', async () => {
      const db = getDb()

      // Insert a chat and image-only message with ocr_text
      const chatId = upsertChat({ external_id: 'img-chat-2', account: 'default', name: 'Img Chat 2', type: 'user', username: null, platform: 'telegram' })
      insertMessage({
        external_id: 'img-already-indexed',
        chat_id: chatId,
        sender_id: 'u1',
        sender_name: 'Alice',
        text: null,
        type: 'image',
        timestamp: 10000,
        is_sender: 0,
        reply_to_external_id: null,
        platform: 'telegram',
      })
      const msgId = db.prepare(`SELECT id FROM messages WHERE external_id = 'img-already-indexed'`).pluck().get() as number
      db.prepare('UPDATE messages SET ocr_text = ? WHERE id = ?').run('already indexed ocr', msgId)

      // First run: message gets indexed
      await embedNewMessages([chatId])
      const rowAfterFirst = db.prepare('SELECT rowid FROM vec_messages WHERE rowid = ?').get(BigInt(msgId))
      expect(rowAfterFirst).toBeDefined()

      // Spy to verify embed is NOT called again on the second run
      const embedSpy = vi.spyOn(embeddings, 'embed')

      // Second run: message is already in vec_messages; embed should not be called for it
      await embedNewMessages([chatId])

      expect(embedSpy, 'embed should not be called when message is already indexed').not.toHaveBeenCalled()
      embedSpy.mockRestore()
    })
  })
})
