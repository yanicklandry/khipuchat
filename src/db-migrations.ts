import Database from 'better-sqlite3-multiple-ciphers'

export function columnExists(db: Database.Database, table: string, col: string): boolean {
  try {
    return (db.pragma(`table_info(${table})`) as { name: string }[]).some(r => r.name === col)
  } catch {
    return false
  }
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
  ).get(indexName)
  return row !== undefined
}

function syncStateHasAccountPk(db: Database.Database): boolean {
  return columnExists(db, 'sync_state', 'account')
}

export function runMigrations(database: Database.Database): void {
  // Legacy column renames
  if (columnExists(database, 'messages', 'telegram_id'))
    database.exec('ALTER TABLE messages RENAME COLUMN telegram_id TO external_id')
  if (columnExists(database, 'messages', 'reply_to_telegram_id'))
    database.exec('ALTER TABLE messages RENAME COLUMN reply_to_telegram_id TO reply_to_external_id')
  if (!columnExists(database, 'chats', 'platform'))
    database.exec("ALTER TABLE chats ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'")
  if (!columnExists(database, 'messages', 'platform'))
    database.exec("ALTER TABLE messages ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'")

  // Add account dimension to chats
  if (!columnExists(database, 'chats', 'account'))
    database.exec("ALTER TABLE chats ADD COLUMN account TEXT NOT NULL DEFAULT 'default'")
  if (!columnExists(database, 'chats', 'external_id'))
    database.exec('ALTER TABLE chats ADD COLUMN external_id TEXT')

  // Backfill external_id and account for existing rows
  database.exec("UPDATE chats SET external_id = CAST(id AS TEXT) WHERE external_id IS NULL")
  database.exec("UPDATE chats SET account = 'default' WHERE account IS NULL")

  // Create unique identity index
  if (!indexExists(database, 'ux_chats_identity'))
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_chats_identity ON chats(platform, account, external_id)')

  // Add media columns to messages (wechat-image-sync)
  if (!columnExists(database, 'messages', 'media_file_path'))
    database.exec('ALTER TABLE messages ADD COLUMN media_file_path TEXT')
  if (!columnExists(database, 'messages', 'media_url'))
    database.exec('ALTER TABLE messages ADD COLUMN media_url TEXT')
  if (!columnExists(database, 'messages', 'media_width'))
    database.exec('ALTER TABLE messages ADD COLUMN media_width INTEGER')
  if (!columnExists(database, 'messages', 'media_height'))
    database.exec('ALTER TABLE messages ADD COLUMN media_height INTEGER')

  // Rebuild sync_state to composite PK (platform, account) if not already done
  if (!syncStateHasAccountPk(database)) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE sync_state_new (
          platform       TEXT    NOT NULL,
          account        TEXT    NOT NULL DEFAULT 'default',
          last_synced_at INTEGER NOT NULL,
          PRIMARY KEY (platform, account)
        )
      `)
      database.exec(`
        INSERT INTO sync_state_new (platform, account, last_synced_at)
        SELECT platform, 'default', last_synced_at FROM sync_state
      `)
      database.exec('DROP TABLE sync_state')
      database.exec('ALTER TABLE sync_state_new RENAME TO sync_state')
    })()
  }
}
