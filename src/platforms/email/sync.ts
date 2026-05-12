import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Message } from '../../db'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../types'
import { createEmailClient, type EmailClient, type RawEmailMessage } from './client'

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h === 0 ? 1 : h
}

export function resolveThreadChatId(
  messageId: string,
  inReplyTo: string | null,
  threadMap: Map<string, number>,
): number {
  if (inReplyTo && threadMap.has(inReplyTo)) {
    const chatId = threadMap.get(inReplyTo)!
    threadMap.set(messageId, chatId)
    return chatId
  }
  const chatId = hashStr(messageId)
  threadMap.set(messageId, chatId)
  return chatId
}

function parseSenderName(from: string): string {
  const match = from.match(/^(.+?)\s*</)
  return match?.[1]?.trim() ?? from
}

export function mapMessage(raw: RawEmailMessage, chatId: number, userEmail: string): Message {
  return {
    external_id: raw.messageId,
    chat_id: chatId,
    sender_id: null,
    sender_name: parseSenderName(raw.from),
    text: raw.text ?? null,
    type: raw.text ? 'text' : 'other',
    timestamp: Math.floor(raw.date.getTime() / 1000),
    is_sender: raw.from.toLowerCase().includes(userEmail.toLowerCase()) ? 1 : 0,
    reply_to_external_id: raw.inReplyTo ?? null,
    platform: 'email' as Platform,
  }
}

export async function runBackfillImpl(client: EmailClient, userEmail: string): Promise<void> {
  const threadMap = new Map<string, number>()
  const seenChats = new Set<number>()
  let totalMessages = 0

  async function processFolder(folder: string) {
    for await (const raw of client.fetchFolder(folder)) {
      if (!raw.messageId) {
        process.stderr.write(`[email] Skipping message with no Message-ID in ${folder}\n`)
        continue
      }
      const chatId = resolveThreadChatId(raw.messageId, raw.inReplyTo, threadMap)
      if (!seenChats.has(chatId)) {
        upsertChat({
          id: chatId,
          name: raw.subject || raw.messageId,
          type: 'user',
          username: null,
          platform: 'email',
        })
        seenChats.add(chatId)
      }
      insertMessage(mapMessage(raw, chatId, userEmail))
      totalMessages++
    }
  }

  await processFolder('INBOX')

  const sentFolder = await client.listSpecialFolder('\\Sent')
  if (sentFolder) {
    await processFolder(sentFolder)
  } else {
    process.stderr.write('[email] Sent folder not found — only INBOX synced.\n')
  }

  const chatIds = Array.from(seenChats)
  if (isIndexed('messages')) await embedNewMessages(chatIds)
  if (isIndexed('chats')) await embedNewChats(chatIds)
  console.log(`[email] Sync complete: ${seenChats.size} threads, ${totalMessages} messages imported.`)
}

export const emailAdapter: PlatformAdapter = {
  platform: 'email',
  async runBackfill(_db: Database.Database): Promise<void> {
    const host = process.env['EMAIL_IMAP_HOST']
    const user = process.env['EMAIL_IMAP_USER']
    const pass = process.env['EMAIL_IMAP_PASS']
    const missing = (['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS'] as const)
      .filter(k => !process.env[k])
    if (missing.length > 0) {
      process.stderr.write(`[email] Missing environment variables: ${missing.join(', ')}. Set them and re-run.\n`)
      process.exit(1)
    }
    await runBackfillImpl(createEmailClient(host!, user!, pass!), user!)
  },
  startListener(_db: Database.Database): void {},
}

async function main(): Promise<void> {
  const db = initDb('./telegram.db')
  try { await emailAdapter.runBackfill(db) } catch { process.exit(1) }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
