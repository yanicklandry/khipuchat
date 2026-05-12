import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, getDb, upsertChat, insertMessage, setLastSyncedAt, type Chat, type Message } from '../../db'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../types'
import { createWhatsAppClient, type WhatsAppClient, type WAChat, type WAMessage } from './client'

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h === 0 ? 1 : h
}

export function mapChat(chat: WAChat): Chat {
  return {
    id: hashStr(chat.id._serialized),
    name: chat.name,
    type: chat.isGroup ? 'group' : 'private',
    username: null,
    platform: 'whatsapp' as Platform,
  }
}

export function mapMessage(msg: WAMessage, chatId: number, senderName: string): Message {
  return {
    external_id: msg.id._serialized,
    chat_id: chatId,
    sender_id: msg.fromMe ? null : (msg.author ?? msg.from),
    sender_name: msg.fromMe ? null : senderName,
    text: msg.body || null,
    type: msg.type === 'chat' && msg.body ? 'text' : 'other',
    timestamp: msg.timestamp,
    is_sender: msg.fromMe ? 1 : 0,
    reply_to_external_id: null,
    platform: 'whatsapp' as Platform,
  }
}

export async function runBackfillImpl(client: WhatsAppClient): Promise<void> {
  const chats = await client.getChats()

  // Load per-chat last_synced_at for incremental mode (mirrors Telegram sync pattern)
  const syncedAt = new Map<number, number>()
  const rows = getDb().prepare(
    "SELECT id, last_synced_at FROM chats WHERE platform = 'whatsapp' AND last_synced_at IS NOT NULL",
  ).all() as { id: number; last_synced_at: number }[]
  for (const row of rows) syncedAt.set(row.id, row.last_synced_at)
  const hasPriorSync = syncedAt.size > 0

  let totalMessages = 0
  let checked = 0
  let skipped = 0

  for (const chat of chats) {
    const chatId = hashStr(chat.id._serialized)
    const chatLastSync = syncedAt.get(chatId)
    const chatTimestamp = chat.timestamp

    // Skip chats with no new activity since last sync
    if (hasPriorSync && chatLastSync !== undefined && chatTimestamp !== undefined && chatTimestamp <= chatLastSync) {
      skipped++
      continue
    }

    checked++
    upsertChat(mapChat(chat))
    const messages = await client.fetchMessages(chat.id._serialized)

    let newCount = 0
    for (const msg of messages) {
      // Skip messages already covered by the previous sync
      if (chatLastSync !== undefined && msg.timestamp <= chatLastSync) continue

      const senderId = msg.fromMe ? null : (msg.author ?? msg.from)
      const senderName = senderId ? await client.getContactName(senderId) : ''
      insertMessage(mapMessage(msg, chatId, senderName))
      newCount++
    }

    setLastSyncedAt(chatId, Math.floor(Date.now() / 1000))
    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
    totalMessages += newCount
  }

  const mode = hasPriorSync ? 'incremental' : 'first'
  console.log(`[whatsapp] Sync complete (${mode}): ${checked} chats checked, ${skipped} skipped, ${totalMessages} new messages.`)
}

export function parseArgs(argv: string[]): { debug: boolean } {
  return { debug: argv.includes('--debug') }
}

export const whatsappAdapter: PlatformAdapter = {
  platform: 'whatsapp',
  async runBackfill(_db: Database.Database): Promise<void> {
    const { debug } = parseArgs(process.argv)
    const sessionPath = process.env['WHATSAPP_SESSION']
    let client: WhatsAppClient | null = null
    try {
      client = await createWhatsAppClient({ sessionDataPath: sessionPath, debug })
      await runBackfillImpl(client)
    } catch (err) {
      const e = err as Error
      process.stderr.write(
        `[whatsapp] Error: ${e.message}\n` +
        '[whatsapp] Note: whatsapp-web.js uses an unofficial API and may break on WhatsApp updates.\n',
      )
      process.exit(1)
    } finally {
      await client?.destroy()
    }
  },
  startListener(_db: Database.Database): void {},
}

async function main(): Promise<void> {
  const db = initDb('./telegram.db')
  try { await whatsappAdapter.runBackfill(db) } catch { process.exit(1) }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
