import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Chat, type Message } from '../../db'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../types'
import { createSlackClient, type SlackClient, type SlackConversation, type SlackMessage } from './client'

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h === 0 ? 1 : h
}

export function mapChat(conv: SlackConversation): Chat {
  const type = conv.is_im ? 'private' : conv.is_mpim ? 'group' : 'user'
  return {
    id: hashStr(conv.id),
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

export async function runBackfillImpl(client: SlackClient): Promise<void> {
  let totalMessages = 0
  let totalChats = 0

  for await (const conv of client.listConversations()) {
    if (conv.is_archived) continue
    upsertChat(mapChat(conv))
    totalChats++
    const chatId = hashStr(conv.id)

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

export const slackAdapter: PlatformAdapter = {
  platform: 'slack',
  async runBackfill(_db: Database.Database): Promise<void> {
    const token = process.env['SLACK_USER_TOKEN']
    if (!token) {
      process.stderr.write('[slack] SLACK_USER_TOKEN is not set. Export it and re-run.\n')
      process.exit(1)
    }
    await runBackfillImpl(createSlackClient(token))
  },
  startListener(_db: Database.Database): void {},
}

async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  try { await slackAdapter.runBackfill(db) } catch { process.exit(1) }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
