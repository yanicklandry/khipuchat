import * as path from 'path'
import { initDb, getPlatformLastSyncedAt } from './db'
import type { Platform } from './db'
import { loadRegistry } from './account-registry'
import type { AccountRegistry } from './account-registry'
import { PLATFORMS } from './sync-all'

initDb(path.join(__dirname, '..', 'khipuchat.db'))

function formatTimestamp(ts: number | null): string {
  if (ts === null) return 'never'
  return new Date(ts * 1000).toLocaleString()
}

export function printSyncStatus(
  registry: AccountRegistry,
  getLastSynced: (platform: Platform, account: string) => number | null,
): void {
  for (const platform of PLATFORMS) {
    const accounts = registry.listAccounts(platform as Platform)
    if (accounts.length === 0) continue

    console.log(`\n${platform}:`)
    for (const account of accounts) {
      const ts = getLastSynced(platform as Platform, account)
      console.log(`  ${account}: ${formatTimestamp(ts)}`)
    }
  }
}

if (require.main === module) {
  const registry = loadRegistry()
  printSyncStatus(registry, getPlatformLastSyncedAt)
  process.exit(0)
}
