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
    await rebuildEmbeddings(adapter.platform, force)
  }
}

/**
 * Extract the value following `--account` in argv, or null when the flag is
 * absent. Ignores unrelated flags (e.g. `--force`, `--backfill`).
 */
export function parseAccountArg(argv: readonly string[]): string | null {
  const idx = argv.indexOf('--account')
  if (idx === -1) return null
  return argv[idx + 1] ?? null
}

/**
 * Shared entrypoint used by every env-based platform `main()`. When `--account
 * <name>` is present, resolves that account's credentials and syncs exactly it;
 * otherwise delegates to `runAllAccountsSync` (which yields all configured
 * accounts, or the single legacy `default` when no config file exists).
 *
 * A named-but-missing account is never routed to `default`: `credentialsFor`
 * throws and the error propagates to the caller's `main()` catch.
 */
export async function runSyncEntrypoint(
  platform: Platform,
  factory: AdapterFactory,
  db: Database.Database,
  argv: readonly string[],
  registry: AccountRegistry = loadRegistry(),
): Promise<AccountSyncOutcome[]> {
  const account = parseAccountArg(argv)
  if (account !== null) {
    const credentials = registry.credentialsFor(platform, account)
    const adapter = factory(account, credentials)
    await runPlatformSync(adapter, db, argv)
    return [{ account, ok: true }]
  }

  // No config file and legacy env unset => zero accounts. Preserve the legacy
  // single-account behavior: build the `default` adapter and run it directly so
  // its own missing-credential message + process.exit(1) fire (Req 3.3). When
  // accounts exist, delegate to the per-account fan-out unchanged.
  if (registry.listAccounts(platform).length === 0) {
    const adapter = factory('default', { name: 'default', fields: {} })
    await runPlatformSync(adapter, db, argv)
    return [{ account: 'default', ok: true }]
  }

  const outcomes = await runAllAccountsSync(platform, factory, db, argv, registry)

  // runAllAccountsSync itself never throws (each account's failure is isolated
  // so sibling accounts still get a chance to sync), but a caller's top-level
  // main().catch(...) needs a non-zero exit when any account failed — silently
  // resolving here previously made `khipu sync <platform>` exit 0 on failure.
  const failures = outcomes.filter((o) => !o.ok)
  if (failures.length > 0) {
    const detail = failures.map((f) => `${f.account}: ${f.error}`).join('; ')
    throw new Error(`${failures.length} of ${outcomes.length} account(s) failed to sync: ${detail}`)
  }

  return outcomes
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
