/**
 * Mapping functions and backfill sync for Signal.
 *
 * Caller convention for mapMessage: check m.isDeleted and m.isHidden BEFORE calling.
 * Messages that are deleted or hidden should be skipped by the caller; mapMessage
 * does not inspect those fields.
 */

import Database from 'better-sqlite3-multiple-ciphers'
import type { Chat, Message } from '../../db'
import { initDb, upsertChat, insertMessage, getLastSyncedId } from '../../db'
import { runPlatformSync } from '../../sync-runner'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../../platforms/types'
import type { AccountCredentials } from '../../account-registry'
import type { BeeperChat, BeeperMessage, BeeperSignalClient } from './client'
import { createBeeperSignalClient } from './client'
import { processSignalImageMessages } from './image-sync'

export function mapChat(c: BeeperChat, account: string): Chat {
  return {
    external_id: c.id,
    account,
    name: c.title,
    type: c.type === 'single' ? 'private' : 'group',
    username: null,
    platform: 'signal' as Platform,
  }
}

export function mapMessage(m: BeeperMessage, chatId: number): Message {
  const isTextMessage = m.type === 'TEXT' && Boolean(m.text)
  const isImageMessage = m.type === 'IMAGE'
  return {
    external_id: m.id,
    chat_id: chatId,
    sender_id: null,
    sender_name: m.senderName ?? null,
    text: m.text ?? null,
    type: isImageMessage ? 'image' : isTextMessage ? 'text' : 'other',
    timestamp: Math.floor(Date.parse(m.timestamp) / 1000),
    is_sender: m.isSender ? 1 : 0,
    reply_to_external_id: m.linkedMessageID ?? null,
    platform: 'signal' as Platform,
    media_file_path: null,
    media_url: null,
    media_width: null,
    media_height: null,
    ocr_text: null,
  }
}

export async function runBackfillImpl(client: BeeperSignalClient, account = 'default'): Promise<void> {
  let totalChats = 0
  let totalMessages = 0
  let totalStored = 0
  let totalFailed = 0

  for await (const chat of client.listChats()) {
    const chatId = upsertChat(mapChat(chat, account))
    totalChats++

    const imageMsgs: BeeperMessage[] = []

    try {
      for await (const msg of client.listChatMessages(chat.id)) {
        if (msg.isDeleted || msg.isHidden) continue
        insertMessage(mapMessage(msg, chatId))
        totalMessages++
        if (msg.type === 'IMAGE') imageMsgs.push(msg)
      }
    } catch (err) {
      console.error(`[signal] Error fetching messages for chat ${chat.id}:`, err)
    }

    const { stored, failed } = await processSignalImageMessages(client, chatId, imageMsgs)
    totalStored += stored
    totalFailed += failed

    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
  }

  console.log(`[signal] Sync complete: ${totalChats} chats, ${totalMessages} messages, images: ${totalStored} stored, ${totalFailed} failed`)
}

export async function runIncrementalImpl(client: BeeperSignalClient, since: Date, account = 'default'): Promise<void> {
  let totalChats = 0
  let totalMessages = 0
  let totalStored = 0
  let totalFailed = 0

  for await (const chat of client.listChats()) {
    const chatId = upsertChat(mapChat(chat, account))
    totalChats++

    const imageMsgs: BeeperMessage[] = []

    try {
      const lastId = getLastSyncedId(chatId)
      if (lastId === null) {
        // First-time chat: fetch full history (same as backfill)
        for await (const msg of client.listChatMessages(chat.id)) {
          if (msg.isDeleted || msg.isHidden) continue
          insertMessage(mapMessage(msg, chatId))
          totalMessages++
          if (msg.type === 'IMAGE') imageMsgs.push(msg)
        }
      } else {
        // Returning chat: fetch only messages since last sync
        for await (const msg of client.listNewChatMessages(chat.id, since)) {
          if (msg.isDeleted || msg.isHidden) continue
          insertMessage(mapMessage(msg, chatId))
          totalMessages++
          if (msg.type === 'IMAGE') imageMsgs.push(msg)
        }
      }
    } catch (err) {
      console.error(`[signal] Error fetching messages for chat ${chat.id}:`, err)
    }

    const { stored, failed } = await processSignalImageMessages(client, chatId, imageMsgs)
    totalStored += stored
    totalFailed += failed

    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
  }

  console.log(`[signal] Incremental sync complete: ${totalChats} chats, ${totalMessages} messages, images: ${totalStored} stored, ${totalFailed} failed`)
}

export function createSignalAdapter(account: string, credentials: AccountCredentials): PlatformAdapter {
  return {
    platform: 'signal' as Platform,
    account,
    async runBackfill(_db: Database.Database): Promise<void> {
      const token = credentials.fields['BEEPER_ACCESS_TOKEN'] ?? ''
      if (!token) {
        process.stderr.write('[signal] BEEPER_ACCESS_TOKEN is not set. Open Beeper Desktop and export it, then re-run.\n')
        process.exit(1)
        return
      }
      await runBackfillImpl(createBeeperSignalClient(token), account)
    },
    async syncIncremental(_db: Database.Database, since: Date): Promise<void> {
      const token = credentials.fields['BEEPER_ACCESS_TOKEN'] ?? ''
      if (!token) {
        process.stderr.write('[signal] BEEPER_ACCESS_TOKEN is not set. Open Beeper Desktop and export it, then re-run.\n')
        process.exit(1)
        return
      }
      await runIncrementalImpl(createBeeperSignalClient(token), since, account)
    },
    startListener(_db: Database.Database): void {},
  }
}

export const signalAdapter: PlatformAdapter = createSignalAdapter('default', {
  name: 'default',
  fields: { BEEPER_ACCESS_TOKEN: process.env['BEEPER_ACCESS_TOKEN'] ?? '' },
})

async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  await runPlatformSync(signalAdapter, db, process.argv)
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
