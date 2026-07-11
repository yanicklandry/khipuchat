import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Message } from '../../db'
import { runPlatformSync } from '../../sync-runner'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../types'
import type { AccountCredentials } from '../../account-registry'
import { createEmailClient, type EmailClient, type RawEmailMessage, type EmailSearchCriteria } from './client'

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h === 0 ? 1 : h
}

export function resolveThreadExternalId(
  messageId: string,
  inReplyTo: string | null,
  threadMap: Map<string, string>,
): string {
  if (inReplyTo && threadMap.has(inReplyTo)) {
    const externalId = threadMap.get(inReplyTo)!
    threadMap.set(messageId, externalId)
    return externalId
  }
  threadMap.set(messageId, messageId)
  return messageId
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

export async function runBackfillImpl(client: EmailClient, userEmail: string, criteria?: EmailSearchCriteria, account = 'default'): Promise<void> {
  const threadMap = new Map<string, string>()
  const seenChats = new Map<string, number>()
  let totalMessages = 0

  async function processFolder(folder: string) {
    for await (const raw of client.fetchFolder(folder, criteria)) {
      if (!raw.messageId) {
        process.stderr.write(`[email] Skipping message with no Message-ID in ${folder}\n`)
        continue
      }
      const threadExternalId = resolveThreadExternalId(raw.messageId, raw.inReplyTo, threadMap)
      let chatId = seenChats.get(threadExternalId)
      if (chatId === undefined) {
        chatId = upsertChat({
          external_id: threadExternalId,
          account,
          name: raw.subject || raw.messageId,
          type: 'user',
          username: null,
          platform: 'email',
        })
        seenChats.set(threadExternalId, chatId)
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

export function createEmailAdapter(account: string, credentials: AccountCredentials): PlatformAdapter {
  return {
    platform: 'email' as Platform,
    account,
    async runBackfill(_db: Database.Database): Promise<void> {
      const host = credentials.fields['EMAIL_IMAP_HOST'] ?? ''
      const user = credentials.fields['EMAIL_IMAP_USER'] ?? ''
      const pass = credentials.fields['EMAIL_IMAP_PASS'] ?? ''
      const missing = (['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS'] as const)
        .filter(k => !credentials.fields[k])
      if (missing.length > 0) {
        process.stderr.write(`[email] Missing environment variables: ${missing.join(', ')}. Set them and re-run.\n`)
        process.exit(1)
      }
      await runBackfillImpl(createEmailClient(host, user, pass), user, undefined, account)
    },
    async syncIncremental(_db: Database.Database, since: Date): Promise<void> {
      const host = credentials.fields['EMAIL_IMAP_HOST'] ?? ''
      const user = credentials.fields['EMAIL_IMAP_USER'] ?? ''
      const pass = credentials.fields['EMAIL_IMAP_PASS'] ?? ''
      const missing = (['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS'] as const)
        .filter(k => !credentials.fields[k])
      if (missing.length > 0) {
        process.stderr.write(`[email] Missing environment variables: ${missing.join(', ')}. Set them and re-run.\n`)
        process.exit(1)
      }
      await runBackfillImpl(createEmailClient(host, user, pass), user, { since }, account)
    },
    startListener(_db: Database.Database): void {},
  }
}

export const emailAdapter: PlatformAdapter = createEmailAdapter('default', {
  name: 'default',
  fields: {
    EMAIL_IMAP_HOST: process.env['EMAIL_IMAP_HOST'] ?? '',
    EMAIL_IMAP_USER: process.env['EMAIL_IMAP_USER'] ?? '',
    EMAIL_IMAP_PASS: process.env['EMAIL_IMAP_PASS'] ?? '',
  },
})

async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  await runPlatformSync(emailAdapter, db, process.argv)
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
