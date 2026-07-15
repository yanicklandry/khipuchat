import 'dotenv/config'
import type Database from 'better-sqlite3-multiple-ciphers'
import { initDb, getPlatformLastSyncedAt } from './db'
import { rebuildEmbeddings } from './index-embeddings'
import type { AdapterFactory, Platform, PlatformAdapter } from './platforms/types'
import { loadRegistry } from './account-registry'
import { PLATFORMS } from './sync-all'
import { createDiscordAdapter } from './platforms/discord/sync'
import { createEmailAdapter } from './platforms/email/sync'
import { createIMessageAdapter } from './platforms/imessage/sync'
import { createTelegramAdapter } from './platforms/telegram/sync'
import { createSlackAdapter } from './platforms/slack/sync'
import { createWhatsAppAdapter } from './platforms/whatsapp/sync'
import { createSignalAdapter } from './platforms/signal/sync'

// ---- Constants ----

export const DEFAULT_INTERVAL_MS = 300_000 // 5 minutes

// ---- DB init ----

const db: Database.Database = initDb('./khipuchat.db')

// ---- Helpers ----

/** Returns the polling interval in ms for the given platform. */
export function getIntervalMs(platform: Platform): number {
  const envKey = `WATCH_INTERVAL_${platform.toUpperCase()}_MS`
  const raw = process.env[envKey]
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_INTERVAL_MS
}

const LOCAL_ONLY_PLATFORMS: ReadonlySet<Platform> = new Set(['imessage', 'whatsapp'])

const REQUIRED_ENV_VARS: Partial<Record<Platform, readonly string[]>> = {
  telegram: ['TG_API_ID', 'TG_API_HASH', 'TG_PHONE'],
  discord: ['DISCORD_TOKEN'],
  slack: ['SLACK_USER_TOKEN'],
  email: ['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS'],
  signal: ['BEEPER_ACCESS_TOKEN'],
}

/** Returns true if the platform appears to be configured (credentials present). */
export function isConfigured(platform: Platform): boolean {
  if (LOCAL_ONLY_PLATFORMS.has(platform)) return true
  const vars = REQUIRED_ENV_VARS[platform]
  if (vars === undefined) return false
  return vars.some(v => (process.env[v] ?? '').length > 0)
}

/** Executes one poll cycle for the given adapter; catches and logs all errors. */
export async function pollCycle(
  adapter: PlatformAdapter,
  database: Database.Database
): Promise<void> {
  inFlight++
  try {
    const countBefore = database.prepare('SELECT COUNT(*) FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.platform = ? AND c.account = ?').pluck().get(adapter.platform, adapter.account) as number
    const since = getPlatformLastSyncedAt(adapter.platform, adapter.account)
    if (adapter.syncIncremental !== undefined && since !== null) {
      await adapter.syncIncremental(database, new Date(since * 1000))
    } else {
      await adapter.runBackfill(database)
    }
    const countAfter = database.prepare('SELECT COUNT(*) FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.platform = ? AND c.account = ?').pluck().get(adapter.platform, adapter.account) as number
    const newMessages = countAfter - countBefore
    if (newMessages > 0) {
      try {
        await rebuildEmbeddings(adapter.platform)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[${adapter.platform}/${adapter.account}] index error: ${msg}`)
      }
    }
    if (newMessages > 0) {
      console.log(`[${adapter.platform}/${adapter.account}] synced ${newMessages} new messages`)
    } else {
      console.log(`[${adapter.platform}/${adapter.account}] up to date`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[${adapter.platform}/${adapter.account}] error: ${msg}`)
  } finally {
    inFlight--
  }
}

// ---- Watcher state ----

let inFlight = 0
let shutdownRequested = false
const timers: NodeJS.Timeout[] = []

// ---- Shutdown handler ----

async function shutdown(): Promise<void> {
  if (shutdownRequested) return
  shutdownRequested = true
  console.log('Watch daemon shutting down...')
  for (const timer of timers) clearInterval(timer)

  const DRAIN_TIMEOUT_MS = 30_000
  const deadline = Date.now() + DRAIN_TIMEOUT_MS
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 100))
  }

  console.log('Watch daemon stopped.')
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })

// ---- Startup ----

const ADAPTER_FACTORIES: Record<Platform, AdapterFactory> = {
  telegram: createTelegramAdapter,
  discord: createDiscordAdapter,
  slack: createSlackAdapter,
  email: createEmailAdapter,
  imessage: createIMessageAdapter,
  whatsapp: createWhatsAppAdapter,
  signal: createSignalAdapter,
}

async function main(): Promise<void> {
  const registry = loadRegistry()
  const adapters: PlatformAdapter[] = []

  for (const platform of PLATFORMS) {
    if (!isConfigured(platform)) {
      console.log(`[${platform}] skipped: not configured (missing credentials)`)
      continue
    }
    const accounts = registry.listAccounts(platform)
    if (accounts.length === 0) {
      console.log(`[${platform}] skipped: not configured (missing credentials)`)
      continue
    }
    const factory = ADAPTER_FACTORIES[platform]
    for (const account of accounts) {
      const credentials = registry.credentialsFor(platform, account)
      const adapter = factory(account, credentials)
      adapters.push(adapter)
    }
  }

  const onceMode = process.argv.includes('--once')

  if (onceMode) {
    await Promise.all(adapters.map(async (adapter) => {
      try {
        await pollCycle(adapter, db)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[${adapter.platform}] once-pass error: ${msg}`)
      }
    }))
    console.log('Watch daemon: single-pass complete.')
    process.exit(0)
  }

  for (const adapter of adapters) {
    const intervalMs = getIntervalMs(adapter.platform)
    console.log(`[${adapter.platform}/${adapter.account}] polling every ${intervalMs}ms`)

    void pollCycle(adapter, db)
    const timer = setInterval(() => { void pollCycle(adapter, db) }, intervalMs)
    timers.push(timer)
  }

  if (adapters.length === 0) {
    console.log('Watch daemon started with no active adapters.')
  }
}

void main()
