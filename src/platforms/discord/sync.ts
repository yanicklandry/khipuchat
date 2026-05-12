import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Chat, type Message } from '../../db'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../types'
import { createDiscordClient, type DiscordClient, type DiscordChannel, type DiscordMessage } from './client'

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h === 0 ? 1 : h
}

export function mapChat(channel: DiscordChannel): Chat {
  const isGroup = channel.type === 0 || channel.type === 3
  const name = channel.name ?? channel.recipients?.[0]?.username ?? channel.id
  return {
    id: hashStr(channel.id),
    name,
    type: isGroup ? 'group' : 'private',
    username: null,
    platform: 'discord' as Platform,
  }
}

export function mapMessage(msg: DiscordMessage, chatId: number): Message {
  return {
    external_id: msg.id,
    chat_id: chatId,
    sender_id: msg.author.id,
    sender_name: msg.author.username,
    text: msg.content || null,
    type: msg.content ? 'text' : 'other',
    timestamp: Math.floor(Date.parse(msg.timestamp) / 1000),
    is_sender: 0,
    reply_to_external_id: msg.message_reference?.message_id ?? null,
    platform: 'discord' as Platform,
  }
}

const ALLOWED_TYPES = new Set([0, 1, 3])

export async function runBackfillImpl(client: DiscordClient): Promise<void> {
  const channels: DiscordChannel[] = []

  const dms = await client.getDirectMessageChannels()
  for (const ch of dms) {
    if (ALLOWED_TYPES.has(ch.type)) channels.push(ch)
  }

  const guilds = await client.getGuilds()
  for (const guild of guilds) {
    const guildChannels = await client.getGuildChannels(guild.id)
    for (const ch of guildChannels) {
      if (ALLOWED_TYPES.has(ch.type)) channels.push(ch)
    }
  }

  let totalMessages = 0
  for (const channel of channels) {
    upsertChat(mapChat(channel))
    const chatId = hashStr(channel.id)
    let before: string | undefined
    while (true) {
      const messages = await client.getMessages(channel.id, before)
      if (messages.length === 0) break
      for (const msg of messages) {
        insertMessage(mapMessage(msg, chatId))
      }
      totalMessages += messages.length
      if (messages.length < 100) break
      before = messages[messages.length - 1]!.id
    }
    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
  }
  console.log(`[discord] Sync complete: ${channels.length} channels, ${totalMessages} messages imported.`)
}

export const discordAdapter: PlatformAdapter = {
  platform: 'discord',
  async runBackfill(_db: Database.Database): Promise<void> {
    const token = process.env['DISCORD_TOKEN']
    if (!token) {
      process.stderr.write('[discord] DISCORD_TOKEN is not set. Export it and re-run.\n')
      process.exit(1)
    }
    await runBackfillImpl(createDiscordClient(token))
  },
  startListener(_db: Database.Database): void {},
}

async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  try { await discordAdapter.runBackfill(db) } catch { process.exit(1) }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
