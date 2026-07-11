import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Chat, type Message } from '../../db'
import { runPlatformSync } from '../../sync-runner'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../types'
import type { AccountCredentials } from '../../account-registry'
import { createSlackClient, type SlackClient, type SlackConversation, type SlackMessage } from './client'

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h === 0 ? 1 : h
}

export function mapChat(conv: SlackConversation, account: string): Chat {
  const type = conv.is_im ? 'private' : conv.is_mpim ? 'group' : 'user'
  return {
    external_id: conv.id,
    account,
    name: conv.name ?? conv.user ?? conv.id,
    type,
    username: null,
    platform: 'slack' as Platform,
  }
}

export function mapMessage(
  msg: SlackMessage,
  chatId: number,
  senderName: string | null,
): Message {
  return {
    external_id: msg.ts,
    chat_id: chatId,
    sender_id: msg.user ?? null,
    sender_name: senderName,
    text: msg.text || null,
    type: msg.subtype || !msg.text ? 'other' : 'text',
    timestamp: Math.floor(parseFloat(msg.ts)),
    is_sender: 0,
    reply_to_external_id: null,
    platform: 'slack' as Platform,
  }
}

export async function runBackfillImpl(client: SlackClient, account: string = 'default'): Promise<void> {
  let totalMessages = 0
  let totalChats = 0

  for await (const conv of client.listConversations()) {
    if (conv.is_archived) continue
    const chatId = upsertChat(mapChat(conv, account))
    totalChats++

    for await (const msg of client.fetchHistory(conv.id)) {
      const senderName = msg.user ? await client.getUserName(msg.user) : null
      insertMessage(mapMessage(msg, chatId, senderName))
      totalMessages++
    }
    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
  }
  console.log(`[slack] Sync complete: ${totalChats} channels, ${totalMessages} messages imported.`)
}

export async function runIncrementalImpl(client: SlackClient, since: Date, account: string = 'default'): Promise<void> {
  const oldest = (since.getTime() / 1000).toString()
  let totalMessages = 0
  let totalChats = 0

  for await (const conv of client.listConversations()) {
    if (conv.is_archived) continue
    const chatId = upsertChat(mapChat(conv, account))
    totalChats++

    for await (const msg of client.fetchHistory(conv.id, oldest)) {
      const senderName = msg.user ? await client.getUserName(msg.user) : null
      insertMessage(mapMessage(msg, chatId, senderName))
      totalMessages++
    }
    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
  }
  console.log(`[slack] Incremental sync complete: ${totalChats} channels, ${totalMessages} messages imported.`)
}

export function createSlackAdapter(account: string, credentials: AccountCredentials): PlatformAdapter {
  return {
    platform: 'slack' as Platform,
    account,
    async runBackfill(_db: Database.Database): Promise<void> {
      const token = credentials.fields['SLACK_USER_TOKEN'] ?? ''
      if (!token) {
        process.stderr.write('[slack] SLACK_USER_TOKEN is not set. Export it and re-run.\n')
        process.exit(1)
      }
      await runBackfillImpl(createSlackClient(token), account)
    },
    async syncIncremental(_db: Database.Database, since: Date): Promise<void> {
      const token = credentials.fields['SLACK_USER_TOKEN'] ?? ''
      if (!token) {
        process.stderr.write('[slack] SLACK_USER_TOKEN is not set. Export it and re-run.\n')
        process.exit(1)
      }
      await runIncrementalImpl(createSlackClient(token), since, account)
    },
    startListener(_db: Database.Database): void {},
  }
}

export const slackAdapter: PlatformAdapter = createSlackAdapter('default', {
  name: 'default',
  fields: { SLACK_USER_TOKEN: process.env['SLACK_USER_TOKEN'] ?? '' },
})

async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  await runPlatformSync(slackAdapter, db, process.argv)
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
