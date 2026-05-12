import path from 'path'
import { initDb, getDb } from './db'
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

// ── Progress bar ──────────────────────────────────────────────────────────────

function renderBar(done: number, total: number, startMs: number): string {
  const pct = total > 0 ? done / total : 0
  const width = 28
  const filled = Math.round(pct * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const pctStr = (pct * 100).toFixed(1).padStart(5)
  const counts = `${done.toLocaleString()}/${total.toLocaleString()}`

  let eta = ''
  if (done > 0 && pct < 1) {
    const elapsed = Date.now() - startMs
    const msLeft = (elapsed / pct) - elapsed
    const mins = Math.floor(msLeft / 60000)
    const secs = Math.floor((msLeft % 60000) / 1000)
    eta = mins > 0 ? ` ~${mins}m ${secs}s` : ` ~${secs}s`
  }

  return `\r[${bar}] ${pctStr}% (${counts})${eta}  `
}

function countUnindexed(): number {
  return (getDb()
    .prepare(`SELECT COUNT(*) FROM messages
      WHERE text IS NOT NULL AND text != ''
        AND id NOT IN (SELECT rowid FROM vec_messages)`)
    .pluck()
    .get() as number)
}

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
  const dbPath = path.join(__dirname, '..', 'khipuchat.db')
  initDb(dbPath)

  // ── Index messages ────────────────────────────────────────────────────────
  const msgCount = countUnindexed()
  if (msgCount === 0) {
    console.log('Messages: already up-to-date.')
  } else {
    console.log(`Messages to index: ${msgCount.toLocaleString()}`)
    if (!isIndexed('messages')) {
      console.log('Downloading embedding model (~90 MB on first run)...')
    }
  }

  let msgTotal = 0
  let msgBatch: Array<{ id: number; text: string }>
  const msgStart = Date.now()

  do {
    msgBatch = getUnindexedMessages(BATCH_SIZE)
    for (const row of msgBatch) {
      try {
        const [vec] = await embed([row.text])
        upsertMessageVector(row.id, vec)
      } catch (err) {
        process.stderr.write(`\n[embed] message ${row.id} failed: ${err}\n`)
      }
      msgTotal++
      if (msgCount > 0) {
        process.stdout.write(renderBar(msgTotal, msgCount, msgStart))
      }
    }
  } while (msgBatch.length === BATCH_SIZE)

  if (msgCount > 0) process.stdout.write('\n')
  upsertEmbeddingMeta('messages', Date.now())

  // ── Index chats ───────────────────────────────────────────────────────────
  const unindexedChats = getUnindexedChats()
  const chatCount = unindexedChats.length
  let chatTotal = 0
  const chatStart = Date.now()

  if (chatCount === 0) {
    console.log('Chats: already up-to-date.')
  } else {
    console.log(`Chats to index: ${chatCount.toLocaleString()}`)
  }

  for (const chat of unindexedChats) {
    try {
      const snippets = getChatSnippets(chat.id)
      const input = [chat.name, ...snippets].join('. ')
      const vec = await embedOne(input)
      upsertChatVector(chat.id, vec)
    } catch (err) {
      process.stderr.write(`\n[embed] chat ${chat.id} failed: ${err}\n`)
    }
    chatTotal++
    process.stdout.write(renderBar(chatTotal, chatCount, chatStart))
  }

  if (chatCount > 0) process.stdout.write('\n')
  upsertEmbeddingMeta('chats', Date.now())

  console.log(`Done. Indexed ${msgTotal.toLocaleString()} messages, ${chatTotal.toLocaleString()} chats.`)
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
