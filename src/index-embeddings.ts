import path from 'path'
import { initDb } from './db'
import { embed, embedOne } from './embeddings'
import {
  getUnindexedMessages,
  getUnindexedChats,
  getChatSnippets,
  upsertMessageVector,
  upsertChatVector,
  upsertEmbeddingMeta,
  isIndexed,
} from './vec-db'

const BATCH_SIZE = 100
const LOG_EVERY = 1000

// ── Exported sync-integration helpers ─────────────────────────────────────────

/**
 * Embed any messages not yet in vec_messages for the given chat IDs.
 * Called by platform sync scripts after inserting new messages.
 */
export async function embedNewMessages(chatIds: number[]): Promise<void> {
  if (chatIds.length === 0) return

  const db = (await import('./db')).getDb()
  const rows = db
    .prepare(`
      SELECT m.id, m.text
      FROM messages m
      WHERE m.chat_id IN (${chatIds.map(() => '?').join(',')})
        AND m.text IS NOT NULL AND m.text != ''
        AND m.id NOT IN (SELECT rowid FROM vec_messages)
    `)
    .all(...chatIds) as Array<{ id: number; text: string }>

  for (const row of rows) {
    try {
      const [vec] = await embed([row.text])
      upsertMessageVector(row.id, vec)
    } catch (err) {
      console.error(`[embed] message ${row.id} failed:`, err)
    }
  }
}

/**
 * Embed any chats not yet in vec_chats for the given chat IDs.
 * Called by platform sync scripts after syncing a chat.
 */
export async function embedNewChats(chatIds: number[]): Promise<void> {
  if (chatIds.length === 0) return

  const db = (await import('./db')).getDb()
  const chats = db
    .prepare(`
      SELECT id, name FROM chats
      WHERE id IN (${chatIds.map(() => '?').join(',')})
        AND id NOT IN (SELECT rowid FROM vec_chats)
    `)
    .all(...chatIds) as Array<{ id: number; name: string }>

  for (const chat of chats) {
    try {
      const snippets = getChatSnippets(chat.id)
      const input = [chat.name, ...snippets].join('. ')
      const vec = await embedOne(input)
      upsertChatVector(chat.id, vec)
    } catch (err) {
      console.error(`[embed] chat ${chat.id} failed:`, err)
    }
  }
}

// ── CLI entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbPath = path.join(__dirname, '..', 'telegram.db')
  initDb(dbPath)

  // ── Index messages ────────────────────────────────────────────────────────
  if (!isIndexed('messages')) {
    console.log('Downloading embedding model (~90 MB on first run)...')
  }

  let msgTotal = 0
  let msgBatch: Array<{ id: number; text: string }>

  do {
    msgBatch = getUnindexedMessages(BATCH_SIZE)
    for (const row of msgBatch) {
      try {
        const [vec] = await embed([row.text])
        upsertMessageVector(row.id, vec)
      } catch (err) {
        console.error(`[embed] message ${row.id} failed:`, err)
      }
      msgTotal++
      if (msgTotal % LOG_EVERY === 0) {
        console.log(`Indexed ${msgTotal} messages...`)
      }
    }
  } while (msgBatch.length === BATCH_SIZE)

  upsertEmbeddingMeta('messages', Date.now())

  // ── Index chats ───────────────────────────────────────────────────────────
  const unindexedChats = getUnindexedChats()
  let chatTotal = 0

  for (const chat of unindexedChats) {
    try {
      const snippets = getChatSnippets(chat.id)
      const input = [chat.name, ...snippets].join('. ')
      const vec = await embedOne(input)
      upsertChatVector(chat.id, vec)
    } catch (err) {
      console.error(`[embed] chat ${chat.id} failed:`, err)
    }
    chatTotal++
  }

  upsertEmbeddingMeta('chats', Date.now())

  console.log(`Done. Indexed ${msgTotal} messages, ${chatTotal} chats.`)
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
