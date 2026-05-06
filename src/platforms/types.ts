import type Database from 'better-sqlite3'

export type Platform = 'telegram' | 'imessage' | 'discord' | 'slack' | 'whatsapp'

export interface PlatformAdapter {
  readonly platform: Platform
  runBackfill(db: Database.Database): Promise<void>
  startListener(db: Database.Database): void
}
