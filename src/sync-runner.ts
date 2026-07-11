import type Database from 'better-sqlite3-multiple-ciphers'
import type { PlatformAdapter, AdapterFactory, Platform } from './platforms/types'
import type { AccountRegistry } from './account-registry'
import { loadRegistry } from './account-registry'
import { getPlatformLastSyncedAt, setPlatformLastSyncedAt, rebuildFtsIndex } from './db'
import { rebuildEmbeddings } from './index-embeddings'

export interface SyncRunOptions {
  force: boolean
}

export interface AccountSyncOutcome {
  account: string
  ok: boolean
  error?: string
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
    const since = getPlatformLastSyncedAt(adapter.platform, adapter.account)
    if (since !== null && typeof adapter.syncIncremental === 'function') {
      mode = 'incremental'
    } else {
      mode = 'backfill'
    }
  }

  process.stdout.write(mode + '\n')

  if (mode === 'incremental') {
    const since = getPlatformLastSyncedAt(adapter.platform, adapter.account)!
    await adapter.syncIncremental!(db, new Date(since * 1000))
  } else {
    await adapter.runBackfill(db)
  }

  setPlatformLastSyncedAt(adapter.platform, adapter.account, runStartedAt)

  if (force) {
    rebuildFtsIndex()
    await rebuildEmbeddings(adapter.platform)
  }
}

export async function runAllAccountsSync(
  platform: Platform,
  factory: AdapterFactory,
  db: Database.Database,
  argv: readonly string[],
  registry: AccountRegistry = loadRegistry(),
): Promise<AccountSyncOutcome[]> {
  const accounts = registry.listAccounts(platform)
  const outcomes: AccountSyncOutcome[] = []

  for (const account of accounts) {
    const credentials = registry.credentialsFor(platform, account)
    const adapter = factory(account, credentials)
    try {
      await runPlatformSync(adapter, db, argv)
      outcomes.push({ account, ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      outcomes.push({ account, ok: false, error })
    }
  }

  return outcomes
}
