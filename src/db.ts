import Database from 'better-sqlite3-multiple-ciphers'
import type { Platform } from './platforms/types'
import { loadVecExtension, createVecSchema } from './vec-db'
import { runMigrations, applyFtsSchema } from './db-migrations'

export type { Platform }
export type ChatType = 'user' | 'group' | 'channel' | 'private'
export type MessageType = 'text' | 'voice' | 'video' | 'image' | 'sticker' | 'reaction' | 'notice' | 'other'

export interface Chat {
  id?: number
  external_id: string
  account: string
  name: string
  type: ChatType
  username: string | null
  platform: Platform
  last_synced_at?: number | null
  message_count?: number
}

export interface Message {
  external_id: string
  chat_id: number
  sender_id: string | null
  sender_name: string | null
  text: string | null
  type: MessageType
  timestamp: number
  is_sender: 0 | 1
  reply_to_external_id: string | null
  platform: Platform
  media_file_path?: string | null
  media_url?: string | null
  media_width?: number | null
  media_height?: number | null
  ocr_text?: string | null
}

export interface MediaUpdate {
  media_file_path?: string | null
  media_width?: number | null
  media_height?: number | null
  ocr_text?: string | null
}

export interface MessageRow extends Message { id: number }

export interface SearchResult {
  chat_id: number
  chat_name: string
  sender_name: string | null
  text: string | null
  type: MessageType
  timestamp: number
  platform: Platform
  account: string
}

export interface DbSearchFilters {
  chatId?: number
  platform?: Platform
  account?: string
  since?: number
  until?: number
  type?: MessageType
  limit?: number
}

export interface MessageResult {
  id: number
  chat_id: number
  sender_name: string | null
  text: string | null
  type: string
  timestamp: number
  is_sender: number
  platform: Platform
  account: string
}

let _db: Database.Database | null = null

function db(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call initDb(path) first')
  return _db
}

export function initDb(path: string): Database.Database {
  _db = new Database(path)
  const dbKey = process.env['DB_KEY']
  if (dbKey && path !== ':memory:') {
    try {
      _db.pragma(`key="${dbKey.replace(/"/g, '')}"`)
    } catch (err) {
      throw new Error('DB_KEY is set but the database could not be opened — key may be incorrect')
    }
  }
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  loadVecExtension(_db)
  createSchema(_db)
  runMigrations(_db)
  createVecSchema(_db)
  _db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
  return _db
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id               INTEGER PRIMARY KEY,
      name             TEXT    NOT NULL,
      type             TEXT    NOT NULL,
      username         TEXT,
      platform         TEXT    NOT NULL DEFAULT 'telegram',
      last_synced_at   INTEGER,
      message_count    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id          TEXT    NOT NULL,
      chat_id              INTEGER NOT NULL,
      sender_id            TEXT,
      sender_name          TEXT,
      text                 TEXT,
      type                 TEXT    NOT NULL,
      timestamp            INTEGER NOT NULL,
      is_sender            INTEGER NOT NULL,
      reply_to_external_id TEXT,
      platform             TEXT    NOT NULL DEFAULT 'telegram',
      media_file_path      TEXT,
      media_url            TEXT,
      media_width          INTEGER,
      media_height         INTEGER,
      ocr_text             TEXT,
      UNIQUE(external_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp
      ON messages(chat_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_messages_chat_type
      ON messages(chat_id, type);

    CREATE TABLE IF NOT EXISTS sync_state (
      platform       TEXT    NOT NULL PRIMARY KEY,
      last_synced_at INTEGER NOT NULL
    );
  `)
  applyFtsSchema(database)
}

export function upsertChat(chat: Chat): number {
  const row = db().prepare(`
    INSERT INTO chats (name, type, username, platform, account, external_id, last_synced_at, message_count)
    VALUES (@name, @type, @username, @platform, @account, @external_id, @last_synced_at, @message_count)
    ON CONFLICT(platform, account, external_id) DO UPDATE SET
      name           = excluded.name,
      type           = excluded.type,
      username       = excluded.username,
      last_synced_at = COALESCE(excluded.last_synced_at, last_synced_at),
      message_count  = COALESCE(excluded.message_count, message_count)
    RETURNING id
  `).get({
    name: chat.name, type: chat.type, username: chat.username ?? null,
    platform: chat.platform, account: chat.account,
    external_id: chat.external_id,
    last_synced_at: chat.last_synced_at ?? null,
    message_count: chat.message_count ?? 0,
  }) as { id: number }
  return row.id
}

export function insertMessage(msg: Message): void {
  db().prepare(`
    INSERT INTO messages
      (external_id, chat_id, sender_id, sender_name, text, type, timestamp,
       is_sender, reply_to_external_id, platform,
       media_file_path, media_url, media_width, media_height, ocr_text)
    VALUES
      (@external_id, @chat_id, @sender_id, @sender_name, @text, @type, @timestamp,
       @is_sender, @reply_to_external_id, @platform,
       @media_file_path, @media_url, @media_width, @media_height, @ocr_text)
    ON CONFLICT(external_id, chat_id) DO UPDATE SET
      is_sender = CASE WHEN excluded.is_sender = 1 THEN 1 ELSE messages.is_sender END
  `).run({
    external_id: msg.external_id,
    chat_id: msg.chat_id,
    sender_id: msg.sender_id,
    sender_name: msg.sender_name,
    text: msg.text,
    type: msg.type,
    timestamp: msg.timestamp,
    is_sender: msg.is_sender,
    reply_to_external_id: msg.reply_to_external_id,
    platform: msg.platform,
    media_file_path: msg.media_file_path ?? null,
    media_url: msg.media_url ?? null,
    media_width: msg.media_width ?? null,
    media_height: msg.media_height ?? null,
    ocr_text: msg.ocr_text ?? null,
  })
}

const ALLOWED_MEDIA_KEYS = new Set(['media_file_path', 'media_width', 'media_height', 'ocr_text'])

export function updateMessageMedia(id: number, fields: MediaUpdate): void {
  const entries = Object.entries(fields).filter(([k]) => ALLOWED_MEDIA_KEYS.has(k))
  if (entries.length === 0) return
  const setClauses = entries.map(([k]) => `${k} = @${k}`).join(', ')
  const params = Object.fromEntries(entries) as Record<string, unknown>
  params['id'] = id
  db().prepare(`UPDATE messages SET ${setClauses} WHERE id = @id`).run(params)
}

export function getMessageIdByExternalId(chatId: number, externalId: string): number | null {
  const row = db().prepare(
    'SELECT id FROM messages WHERE chat_id = ? AND external_id = ?'
  ).get(chatId, externalId) as { id: number } | undefined
  return row?.id ?? null
}

export function getChats(): Chat[] {
  return db().prepare('SELECT * FROM chats').all() as Chat[]
}

export function getMessages(chatId: number, limit: number, beforeTimestamp?: number): MessageRow[] {
  if (beforeTimestamp !== undefined) {
    return db().prepare(`
      SELECT * FROM messages WHERE chat_id = ? AND timestamp < ?
      ORDER BY timestamp ASC LIMIT ?
    `).all(chatId, beforeTimestamp, limit) as MessageRow[]
  }
  return db().prepare(`
    SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT ?
  `).all(chatId, limit) as MessageRow[]
}

export function searchMessages(query: string, filters?: DbSearchFilters): SearchResult[] {
  const { chatId, platform, account, since, until, type, limit = 100 } = filters ?? {}
  const args: unknown[] = [query]
  let extra = ''
  if (chatId !== undefined) { extra += ' AND m.chat_id = ?'; args.push(chatId) }
  if (platform !== undefined) { extra += ' AND m.platform = ?'; args.push(platform) }
  if (account !== undefined) { extra += ' AND c.account = ?'; args.push(account) }
  if (since !== undefined) { extra += ' AND m.timestamp >= ?'; args.push(since) }
  if (until !== undefined) { extra += ' AND m.timestamp <= ?'; args.push(until) }
  if (type !== undefined) { extra += ' AND m.type = ?'; args.push(type) }
  args.push(limit)
  return db().prepare(`
    SELECT m.chat_id, c.name AS chat_name, m.sender_name, m.text, m.type, m.timestamp, m.platform, c.account
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN chats c ON c.id = m.chat_id
    WHERE messages_fts MATCH ?${extra}
    ORDER BY m.timestamp ASC LIMIT ?
  `).all(...args) as SearchResult[]
}

export function listArchiveMessages(filters?: DbSearchFilters): { messages: MessageResult[], has_more: boolean } {
  const { platform, account, since, until, type = 'text', limit = 50 } = filters ?? {}
  const cap = Math.min(limit, 200)
  const fetchCount = cap + 1
  const args: unknown[] = []
  const conditions: string[] = ['m.type = ?']
  args.push(type)
  if (platform !== undefined) { conditions.push('m.platform = ?'); args.push(platform) }
  if (account !== undefined) { conditions.push('c.account = ?'); args.push(account) }
  if (since !== undefined) { conditions.push('m.timestamp >= ?'); args.push(since) }
  if (until !== undefined) { conditions.push('m.timestamp <= ?'); args.push(until) }
  args.push(fetchCount)
  const where = conditions.join(' AND ')
  const rows = db().prepare(`
    SELECT m.id, m.chat_id, m.sender_name, m.text, m.type, m.timestamp, m.is_sender, m.platform, c.account
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    WHERE ${where}
    ORDER BY m.timestamp DESC LIMIT ?
  `).all(...args) as MessageResult[]
  const has_more = rows.length > cap
  const messages = has_more ? rows.slice(0, cap) : rows
  return { messages, has_more }
}

export function setLastSyncedAt(chatId: number, timestamp: number): void {
  db().prepare('UPDATE chats SET last_synced_at = ? WHERE id = ?').run(timestamp, chatId)
}

export function rebuildFtsIndex(): void {
  db().exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
}

export function getDb(): Database.Database { return db() }

export function getLastSyncedId(chatId: number): string | null {
  const row = db().prepare(`
    SELECT external_id FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 1
  `).get(chatId) as { external_id: string } | undefined
  return row?.external_id ?? null
}

export function getPlatformLastSyncedAt(platform: Platform, account: string): number | null {
  const row = db().prepare(
    'SELECT last_synced_at FROM sync_state WHERE platform = ? AND account = ?'
  ).get(platform, account) as { last_synced_at: number } | undefined
  return row?.last_synced_at ?? null
}

export function setPlatformLastSyncedAt(platform: Platform, account: string, ts: number): void {
  db().prepare(
    'INSERT OR REPLACE INTO sync_state (platform, account, last_synced_at) VALUES (?, ?, ?)'
  ).run(platform, account, ts)
}
