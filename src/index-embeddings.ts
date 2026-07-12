import path from 'path'
import { initDb, getDb } from './db'
import { embed, embedOne } from './embeddings'
import {
  getChatSnippets,
  upsertMessageVector,
  upsertChatVector,
  upsertEmbeddingMeta,
  isIndexed,
  clearMessageVectors,
  clearChatVectors,
} from './vec-db'
import type { Platform } from './platforms/types'

const BATCH_SIZE = 100

// ── Shared embedding query constants ─────────────────────────────────────────

/** Columns to select when fetching messages for embedding. */
const MSG_COLUMNS = 'm.id, m.text, m.ocr_text'

/**
 * WHERE predicate that matches any message with indexable content:
 * either a non-empty text body, a non-empty OCR transcription, or both.
 */
const HAS_CONTENT = `((m.text IS NOT NULL AND m.text != '') OR (m.ocr_text IS NOT NULL AND m.ocr_text != ''))`

/** Build the embedding input string from a message row. */
function buildEmbedInput(row: { text: string | null; ocr_text: string | null }): string {
  return [row.text, row.ocr_text].filter(Boolean).join(' ')
}

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
    .prepare(`SELECT COUNT(*) FROM messages m
      WHERE ${HAS_CONTENT}
        AND m.id NOT IN (SELECT rowid FROM vec_messages)`)
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
      SELECT ${MSG_COLUMNS}
      FROM messages m
      WHERE m.chat_id IN (${chatIds.map(() => '?').join(',')})
        AND ${HAS_CONTENT}
        AND m.id NOT IN (SELECT rowid FROM vec_messages)
    `)
    .all(...chatIds) as Array<{ id: number; text: string | null; ocr_text: string | null }>

  for (const row of rows) {
    try {
      const [vec] = await embed([buildEmbedInput(row)])
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
      const input = [chat.name, ...snippets].filter(Boolean).join('. ')
      if (!input.trim()) continue
      const vec = await embedOne(input)
      upsertChatVector(chat.id, vec)
    } catch (err) {
      console.error(`[embed] chat ${chat.id} failed:`, err)
    }
  }
}

// ── Platform-scoped helpers ────────────────────────────────────────────────────

function getUnindexedMessagesByPlatform(limit: number, platform: Platform): Array<{ id: number; text: string | null; ocr_text: string | null }> {
  return getDb()
    .prepare(`
      SELECT ${MSG_COLUMNS}
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.platform = ?
        AND ${HAS_CONTENT}
        AND m.id NOT IN (SELECT rowid FROM vec_messages)
      LIMIT ?
    `)
    .all(platform, limit) as Array<{ id: number; text: string | null; ocr_text: string | null }>
}

function getUnindexedChatsByPlatform(platform: Platform): Array<{ id: number; name: string }> {
  return getDb()
    .prepare(`
      SELECT id, name FROM chats
      WHERE platform = ?
        AND id NOT IN (SELECT rowid FROM vec_chats)
    `)
    .all(platform) as Array<{ id: number; name: string }>
}

// ── Core rebuild function ──────────────────────────────────────────────────────

/**
 * Embed all unindexed messages and chats.
 * With no argument: whole-database sweep (preserves `npm run index:embeddings` behaviour).
 * With a platform: restrict the sweep to that platform's chats and messages only.
 * With force=true: clear all in-scope vectors first, making every row "unindexed",
 *   then run the normal incremental sweep so everything is re-embedded from scratch.
 */
export async function rebuildEmbeddings(platform?: Platform, force?: boolean): Promise<void> {
  if (force) {
    clearMessageVectors(platform)
    clearChatVectors(platform)
  }
  // ── Index messages ──────────────────────────────────────────────────────────
  const msgCount = platform
    ? (getDb()
        .prepare(`SELECT COUNT(*) FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE c.platform = ? AND ${HAS_CONTENT}
            AND m.id NOT IN (SELECT rowid FROM vec_messages)`)
        .pluck()
        .get(platform) as number)
    : countUnindexed()

  if (msgCount === 0) {
    console.log('Messages: already up-to-date.')
  } else {
    console.log(`Messages to index: ${msgCount.toLocaleString()}`)
    if (!isIndexed('messages')) {
      console.log('Downloading embedding model (~90 MB on first run)...')
    }
  }

  let msgTotal = 0
  let msgBatch: Array<{ id: number; text: string | null; ocr_text: string | null }>
  const msgStart = Date.now()

  do {
    msgBatch = platform
      ? getUnindexedMessagesByPlatform(BATCH_SIZE, platform)
      : getDb()
          .prepare(`
            SELECT ${MSG_COLUMNS}
            FROM messages m
            WHERE ${HAS_CONTENT}
              AND m.id NOT IN (SELECT rowid FROM vec_messages)
            LIMIT ?
          `)
          .all(BATCH_SIZE) as Array<{ id: number; text: string | null; ocr_text: string | null }>
    for (const row of msgBatch) {
      try {
        const [vec] = await embed([buildEmbedInput(row)])
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

  // ── Index chats ─────────────────────────────────────────────────────────────
  const unindexedChats = platform
    ? getUnindexedChatsByPlatform(platform)
    : getDb()
        .prepare(`SELECT id, name FROM chats WHERE id NOT IN (SELECT rowid FROM vec_chats)`)
        .all() as Array<{ id: number; name: string }>
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
      const input = [chat.name, ...snippets].filter(Boolean).join('. ')
      if (!input.trim()) {
        process.stderr.write(`\n[embed] chat ${chat.id} skipped: no indexable content\n`)
        chatTotal++
        process.stdout.write(renderBar(chatTotal, chatCount, chatStart))
        continue
      }
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

  // Report DB totals (rows present in vec_messages/vec_chats for the scope), not just this run's count
  const dbMsgCount = platform
    ? (getDb()
        .prepare(`
          SELECT COUNT(*) FROM vec_messages
          WHERE rowid IN (
            SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.platform = ?
          )
        `)
        .pluck()
        .get(platform) as number)
    : (getDb().prepare('SELECT COUNT(*) FROM vec_messages').pluck().get() as number)

  const dbChatCount = platform
    ? (getDb()
        .prepare(`
          SELECT COUNT(*) FROM vec_chats
          WHERE rowid IN (SELECT id FROM chats WHERE platform = ?)
        `)
        .pluck()
        .get(platform) as number)
    : (getDb().prepare('SELECT COUNT(*) FROM vec_chats').pluck().get() as number)

  console.log(`Done. Indexed ${dbMsgCount.toLocaleString()} messages, ${dbChatCount.toLocaleString()} chats.`)
}

// ── CLI entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbArgIdx = process.argv.indexOf('--db')
  const dbPath = dbArgIdx !== -1
    ? process.argv[dbArgIdx + 1]
    : path.join(__dirname, '..', 'khipuchat.db')
  if (!dbPath) throw new Error('--db requires a path argument')
  initDb(dbPath)

  await rebuildEmbeddings()
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
