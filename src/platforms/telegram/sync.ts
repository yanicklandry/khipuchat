import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { NewMessage, NewMessageEvent } from 'telegram/events'
import Database from 'better-sqlite3-multiple-ciphers'
import { config, saveSessionString, type Config } from '../../config'
import { initDb, getDb, upsertChat, insertMessage, getLastSyncedId, setLastSyncedAt, setPlatformLastSyncedAt, type Chat, type Message, type MessageType } from '../../db'
import { runPlatformSync } from '../../sync-runner'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { PlatformAdapter } from '../types'
import type { AccountCredentials } from '../../account-registry'
import { processImageMessages, type RawTelegramMessage } from './image-sync'
import { terminateOcr } from '../../ocr'

export type PromptFn = (question: string) => Promise<string>
export interface WizardConfig { sessionString: string }

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

interface EntityLike {
  className: string; id: bigint; firstName?: string; lastName?: string | null
  username?: string | null; title?: string; broadcast?: boolean; bot?: boolean
}

function entityToChat(entity: EntityLike, account: string): Chat | null {
  if (entity.className === 'User') {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ') || 'Unknown'
    return { external_id: String(entity.id), account, name, type: 'user', username: entity.username ?? null, platform: 'telegram' }
  }
  if (entity.className === 'Chat') {
    return { external_id: String(entity.id), account, name: entity.title ?? 'Unknown', type: 'group', username: null, platform: 'telegram' }
  }
  if (entity.className === 'Channel') {
    if (entity.broadcast) return null
    return { external_id: String(entity.id), account, name: entity.title ?? 'Unknown', type: 'group', username: entity.username ?? null, platform: 'telegram' }
  }
  return null
}

interface MsgLike {
  className: string; id: number; message?: string; date: number
  fromId?: { className: string; userId?: bigint }
  peerId?: { className: string; userId?: bigint; chatId?: bigint; channelId?: bigint }
  media?: unknown; replyTo?: { replyToMsgId?: number }; out?: boolean
}

// The gramjs entity argument accepted by client.getMessages(). Our structural
// EntityLike is intentionally narrower, so we bridge to the library's type here.
type TgEntityArg = Parameters<TelegramClient['getMessages']>[0]

function detectType(msg: MsgLike): MessageType {
  if (!msg.media) return 'text'
  const m = msg.media as Record<string, unknown>
  if (m['className'] === 'MessageMediaDocument') {
    const doc = m['document'] as Record<string, unknown> | undefined
    const attrs = (doc?.['attributes'] as Array<Record<string, unknown>>) ?? []
    if (attrs.some(a => a['className'] === 'DocumentAttributeAudio' && a['voice'])) return 'voice'
    if (attrs.some(a => a['className'] === 'DocumentAttributeVideo')) return 'video'
    if (attrs.some(a => a['className'] === 'DocumentAttributeSticker')) return 'sticker'
  }
  if (m['className'] === 'MessageMediaPhoto') return 'image'
  return 'notice'
}

function getPeerChatId(peer: MsgLike['peerId']): number | null {
  if (!peer) return null
  if (peer.className === 'PeerUser' && peer.userId !== undefined) return Number(peer.userId)
  if (peer.className === 'PeerChat' && peer.chatId !== undefined) return Number(peer.chatId)
  if (peer.className === 'PeerChannel' && peer.channelId !== undefined) return Number(peer.channelId)
  return null
}

function msgToRow(msg: MsgLike, chatId: number): Message | null {
  if (msg.className !== 'Message') return null
  return {
    external_id: String(msg.id),
    chat_id: chatId,
    sender_id: msg.fromId?.userId !== undefined ? String(msg.fromId.userId) : null,
    sender_name: null,
    text: msg.message ?? null,
    type: detectType(msg),
    timestamp: msg.date,
    is_sender: msg.out ? 1 : 0,
    reply_to_external_id: msg.replyTo?.replyToMsgId !== undefined
      ? String(msg.replyTo.replyToMsgId) : null,
    platform: 'telegram',
  }
}

export async function runAuthWizard(
  client: TelegramClient,
  promptFn: PromptFn,
  cfg: WizardConfig = config,
  envPath?: string,
): Promise<void> {
  if (cfg.sessionString) { await client.connect(); return }
  await client.start({
    phoneNumber: () => promptFn('Phone number: '),
    phoneCode: () => promptFn('Enter OTP: '),
    password: () => promptFn('2FA password: '),
    onError: (err: Error) => { console.error('Auth error:', err.message) },
  })
  const sessionStr = client.session.save() as unknown as string
  saveSessionString(sessionStr, envPath)
  console.log('Auth saved')
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ])
}

export async function runBackfill(
  client: TelegramClient,
  sleep: (ms: number) => Promise<void> = DEFAULT_SLEEP,
  pageSize = 100,
  firstRunLimit = 200,
  account = 'default',
): Promise<void> {
  const dialogs = await client.getDialogs({ limit: 500 }) as unknown as Array<{ entity: EntityLike; date?: number }>

  // Load per-chat last_synced_at so we can skip dialogs with no new activity
  const syncedAt = new Map<string, number>()
  const rows = getDb().prepare(
    "SELECT external_id, last_synced_at FROM chats WHERE platform = 'telegram' AND last_synced_at IS NOT NULL"
  ).all() as { external_id: string; last_synced_at: number }[]
  for (const row of rows) syncedAt.set(row.external_id, row.last_synced_at)
  const hasPriorSync = syncedAt.size > 0

  console.log(`${dialogs.length} dialogs — ${hasPriorSync ? 'incremental' : 'first'} sync`)
  let totalSynced = 0
  let checked = 0
  let skipped = 0

  for (let i = 0; i < dialogs.length; i++) {
    const chat = entityToChat(dialogs[i].entity, account)
    if (!chat) continue

    const dialogDate = dialogs[i].date ?? 0
    const chatLastSync = syncedAt.get(chat.external_id)
    if (hasPriorSync && chatLastSync !== undefined && dialogDate <= chatLastSync) {
      skipped++
      continue
    }

    checked++
    process.stdout.write(`\r  [${checked} checked, ${skipped} skipped] ${chat.name.slice(0, 35).padEnd(35)}`)
    const chatId = upsertChat(chat)
    const lastId = getLastSyncedId(chatId)
    let synced = 0

    try {
      const imageMsgs: MsgLike[] = []
      if (lastId === null) {
        // First-time sync: fetch only the most recent messages (no full history trawl)
        const msgs = await withTimeout(
          client.getMessages(dialogs[i].entity as unknown as TgEntityArg, { limit: firstRunLimit }) as unknown as Promise<MsgLike[]>,
          15000,
        )
        for (const msg of msgs) {
          const row = msgToRow(msg, chatId)
          if (row) {
            insertMessage(row)
            synced++
            if (row.type === 'image') imageMsgs.push(msg)
          }
        }
      } else {
        // Incremental sync: paginate forward from the last stored message ID
        let offsetId = parseInt(lastId, 10)
        while (true) {
          const msgs = await withTimeout(
            client.getMessages(dialogs[i].entity as unknown as TgEntityArg, { limit: pageSize, offsetId, reverse: true }) as unknown as Promise<MsgLike[]>,
            15000,
          )
          for (const msg of msgs) {
            const row = msgToRow(msg, chatId)
            if (row) {
              insertMessage(row)
              synced++
              if (row.type === 'image') imageMsgs.push(msg)
            }
          }
          if (msgs.length < pageSize) break
          offsetId = msgs[msgs.length - 1].id
        }
      }
      await processImageMessages(client, chatId, imageMsgs as RawTelegramMessage[])
      setLastSyncedAt(chatId, Math.floor(Date.now() / 1000))
      if (isIndexed('messages')) await embedNewMessages([chatId])
      if (isIndexed('chats')) await embedNewChats([chatId])
      if (synced > 0) console.log(`\n  [${chat.name}] +${synced} messages`)
    } catch (err) {
      console.log(`\n  [${chat.name}] skipped: ${(err as Error).message}`)
    }

    totalSynced += synced
    if (checked + skipped < dialogs.length) await sleep(300)
  }
  console.log(`\nBackfill complete. ${totalSynced} new messages stored. (${checked} checked, ${skipped} skipped)`)
}

export function startListener(client: TelegramClient): void {
  client.addEventHandler(async (event: NewMessageEvent) => {
    const msg = event.message as unknown as MsgLike
    const chatId = getPeerChatId(msg.peerId)
    if (chatId === null) return
    const row = msgToRow(msg, chatId)
    if (row) {
      insertMessage(row)
      if (row.type === 'image') {
        await processImageMessages(client, chatId, [msg] as RawTelegramMessage[])
      }
      if (isIndexed('messages')) await embedNewMessages([chatId])
      if (isIndexed('chats')) await embedNewChats([chatId])
      console.log(`New message in chat ${chatId}`)
    }
  }, new NewMessage({}))
}

/** Incremental sync: skip dialogs older than `since`, only fetch new messages. */
export async function syncIncrementalImpl(
  client: TelegramClient,
  since: Date,
  sleep: (ms: number) => Promise<void> = DEFAULT_SLEEP,
  pageSize = 100,
  firstRunLimit = 200,
  account = 'default',
): Promise<void> {
  const sinceTs = Math.floor(since.getTime() / 1000)
  const dialogs = await client.getDialogs({ limit: 500 }) as unknown as Array<{ entity: EntityLike; date?: number }>

  let totalSynced = 0
  let checked = 0
  let skipped = 0

  for (let i = 0; i < dialogs.length; i++) {
    const chat = entityToChat(dialogs[i].entity, account)
    if (!chat) continue

    const dialogDate = dialogs[i].date ?? 0
    if (dialogDate <= sinceTs) {
      skipped++
      continue
    }

    checked++
    const chatId = upsertChat(chat)
    const lastId = getLastSyncedId(chatId)
    let synced = 0

    try {
      const imageMsgs: MsgLike[] = []
      if (lastId === null) {
        const msgs = await withTimeout(
          client.getMessages(dialogs[i].entity as unknown as TgEntityArg, { limit: firstRunLimit }) as unknown as Promise<MsgLike[]>,
          15000,
        )
        for (const msg of msgs) {
          if (msg.date <= sinceTs) continue
          const row = msgToRow(msg, chatId)
          if (row) {
            insertMessage(row)
            synced++
            if (row.type === 'image') imageMsgs.push(msg)
          }
        }
      } else {
        let offsetId = parseInt(lastId, 10)
        while (true) {
          const msgs = await withTimeout(
            client.getMessages(dialogs[i].entity as unknown as TgEntityArg, { limit: pageSize, offsetId, reverse: true }) as unknown as Promise<MsgLike[]>,
            15000,
          )
          for (const msg of msgs) {
            if (msg.date <= sinceTs) continue
            const row = msgToRow(msg, chatId)
            if (row) {
              insertMessage(row)
              synced++
              if (row.type === 'image') imageMsgs.push(msg)
            }
          }
          if (msgs.length < pageSize) break
          offsetId = msgs[msgs.length - 1].id
        }
      }
      await processImageMessages(client, chatId, imageMsgs as RawTelegramMessage[])
      setLastSyncedAt(chatId, Math.floor(Date.now() / 1000))
      if (isIndexed('messages')) await embedNewMessages([chatId])
      if (isIndexed('chats')) await embedNewChats([chatId])
    } catch (err) {
      console.log(`\n  [${chat.name}] skipped: ${(err as Error).message}`)
    }

    totalSynced += synced
    if (checked + skipped < dialogs.length) await sleep(300)
  }
  console.log(`\nIncremental sync complete. ${totalSynced} new messages. (${checked} checked, ${skipped} skipped)`)
}

export function createTelegramAdapter(account: string, credentials: AccountCredentials): PlatformAdapter {
  return {
    platform: 'telegram',
    account,
    async runBackfill(_db: Database.Database): Promise<void> {
      const sessionString = credentials.fields['TG_SESSION'] ?? config.sessionString
      const apiId = parseInt(credentials.fields['TG_API_ID'] ?? String(config.apiId), 10)
      const apiHash = credentials.fields['TG_API_HASH'] ?? config.apiHash
      const session = new StringSession(sessionString)
      const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 })
      await client.connect()
      process.on('unhandledRejection', () => {})
      try { await runBackfill(client, DEFAULT_SLEEP, 100, 200, account) } finally { await client.disconnect() }
    },
    async syncIncremental(_db: Database.Database, since: Date): Promise<void> {
      const sessionString = credentials.fields['TG_SESSION'] ?? config.sessionString
      const apiId = parseInt(credentials.fields['TG_API_ID'] ?? String(config.apiId), 10)
      const apiHash = credentials.fields['TG_API_HASH'] ?? config.apiHash
      const session = new StringSession(sessionString)
      const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 })
      await client.connect()
      process.on('unhandledRejection', () => {})
      try { await syncIncrementalImpl(client, since, DEFAULT_SLEEP, 100, 200, account) } finally { await client.disconnect() }
    },
    startListener(_db: Database.Database): void {},
  }
}

export const telegramAdapter: PlatformAdapter = createTelegramAdapter('default', {
  name: 'default',
  fields: {
    TG_SESSION: config.sessionString,
    TG_API_ID: String(config.apiId),
    TG_API_HASH: config.apiHash,
  },
})

/** Exported for testing: runs the mode-select + sync logic given a connected client. */
export async function runSync(
  client: TelegramClient,
  opts: { backfillFlag: boolean; since: number | null },
  syncFn: (client: TelegramClient) => Promise<void> = runBackfill,
): Promise<void> {
  const useBackfill = opts.backfillFlag || opts.since === null
  if (useBackfill) {
    console.log('[telegram] sync mode: backfill')
  } else {
    console.log('[telegram] sync mode: incremental')
  }
  await syncFn(client)
  setPlatformLastSyncedAt('telegram', 'default', Math.floor(Date.now() / 1000))
}

async function main(): Promise<void> {
  const backfillOnly = process.argv.includes('--backfill-only')
  const session = new StringSession(config.sessionString)
  const client = new TelegramClient(session, config.apiId, config.apiHash, { connectionRetries: 5 })

  if (!config.sessionString) {
    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const promptFn: PromptFn = (q) => new Promise((resolve) => rl.question(q, resolve))
    try { await runAuthWizard(client, promptFn) } finally { rl.close() }
  } else {
    await client.connect()
  }

  // GramJS fires unhandled rejections from its internal update loop on disconnect — suppress them
  process.on('unhandledRejection', () => {})

  const db = initDb('./khipuchat.db')

  try {
    await runPlatformSync(telegramAdapter, db, process.argv)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
  await terminateOcr()

  if (backfillOnly) { await client.disconnect(); process.exit(0) }
  startListener(client)
  console.log('Listening for new messages…')
  await new Promise(() => {})
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
