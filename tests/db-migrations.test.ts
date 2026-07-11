import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations, columnExists } from '../src/db-migrations'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

function createLegacySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id             INTEGER PRIMARY KEY,
      name           TEXT    NOT NULL,
      type           TEXT    NOT NULL,
      username       TEXT,
      platform       TEXT    NOT NULL DEFAULT 'telegram',
      last_synced_at INTEGER,
      message_count  INTEGER DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS sync_state (
      platform       TEXT    NOT NULL PRIMARY KEY,
      last_synced_at INTEGER NOT NULL
    );
  `)
}

function createCurrentSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id             INTEGER PRIMARY KEY,
      name           TEXT    NOT NULL,
      type           TEXT    NOT NULL,
      username       TEXT,
      platform       TEXT    NOT NULL DEFAULT 'telegram',
      last_synced_at INTEGER,
      message_count  INTEGER DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS sync_state (
      platform       TEXT    NOT NULL PRIMARY KEY,
      last_synced_at INTEGER NOT NULL
    );
  `)
}

// ── columnExists ──────────────────────────────────────────────────────────────

describe('columnExists', () => {
  it('returns true when column exists', () => {
    const db = makeDb()
    createCurrentSchema(db)
    expect(columnExists(db, 'chats', 'platform')).toBe(true)
  })

  it('returns false when column does not exist', () => {
    const db = makeDb()
    createCurrentSchema(db)
    expect(columnExists(db, 'chats', 'account')).toBe(false)
  })

  it('returns false for a non-existent table', () => {
    const db = makeDb()
    expect(columnExists(db, 'nonexistent', 'col')).toBe(false)
  })
})

// ── Column renames (legacy migration) ─────────────────────────────────────────

describe('runMigrations — legacy column renames', () => {
  it('renames telegram_id to external_id in messages', () => {
    const db = makeDb()
    createLegacySchema(db)
    runMigrations(db)
    const cols = (db.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('external_id')
    expect(cols).not.toContain('telegram_id')
  })

  it('renames reply_to_telegram_id to reply_to_external_id in messages', () => {
    const db = makeDb()
    createLegacySchema(db)
    runMigrations(db)
    const cols = (db.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('reply_to_external_id')
    expect(cols).not.toContain('reply_to_telegram_id')
  })
})

// ── chats.account and chats.external_id ──────────────────────────────────────

describe('runMigrations — account and external_id on chats', () => {
  it('adds account column to chats', () => {
    const db = makeDb()
    createCurrentSchema(db)
    runMigrations(db)
    const cols = (db.pragma('table_info(chats)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('account')
  })

  it('adds external_id column to chats', () => {
    const db = makeDb()
    createCurrentSchema(db)
    runMigrations(db)
    const cols = (db.pragma('table_info(chats)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('external_id')
  })

  it('backfills account to "default" for existing rows', () => {
    const db = makeDb()
    createCurrentSchema(db)
    db.exec(`INSERT INTO chats (id, name, type, username, platform) VALUES (1, 'Test', 'user', null, 'telegram')`)
    db.exec(`INSERT INTO chats (id, name, type, username, platform) VALUES (2, 'Group', 'group', null, 'telegram')`)
    runMigrations(db)
    const rows = db.prepare('SELECT id, account FROM chats ORDER BY id').all() as { id: number; account: string }[]
    expect(rows).toHaveLength(2)
    expect(rows[0].account).toBe('default')
    expect(rows[1].account).toBe('default')
  })

  it('backfills external_id to CAST(id AS TEXT) for existing rows', () => {
    const db = makeDb()
    createCurrentSchema(db)
    db.exec(`INSERT INTO chats (id, name, type, username, platform) VALUES (42, 'Test', 'user', null, 'telegram')`)
    runMigrations(db)
    const row = db.prepare('SELECT id, external_id FROM chats WHERE id = 42').get() as { id: number; external_id: string }
    expect(row.external_id).toBe('42')
  })

  it('preserves existing chats.id values after migration', () => {
    const db = makeDb()
    createCurrentSchema(db)
    db.exec(`INSERT INTO chats (id, name, type, username, platform) VALUES (7, 'Keep Me', 'user', null, 'imessage')`)
    runMigrations(db)
    const row = db.prepare('SELECT id FROM chats WHERE id = 7').get() as { id: number } | undefined
    expect(row?.id).toBe(7)
  })

  it('does not discard any chat rows during migration', () => {
    const db = makeDb()
    createCurrentSchema(db)
    for (let i = 1; i <= 5; i++) {
      db.exec(`INSERT INTO chats (id, name, type, username, platform) VALUES (${i}, 'Chat ${i}', 'user', null, 'telegram')`)
    }
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM chats').get() as { c: number }).c
    runMigrations(db)
    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM chats').get() as { c: number }).c
    expect(countAfter).toBe(countBefore)
  })

  it('creates unique index ux_chats_identity on (platform, account, external_id)', () => {
    const db = makeDb()
    createCurrentSchema(db)
    runMigrations(db)
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").pluck().all()) as string[]
    expect(indexes).toContain('ux_chats_identity')
  })

  it('unique index prevents duplicate (platform, account, external_id)', () => {
    const db = makeDb()
    createCurrentSchema(db)
    runMigrations(db)
    db.exec(`INSERT INTO chats (id, name, type, username, platform, account, external_id) VALUES (100, 'A', 'user', null, 'telegram', 'default', 'ext1')`)
    expect(() => {
      db.exec(`INSERT INTO chats (id, name, type, username, platform, account, external_id) VALUES (101, 'B', 'user', null, 'telegram', 'default', 'ext1')`)
    }).toThrow()
  })

  it('allows same external_id under different accounts (no collision)', () => {
    const db = makeDb()
    createCurrentSchema(db)
    runMigrations(db)
    db.exec(`INSERT INTO chats (id, name, type, username, platform, account, external_id) VALUES (200, 'A', 'user', null, 'telegram', 'default', 'ext1')`)
    expect(() => {
      db.exec(`INSERT INTO chats (id, name, type, username, platform, account, external_id) VALUES (201, 'B', 'user', null, 'telegram', 'work', 'ext1')`)
    }).not.toThrow()
  })

  it('is idempotent — running twice does not throw', () => {
    const db = makeDb()
    createCurrentSchema(db)
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
  })
})

// ── sync_state rebuild to (platform, account) PK ─────────────────────────────

describe('runMigrations — sync_state rebuild', () => {
  it('adds account column to sync_state', () => {
    const db = makeDb()
    createCurrentSchema(db)
    runMigrations(db)
    const cols = (db.pragma('table_info(sync_state)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('account')
  })

  it('preserves existing sync_state rows with account set to "default"', () => {
    const db = makeDb()
    createCurrentSchema(db)
    db.exec(`INSERT INTO sync_state (platform, last_synced_at) VALUES ('telegram', 1234567890)`)
    db.exec(`INSERT INTO sync_state (platform, last_synced_at) VALUES ('slack', 9876543210)`)
    runMigrations(db)
    const rows = db.prepare('SELECT platform, account, last_synced_at FROM sync_state ORDER BY platform').all() as { platform: string; account: string; last_synced_at: number }[]
    expect(rows).toHaveLength(2)
    const tg = rows.find(r => r.platform === 'telegram')
    expect(tg?.account).toBe('default')
    expect(tg?.last_synced_at).toBe(1234567890)
    const sl = rows.find(r => r.platform === 'slack')
    expect(sl?.account).toBe('default')
    expect(sl?.last_synced_at).toBe(9876543210)
  })

  it('sync_state rebuild is idempotent — running twice does not throw', () => {
    const db = makeDb()
    createCurrentSchema(db)
    db.exec(`INSERT INTO sync_state (platform, last_synced_at) VALUES ('telegram', 1000)`)
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('allows per-account entries after rebuild', () => {
    const db = makeDb()
    createCurrentSchema(db)
    runMigrations(db)
    db.exec(`INSERT INTO sync_state (platform, account, last_synced_at) VALUES ('telegram', 'default', 1000)`)
    db.exec(`INSERT INTO sync_state (platform, account, last_synced_at) VALUES ('telegram', 'work', 2000)`)
    const rows = db.prepare("SELECT * FROM sync_state WHERE platform='telegram' ORDER BY account").all() as { platform: string; account: string; last_synced_at: number }[]
    expect(rows).toHaveLength(2)
  })
})
