/**
 * Zalo adapter: pure mapping + a bounded live-capture loop over the ZaloClient port.
 *
 * Fidelity is deliberately bounded (Requirement R4): zca-js is a live/listener
 * client, so this captures live DMs plus the best-effort recent window Zalo
 * replays on connect — NOT a full historical export. Non-goals: sending,
 * groups/OA channels, and image OCR (image/attachment events land as type='other').
 */
import type Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Chat, type Message } from '../../db'
import { runSyncEntrypoint } from '../../sync-runner'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../types'
import type { AccountCredentials } from '../../account-registry'
import {
  createZaloClient,
  ZaloThreadType,
  type ZaloClient,
  type ZaloThread,
  type ZaloMessage,
} from './client'

const DEFAULT_CAPTURE_WINDOW_MS = 20_000

function defaultWindowMs(): number {
  const raw = process.env['ZALO_CAPTURE_WINDOW_MS']
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_CAPTURE_WINDOW_MS
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Pure mapping (no I/O, no client import beyond types) ─────────────────────────

export function mapChat(thread: ZaloThread, account = 'default'): Chat {
  return {
    external_id: thread.threadId,
    account,
    name: thread.name,
    type: 'private',
    username: null,
    platform: 'zalo' as Platform,
  }
}

export function mapMessage(msg: ZaloMessage, chatId: number): Message {
  const isText = typeof msg.content === 'string' && msg.content.length > 0
  return {
    external_id: msg.msgId,
    chat_id: chatId,
    sender_id: msg.isSelf ? null : msg.senderId,
    sender_name: msg.isSelf ? null : msg.senderName,
    text: typeof msg.content === 'string' ? msg.content : null,
    type: isText ? 'text' : 'other',
    timestamp: Math.floor(msg.ts / 1000),
    is_sender: msg.isSelf ? 1 : 0,
    reply_to_external_id: null,
    platform: 'zalo' as Platform,
    media_file_path: null,
    media_url: null,
    media_width: null,
    media_height: null,
    ocr_text: null,
  }
}

// ── Bounded capture loop ─────────────────────────────────────────────────────────

async function captureSession(
  client: ZaloClient,
  account: string,
  windowMs: number,
  sinceSec: number | null,
): Promise<void> {
  const friends = await client.getFriends().catch(() => [] as ZaloThread[])
  const chatIdByThread = new Map<string, number>()
  for (const t of friends) chatIdByThread.set(t.threadId, upsertChat(mapChat(t, account)))

  const touched = new Set<number>()
  let inserted = 0

  client.onMessage((msg) => {
    // Per-event try/catch: a bad event is logged and the session continues (Req 7.4).
    try {
      // DM-only filter runs before mapping: drop group/OA events (Req 3.3).
      if (msg.threadType !== ZaloThreadType.User) return
      // Incremental window: skip anything at/older than the last sync point (Req 4.4).
      if (sinceSec !== null && Math.floor(msg.ts / 1000) <= sinceSec) return
      let chatId = chatIdByThread.get(msg.threadId)
      if (chatId === undefined) {
        chatId = upsertChat(mapChat({ threadId: msg.threadId, name: msg.senderName ?? msg.threadId }, account))
        chatIdByThread.set(msg.threadId, chatId)
      }
      insertMessage(mapMessage(msg, chatId)) // idempotent: replays dedupe on (external_id, chat_id)
      touched.add(chatId)
      inserted++
    } catch (err) {
      console.error(`[zalo] Failed to process message ${msg.msgId}:`, err instanceof Error ? err.message : err)
    }
  })

  client.start()
  await delay(windowMs)
  await client.stop()

  for (const chatId of touched) {
    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
  }

  const mode = sinceSec === null ? 'backfill' : 'incremental'
  console.log(
    `[zalo] Capture complete (${mode}): ${friends.length} DM chats seeded, ${inserted} messages captured. ` +
      'Note: Zalo capture is LIVE + best-effort recent-window replay only, NOT a full historical export.',
  )
}

export async function runBackfillImpl(
  client: ZaloClient,
  account = 'default',
  windowMs: number = defaultWindowMs(),
): Promise<void> {
  await captureSession(client, account, windowMs, null)
}

export async function runIncrementalImpl(
  client: ZaloClient,
  since: Date,
  account = 'default',
  windowMs: number = defaultWindowMs(),
): Promise<void> {
  await captureSession(client, account, windowMs, Math.floor(since.getTime() / 1000))
}

// ── Adapter ──────────────────────────────────────────────────────────────────────

async function runCapture(
  account: string,
  credentials: AccountCredentials,
  since: Date | null,
): Promise<void> {
  const debug = process.argv.includes('--debug')
  const sessionPath = credentials.fields['ZALO_SESSION']
  let client: ZaloClient | null = null
  try {
    client = await createZaloClient({ sessionPath, debug })
    if (since === null) await runBackfillImpl(client, account)
    else await runIncrementalImpl(client, since, account)
  } catch (err) {
    const e = err as Error
    process.stderr.write(
      `[zalo] Error: ${e.message}\n` +
        '[zalo] Note: zca-js is an unofficial Zalo client that may break on Zalo updates and carries account-lock risk.\n',
    )
    process.exit(1)
  } finally {
    await client?.stop().catch(() => {})
  }
}

export function createZaloAdapter(account: string, credentials: AccountCredentials): PlatformAdapter {
  return {
    platform: 'zalo' as Platform,
    account,
    async runBackfill(_db: Database.Database): Promise<void> {
      await runCapture(account, credentials, null)
    },
    async syncIncremental(_db: Database.Database, since: Date): Promise<void> {
      await runCapture(account, credentials, since)
    },
    startListener(_db: Database.Database): void {},
  }
}

export const zaloAdapter: PlatformAdapter = createZaloAdapter('default', {
  name: 'default',
  fields: { ZALO_SESSION: process.env['ZALO_SESSION'] ?? '' },
})

async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  await runSyncEntrypoint('zalo', createZaloAdapter, db, process.argv)
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
