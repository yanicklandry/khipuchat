import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Chat, type Message } from '../../db'
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
  let totalMessages = 0

  for (const chat of chats) {
    upsertChat(mapChat(chat))
    const chatId = hashStr(chat.id._serialized)
    const messages = await client.fetchMessages(chat.id._serialized)

    for (const msg of messages) {
      const senderId = msg.fromMe ? null : (msg.author ?? msg.from)
      const senderName = senderId ? await client.getContactName(senderId) : ''
      insertMessage(mapMessage(msg, chatId, senderName))
    }
    totalMessages += messages.length
  }
  console.log(`[whatsapp] Sync complete: ${chats.length} chats, ${totalMessages} messages imported.`)
}

export const whatsappAdapter: PlatformAdapter = {
  platform: 'whatsapp',
  async runBackfill(_db: Database.Database): Promise<void> {
    const sessionPath = process.env['WHATSAPP_SESSION']
    let client: WhatsAppClient | null = null
    try {
      client = await createWhatsAppClient(sessionPath)
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
