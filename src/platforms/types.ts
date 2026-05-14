import type Database from 'better-sqlite3-multiple-ciphers'

export type Platform = 'telegram' | 'imessage' | 'discord' | 'slack' | 'whatsapp' | 'wechat' | 'email'

export interface PlatformAdapter {
  readonly platform: Platform
  runBackfill(db: Database.Database): Promise<void>
  startListener(db: Database.Database): void
  /** Optional. If present, called instead of runBackfill when since is available and --backfill is not set. */
  syncIncremental?(db: Database.Database, since: Date): Promise<void>
}
