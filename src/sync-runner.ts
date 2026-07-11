import type Database from 'better-sqlite3-multiple-ciphers'
import type { PlatformAdapter } from './platforms/types'
import { getPlatformLastSyncedAt, setPlatformLastSyncedAt, rebuildFtsIndex } from './db'
import { rebuildEmbeddings } from './index-embeddings'

export interface SyncRunOptions {
  force: boolean
}

export function parseSyncArgs(argv: readonly string[]): SyncRunOptions {
  const hasBackfill = argv.includes('--backfill')
  const hasForce = argv.includes('--force')

  if (hasBackfill) {
    process.stderr.write('Warning: --backfill is deprecated, use --force instead\n')
  }

  return { force: hasForce || hasBackfill }
}

export async function runPlatformSync(
  adapter: PlatformAdapter,
  db: Database.Database,
  argv: readonly string[],
): Promise<void> {
  const runStartedAt = Math.floor(Date.now() / 1000)
  const { force } = parseSyncArgs(argv)

  let mode: 'backfill' | 'incremental'

  if (force) {
    mode = 'backfill'
  } else {
    const since = getPlatformLastSyncedAt(adapter.platform)
    if (since !== null && typeof adapter.syncIncremental === 'function') {
      mode = 'incremental'
    } else {
      mode = 'backfill'
    }
  }

  process.stdout.write(mode + '\n')

  if (mode === 'incremental') {
    const since = getPlatformLastSyncedAt(adapter.platform)!
    await adapter.syncIncremental!(db, new Date(since * 1000))
  } else {
    await adapter.runBackfill(db)
  }

  setPlatformLastSyncedAt(adapter.platform, runStartedAt)

  if (force) {
    rebuildFtsIndex()
    await rebuildEmbeddings(adapter.platform)
  }
}
