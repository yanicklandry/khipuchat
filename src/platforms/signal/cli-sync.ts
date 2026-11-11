/**
 * The signal-cli PlatformAdapter.
 *
 * SCOPE GUARANTEE (Requirement 7): authoritative capture is LIVE-FROM-LINK-TIME
 * FORWARD only. A freshly linked secondary device receives messages only from
 * link time on; pre-link back-history transfer is unimplemented in signal-cli
 * (AsamK/signal-cli#1708) and encrypted media older than ~45 days is gone
 * server-side. Any history the daemon happens to volunteer is ingested via the
 * same path WITHOUT claiming completeness. No local-backup import is attempted.
 *
 * `startListener` is a NO-OP, exactly like every other adapter. The watch daemon
 * drives live ingestion by calling `syncIncremental` on each pollCycle, so each
 * poll performs a single BOUNDED drain of currently-queued receive
 * notifications and returns. There is no continuous subscribeReceive listener
 * (that would require an out-of-scope daemon-level change to pollCycle).
 */

import type Database from 'better-sqlite3-multiple-ciphers'
import { upsertChat, insertMessage, type Platform } from '../../db'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { PlatformAdapter } from '../types'
import type { AccountCredentials } from '../../account-registry'
import {
  connectSignalCli,
  extractEnvelope,
  type SignalCliClient,
  type SignalCliConnectOptions,
  type SignalEnvelope,
} from './cli-client'
import { resolveChat, mapEnvelope, type GroupNameLookup, type ContactNameLookup } from './cli-mapping'
import { seedChats } from './cli-seed'
import { processCliImageMessages, type CliImageItem } from './cli-image-sync'

const SIGNAL: Platform = 'signal'
const DRAIN_SECONDS = Number(process.env['SIGNAL_CLI_DRAIN_SECONDS'] ?? '2')
const SEED_TTL_MS = Number(process.env['SIGNAL_CLI_SEED_TTL_MS'] ?? String(60 * 60_000))

interface SeedCacheEntry {
  groupName: GroupNameLookup
  contactName: ContactNameLookup
  seededAt: number
}

// Keyed by account: the watch daemon calls drainOnce every poll cycle (every
// few minutes, forever) on the same long-lived process, so re-running the
// full listGroups+listContacts enumeration (and its per-item upserts) on
// every single poll is wasted network/DB work when nothing has changed.
// Cached per account, refreshed at most every SEED_TTL_MS.
const seedCache = new Map<string, SeedCacheEntry>()

async function seedChatsCached(
  client: SignalCliClient,
  account: string,
): ReturnType<typeof seedChats> {
  const cached = seedCache.get(account)
  if (cached && Date.now() - cached.seededAt < SEED_TTL_MS) {
    return { groupName: cached.groupName, contactName: cached.contactName, seeded: 0 }
  }
  const result = await seedChats(client, account)
  seedCache.set(account, { groupName: result.groupName, contactName: result.contactName, seededAt: Date.now() })
  return result
}

/** A device is linked iff the daemon reports at least one registered account. */
async function isLinked(client: SignalCliClient): Promise<boolean> {
  try {
    const accounts = await client.request<unknown>('listAccounts', {})
    if (Array.isArray(accounts)) return accounts.length > 0
    if (accounts && typeof accounts === 'object') {
      const nested = (accounts as { accounts?: unknown }).accounts
      if (Array.isArray(nested)) return nested.length > 0
    }
    return true
  } catch {
    return false
  }
}

/**
 * Bounded drain: collect the receive notifications the daemon delivers within
 * DRAIN_SECONDS, plus any envelopes returned inline by the `receive` request.
 */
async function drainReceive(client: SignalCliClient): Promise<SignalEnvelope[]> {
  const collected: SignalEnvelope[] = []
  client.onReceive((env) => collected.push(env))
  const result = await client.request<unknown>('receive', { timeout: DRAIN_SECONDS }).catch(() => undefined)
  if (Array.isArray(result)) {
    for (const item of result) {
      const env = extractEnvelope(item)
      if (env) collected.push(env)
    }
  }
  return collected
}

interface DrainCounts {
  messages: number
  stored: number
  failed: number
  skipped: number
}

/** Connect, ensure linked, seed, drain, ingest, embed. Releases the socket. */
async function drainOnce(_db: Database.Database, account: string, opts: SignalCliConnectOptions): Promise<void> {
  const conn = await connectSignalCli(opts)
  if (!conn.ok) {
    throw new Error(`[signal] signal-cli daemon unavailable (${conn.reason}): ${conn.message}`)
  }
  const client = conn.client
  try {
    if (!(await isLinked(client))) {
      console.log(
        '[signal] Not linked. Run `SIGNAL_BACKEND=cli khipu sync signal --link` to link this device. Writing nothing.',
      )
      return
    }

    const { groupName, contactName } = await seedChatsCached(client, account)
    const envelopes = await drainReceive(client)

    const affected = new Set<number>()
    const imagesByChat = new Map<number, CliImageItem[]>()
    const counts: DrainCounts = { messages: 0, stored: 0, failed: 0, skipped: 0 }

    for (const env of envelopes) {
      const mappedChat = resolveChat(env, groupName, contactName)
      if (!mappedChat) continue
      const chatId = upsertChat({
        external_id: mappedChat.external_id,
        account,
        name: mappedChat.name,
        type: mappedChat.type,
        username: null,
        platform: SIGNAL,
      })
      const mapped = mapEnvelope(env, chatId)
      if (!mapped) continue
      insertMessage(mapped.message)
      counts.messages++
      affected.add(chatId)
      if (mapped.imageAttachments.length > 0) {
        const list = imagesByChat.get(chatId) ?? []
        for (const attachment of mapped.imageAttachments) {
          list.push({ externalId: mapped.message.external_id, attachment })
        }
        imagesByChat.set(chatId, list)
      }
    }

    for (const [chatId, items] of imagesByChat) {
      const r = await processCliImageMessages(chatId, items)
      counts.stored += r.stored
      counts.failed += r.failed
      counts.skipped += r.skipped
    }

    const chatIds = [...affected]
    if (chatIds.length > 0) {
      if (isIndexed('messages')) await embedNewMessages(chatIds)
      if (isIndexed('chats')) await embedNewChats(chatIds)
    }

    if (counts.messages === 0) {
      console.log('[signal] Nothing new (no queued messages).')
    } else {
      console.log(
        `[signal] Drain complete: ${counts.messages} messages across ${chatIds.length} chats, ` +
          `images: ${counts.stored} stored, ${counts.failed} failed, ${counts.skipped} skipped.`,
      )
    }
  } finally {
    client.close()
  }
}

export function createSignalCliAdapter(account: string, credentials: AccountCredentials): PlatformAdapter {
  const socketPath = credentials.fields['SIGNAL_CLI_SOCKET'] || process.env['SIGNAL_CLI_SOCKET']
  const opts: SignalCliConnectOptions = socketPath ? { socketPath } : {}
  return {
    platform: SIGNAL,
    account,
    async runBackfill(db: Database.Database): Promise<void> {
      await drainOnce(db, account, opts)
    },
    async syncIncremental(db: Database.Database, _since: Date): Promise<void> {
      // Bounded drain per poll; `since` is informational — dedup guards overlap.
      await drainOnce(db, account, opts)
    },
    startListener(_db: Database.Database): void {
      // No-op: the watch daemon achieves live-from-link-forward ingestion by
      // calling syncIncremental on each pollCycle, not via a continuous listener.
    },
  }
}

export const signalCliAdapter: PlatformAdapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
