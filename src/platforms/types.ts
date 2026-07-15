import type Database from 'better-sqlite3-multiple-ciphers'
import type { AccountCredentials } from '../account-registry'

export type Platform = 'telegram' | 'imessage' | 'discord' | 'slack' | 'whatsapp' | 'email' | 'signal'

export interface PlatformAdapter {
  readonly platform: Platform
  readonly account: string
  runBackfill(db: Database.Database): Promise<void>
  startListener(db: Database.Database): void
  /** Optional. If present, called instead of runBackfill when since is available and --backfill is not set. */
  syncIncremental?(db: Database.Database, since: Date): Promise<void>
}

export type AdapterFactory = (account: string, credentials: AccountCredentials) => PlatformAdapter
