import Database from 'better-sqlite3'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChatType = 'user' | 'group' | 'channel'
export type MessageType = 'text' | 'voice' | 'video' | 'image' | 'sticker' | 'reaction' | 'notice'

export interface Chat {
  id: number
  name: string
  type: ChatType
  username: string | null
  last_synced_at?: number | null
  message_count?: number
}

export interface Message {
  telegram_id: string
  chat_id: number
  sender_id: string | null
  sender_name: string | null
  text: string | null
  type: MessageType
  timestamp: number
  is_sender: 0 | 1
  reply_to_telegram_id: string | null
}

export interface MessageRow extends Message {
  id: number
}

export interface SearchResult {
  chat_id: number
  chat_name: string
  sender_name: string | null
  text: string | null
  timestamp: number
}

// ── Module-level DB instance ──────────────────────────────────────────────────

let _db: Database.Database | null = null

function db(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call initDb(path) first')
  return _db
}

export function initDb(path: string): Database.Database {
  _db = new Database(path)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  createSchema(_db)
  // Rebuild FTS index in case messages were inserted before the FTS table existed
  _db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
  return _db
}

// ── Schema ────────────────────────────────────────────────────────────────────

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id               INTEGER PRIMARY KEY,
      name             TEXT    NOT NULL,
      type             TEXT    NOT NULL,
      username         TEXT,
      last_synced_at   INTEGER,
      message_count    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id          TEXT    NOT NULL,
      chat_id              INTEGER NOT NULL,
      sender_id            TEXT,
      sender_name          TEXT,
      text                 TEXT,
      type                 TEXT    NOT NULL,
      timestamp            INTEGER NOT NULL,
      is_sender            INTEGER NOT NULL,
      reply_to_telegram_id TEXT,
      UNIQUE(telegram_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp
      ON messages(chat_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_messages_chat_type
      ON messages(chat_id, type);

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

// ── Exported functions ────────────────────────────────────────────────────────

export function upsertChat(chat: Chat): void {
  db().prepare(`
    INSERT INTO chats (id, name, type, username, last_synced_at, message_count)
    VALUES (@id, @name, @type, @username, @last_synced_at, @message_count)
    ON CONFLICT(id) DO UPDATE SET
      name           = excluded.name,
      type           = excluded.type,
      username       = excluded.username,
      last_synced_at = COALESCE(excluded.last_synced_at, last_synced_at),
      message_count  = COALESCE(excluded.message_count, message_count)
  `).run({
    id: chat.id,
    name: chat.name,
    type: chat.type,
    username: chat.username ?? null,
    last_synced_at: chat.last_synced_at ?? null,
    message_count: chat.message_count ?? 0,
  })
}

export function insertMessage(msg: Message): void {
  db().prepare(`
    INSERT OR IGNORE INTO messages
      (telegram_id, chat_id, sender_id, sender_name, text, type, timestamp, is_sender, reply_to_telegram_id)
    VALUES
      (@telegram_id, @chat_id, @sender_id, @sender_name, @text, @type, @timestamp, @is_sender, @reply_to_telegram_id)
  `).run(msg)
}

export function getChats(): Chat[] {
  return db().prepare('SELECT * FROM chats').all() as Chat[]
}

export function getMessages(
  chatId: number,
  limit: number,
  beforeTimestamp?: number,
): MessageRow[] {
  if (beforeTimestamp !== undefined) {
    return db().prepare(`
      SELECT * FROM messages
      WHERE chat_id = ? AND timestamp < ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(chatId, beforeTimestamp, limit) as MessageRow[]
  }
  return db().prepare(`
    SELECT * FROM messages
    WHERE chat_id = ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(chatId, limit) as MessageRow[]
}

export function searchMessages(query: string, chatId?: number): SearchResult[] {
  if (chatId !== undefined) {
    return db().prepare(`
      SELECT m.chat_id, c.name AS chat_name, m.sender_name, m.text, m.timestamp
      FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      JOIN chats c ON c.id = m.chat_id
      WHERE messages_fts MATCH ? AND m.chat_id = ?
      ORDER BY m.timestamp ASC
      LIMIT 100
    `).all(query, chatId) as SearchResult[]
  }
  return db().prepare(`
    SELECT m.chat_id, c.name AS chat_name, m.sender_name, m.text, m.timestamp
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN chats c ON c.id = m.chat_id
    WHERE messages_fts MATCH ?
    ORDER BY m.timestamp ASC
    LIMIT 100
  `).all(query) as SearchResult[]
}

export function setLastSyncedAt(chatId: number, timestamp: number): void {
  db().prepare(`UPDATE chats SET last_synced_at = ? WHERE id = ?`).run(timestamp, chatId)
}

export function rebuildFtsIndex(): void {
  db().exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
}

export function getDb(): Database.Database {
  return db()
}

export function getLastSyncedId(chatId: number): string | null {
  const row = db().prepare(`
    SELECT telegram_id FROM messages
    WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(chatId) as { telegram_id: string } | undefined
  return row?.telegram_id ?? null
}
