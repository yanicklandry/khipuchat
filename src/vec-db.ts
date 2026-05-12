import * as sqliteVec from 'sqlite-vec'
import type Database from 'better-sqlite3-multiple-ciphers'
import type { Platform } from './platforms/types'
import { getDb } from './db'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SemanticContactResult {
  chat_id: number
  name: string
  platform: Platform
  last_message_date: number | null
  message_count: number
  snippet: string | null
  distance: number
}

export interface SemanticMessageResult {
  chat_id: number
  chat_name: string
  sender_name: string | null
  text: string | null
  timestamp: number
  platform: Platform
  distance: number
}

export interface ContactFilters {
  before?: number      // unix timestamp — restrict to chats whose last message is before this
  after?: number       // unix timestamp — restrict to chats whose last message is after this
  platform?: Platform
  limit?: number       // default 10, max 50
}

export interface MessageFilters {
  chat_id?: number
  platform?: Platform
  before_timestamp?: number
  after_timestamp?: number
  limit?: number       // default 20, max 100
}

const CONTACT_DISTANCE_THRESHOLD = 0.7

// ── Extension + schema ────────────────────────────────────────────────────────

/** Load the sqlite-vec extension into a DB instance. Called by initDb(). */
export function loadVecExtension(db: Database.Database): void {
  sqliteVec.load(db)
}

/** Create vec_chats, vec_messages, and embedding_meta tables if they don't exist.
 *  Accepts the db instance explicitly to avoid circular import issues at init time. */
export function createVecSchema(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chats
      USING vec0(rowid INTEGER PRIMARY KEY, embedding float[384] distance_metric=cosine);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages
      USING vec0(rowid INTEGER PRIMARY KEY, embedding float[384] distance_metric=cosine);

    CREATE TABLE IF NOT EXISTS embedding_meta (
      table_name     TEXT    PRIMARY KEY,
      last_indexed_at INTEGER NOT NULL
    );
  `)
}

// ── Index-state tracking ──────────────────────────────────────────────────────

/** True if the given table has been indexed at least once. */
export function isIndexed(table: 'chats' | 'messages'): boolean {
  const row = getDb()
    .prepare('SELECT last_indexed_at FROM embedding_meta WHERE table_name = ?')
    .get(table)
  return row !== undefined
}

/** Record a successful indexing run. */
export function upsertEmbeddingMeta(table: string, timestamp: number): void {
  getDb()
    .prepare(`
      INSERT INTO embedding_meta(table_name, last_indexed_at) VALUES(?, ?)
      ON CONFLICT(table_name) DO UPDATE SET last_indexed_at = excluded.last_indexed_at
    `)
    .run(table, timestamp)
}

// ── Unindexed record queries ──────────────────────────────────────────────────

/** Return messages not yet present in vec_messages (up to limit rows). */
export function getUnindexedMessages(limit: number): Array<{ id: number; text: string }> {
  return getDb()
    .prepare(`
      SELECT m.id, m.text
      FROM messages m
      WHERE m.text IS NOT NULL AND m.text != ''
        AND m.id NOT IN (SELECT rowid FROM vec_messages)
      LIMIT ?
    `)
    .all(limit) as Array<{ id: number; text: string }>
}

/** Return chats not yet present in vec_chats. */
export function getUnindexedChats(): Array<{ id: number; name: string }> {
  return getDb()
    .prepare(`
      SELECT id, name FROM chats
      WHERE id NOT IN (SELECT rowid FROM vec_chats)
    `)
    .all() as Array<{ id: number; name: string }>
}

/** Return the last N text messages for a chat (for chat-level embedding input). */
export function getChatSnippets(chatId: number, n = 5): string[] {
  return (
    getDb()
      .prepare(`
        SELECT text FROM messages
        WHERE chat_id = ? AND text IS NOT NULL AND text != ''
        ORDER BY timestamp DESC LIMIT ?
      `)
      .all(chatId, n) as Array<{ text: string }>
  ).map(r => r.text)
}

// ── Vector upsert ─────────────────────────────────────────────────────────────

/** Store or replace a message embedding. */
export function upsertMessageVector(id: number, vector: Float32Array): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO vec_messages(rowid, embedding) VALUES(?, ?)')
    .run(BigInt(id), vector)
}

/** Store or replace a chat embedding. */
export function upsertChatVector(id: number, vector: Float32Array): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO vec_chats(rowid, embedding) VALUES(?, ?)')
    .run(BigInt(id), vector)
}

// ── kNN queries ───────────────────────────────────────────────────────────────

/** Find contacts (chats) by semantic similarity to a query vector. */
export function semanticFindContacts(
  queryVector: Float32Array,
  filters: ContactFilters,
): SemanticContactResult[] {
  const limit = Math.min(Math.max(filters.limit ?? 10, 1), 50)

  // Fetch more than limit from vec0 (it doesn't support WHERE on joined cols)
  const knnLimit = Math.min(limit * 10, 200)

  const knnRows = getDb()
    .prepare(`
      SELECT rowid, distance
      FROM vec_chats
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `)
    .all(queryVector, knnLimit) as Array<{ rowid: bigint; distance: number }>

  const results: SemanticContactResult[] = []

  for (const { rowid, distance } of knnRows) {
    if (distance > CONTACT_DISTANCE_THRESHOLD) break
    if (results.length >= limit) break

    const chatId = Number(rowid)
    const chat = getDb()
      .prepare(`
        SELECT c.name, c.platform,
               COUNT(m.id) AS message_count,
               MAX(m.timestamp) AS last_message_date
        FROM chats c
        LEFT JOIN messages m ON m.chat_id = c.id
        WHERE c.id = ?
        GROUP BY c.id
      `)
      .get(chatId) as {
        name: string
        platform: Platform
        message_count: number
        last_message_date: number | null
      } | undefined

    if (!chat) continue

    const last = chat.last_message_date
    if (filters.before !== undefined && last !== null && last >= filters.before) continue
    if (filters.after !== undefined && last !== null && last <= filters.after) continue
    if (filters.platform !== undefined && chat.platform !== filters.platform) continue

    const snippets = getChatSnippets(chatId, 1)

    results.push({
      chat_id: chatId,
      name: chat.name,
      platform: chat.platform,
      last_message_date: last,
      message_count: chat.message_count,
      snippet: snippets[0] ?? null,
      distance,
    })
  }

  return results
}

/** Find messages by semantic similarity to a query vector. */
export function semanticSearchMessages(
  queryVector: Float32Array,
  filters: MessageFilters,
): SemanticMessageResult[] {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100)
  const knnLimit = Math.min(limit * 10, 500)

  const knnRows = getDb()
    .prepare(`
      SELECT rowid, distance
      FROM vec_messages
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `)
    .all(queryVector, knnLimit) as Array<{ rowid: bigint; distance: number }>

  const results: SemanticMessageResult[] = []

  for (const { rowid, distance } of knnRows) {
    if (results.length >= limit) break

    const msgId = Number(rowid)
    const row = getDb()
      .prepare(`
        SELECT m.chat_id, c.name AS chat_name, m.sender_name,
               m.text, m.timestamp, m.platform
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
        WHERE m.id = ?
      `)
      .get(msgId) as {
        chat_id: number
        chat_name: string
        sender_name: string | null
        text: string | null
        timestamp: number
        platform: Platform
      } | undefined

    if (!row) continue

    if (filters.chat_id !== undefined && row.chat_id !== filters.chat_id) continue
    if (filters.platform !== undefined && row.platform !== filters.platform) continue
    if (filters.before_timestamp !== undefined && row.timestamp >= filters.before_timestamp) continue
    if (filters.after_timestamp !== undefined && row.timestamp <= filters.after_timestamp) continue

    results.push({ ...row, distance })
  }

  return results
}
