import Database from 'better-sqlite3-multiple-ciphers'
import type { Platform } from './platforms/types'
import { loadVecExtension, createVecSchema } from './vec-db'

export type { Platform }
export type ChatType = 'user' | 'group' | 'channel' | 'private'
export type MessageType = 'text' | 'voice' | 'video' | 'image' | 'sticker' | 'reaction' | 'notice' | 'other'

export interface Chat {
  id: number
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
}

export interface MessageRow extends Message { id: number }

export interface SearchResult {
  chat_id: number
  chat_name: string
  sender_name: string | null
  text: string | null
  timestamp: number
  platform: Platform
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

function columnExists(d: Database.Database, table: string, col: string): boolean {
  return (d.pragma(`table_info(${table})`) as { name: string }[]).some(r => r.name === col)
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

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(text, content='messages', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS messages_fts_insert
      AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_delete
      AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
      END;
  `)
}

function runMigrations(database: Database.Database): void {
  if (columnExists(database, 'messages', 'telegram_id'))
    database.exec('ALTER TABLE messages RENAME COLUMN telegram_id TO external_id')
  if (columnExists(database, 'messages', 'reply_to_telegram_id'))
    database.exec('ALTER TABLE messages RENAME COLUMN reply_to_telegram_id TO reply_to_external_id')
  if (!columnExists(database, 'chats', 'platform'))
    database.exec("ALTER TABLE chats ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'")
  if (!columnExists(database, 'messages', 'platform'))
    database.exec("ALTER TABLE messages ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'")
}

export function upsertChat(chat: Chat): void {
  db().prepare(`
    INSERT INTO chats (id, name, type, username, platform, last_synced_at, message_count)
    VALUES (@id, @name, @type, @username, @platform, @last_synced_at, @message_count)
    ON CONFLICT(id) DO UPDATE SET
      name           = excluded.name,
      type           = excluded.type,
      username       = excluded.username,
      platform       = excluded.platform,
      last_synced_at = COALESCE(excluded.last_synced_at, last_synced_at),
      message_count  = COALESCE(excluded.message_count, message_count)
  `).run({
    id: chat.id, name: chat.name, type: chat.type, username: chat.username ?? null,
    platform: chat.platform, last_synced_at: chat.last_synced_at ?? null,
    message_count: chat.message_count ?? 0,
  })
}

export function insertMessage(msg: Message): void {
  db().prepare(`
    INSERT INTO messages
      (external_id, chat_id, sender_id, sender_name, text, type, timestamp,
       is_sender, reply_to_external_id, platform)
    VALUES
      (@external_id, @chat_id, @sender_id, @sender_name, @text, @type, @timestamp,
       @is_sender, @reply_to_external_id, @platform)
    ON CONFLICT(external_id, chat_id) DO UPDATE SET
      is_sender = CASE WHEN excluded.is_sender = 1 THEN 1 ELSE messages.is_sender END
  `).run(msg)
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

export function searchMessages(query: string, chatId?: number, platform?: Platform): SearchResult[] {
  const args: unknown[] = [query]
  let extra = ''
  if (chatId !== undefined) { extra += ' AND m.chat_id = ?'; args.push(chatId) }
  if (platform !== undefined) { extra += ' AND m.platform = ?'; args.push(platform) }
  return db().prepare(`
    SELECT m.chat_id, c.name AS chat_name, m.sender_name, m.text, m.timestamp, m.platform
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN chats c ON c.id = m.chat_id
    WHERE messages_fts MATCH ?${extra}
    ORDER BY m.timestamp ASC LIMIT 100
  `).all(...args) as SearchResult[]
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

export function getPlatformLastSyncedAt(platform: Platform): number | null {
  const row = db().prepare(
    'SELECT last_synced_at FROM sync_state WHERE platform = ?'
  ).get(platform) as { last_synced_at: number } | undefined
  return row?.last_synced_at ?? null
}

export function setPlatformLastSyncedAt(platform: Platform, timestamp: number): void {
  db().prepare(
    'INSERT OR REPLACE INTO sync_state (platform, last_synced_at) VALUES (?, ?)'
  ).run(platform, timestamp)
}
