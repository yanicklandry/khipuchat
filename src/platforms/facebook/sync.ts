/**
 * Mapping functions and backfill sync for Facebook Messenger.
 *
 * Caller convention for mapMessage: check m.isDeleted and m.isHidden BEFORE calling.
 * Messages that are deleted or hidden should be skipped by the caller; mapMessage
 * does not inspect those fields.
 */

import Database from 'better-sqlite3-multiple-ciphers'
import type { Chat, Message } from '../../db'
import { initDb, upsertChat, insertMessage, getLastSyncedId } from '../../db'
import { runSyncEntrypoint } from '../../sync-runner'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../../platforms/types'
import type { AccountCredentials } from '../../account-registry'
import type { BeeperChat, BeeperMessage, BeeperFacebookClient } from './client'
import { createBeeperFacebookClient } from './client'
import { processFacebookImageMessages, createFacebookAttachmentFetcher } from './image-sync'
import type { AttachmentFetcher } from './image-sync'

export function mapChat(c: BeeperChat, account: string): Chat {
  return {
    external_id: c.id,
    account,
    name: c.title,
    type: c.type === 'single' ? 'private' : 'group',
    username: null,
    platform: 'facebook' as Platform,
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
    platform: 'facebook' as Platform,
    media_file_path: null,
    media_url: null,
    media_width: null,
    media_height: null,
    ocr_text: null,
  }
}

export async function runBackfillImpl(client: BeeperFacebookClient, account = 'default', fetcher?: AttachmentFetcher): Promise<void> {
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
      console.error(`[facebook] Error fetching messages for chat ${chat.id}:`, err)
    }

    if (fetcher) {
      const { stored, failed } = await processFacebookImageMessages(fetcher, chatId, imageMsgs)
      totalStored += stored
      totalFailed += failed
    }

    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
  }

  console.log(`[facebook] Sync complete: ${totalChats} chats, ${totalMessages} messages, images: ${totalStored} stored, ${totalFailed} failed`)
}

export async function runIncrementalImpl(client: BeeperFacebookClient, since: Date, account = 'default', fetcher?: AttachmentFetcher): Promise<void> {
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
      console.error(`[facebook] Error fetching messages for chat ${chat.id}:`, err)
    }

    if (fetcher) {
      const { stored, failed } = await processFacebookImageMessages(fetcher, chatId, imageMsgs)
      totalStored += stored
      totalFailed += failed
    }

    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
  }

  console.log(`[facebook] Incremental sync complete: ${totalChats} chats, ${totalMessages} messages, images: ${totalStored} stored, ${totalFailed} failed`)
}

export function createFacebookAdapter(account: string, credentials: AccountCredentials): PlatformAdapter {
  return {
    platform: 'facebook' as Platform,
    account,
    async runBackfill(_db: Database.Database): Promise<void> {
      const token = credentials.fields['BEEPER_ACCESS_TOKEN'] ?? ''
      if (!token) {
        process.stderr.write('[facebook] BEEPER_ACCESS_TOKEN is not set. Open Beeper Desktop and export it, then re-run.\n')
        process.exit(1)
        return
      }
      const fetcher = createFacebookAttachmentFetcher(token)
      await runBackfillImpl(createBeeperFacebookClient(token), account, fetcher)
    },
    async syncIncremental(_db: Database.Database, since: Date): Promise<void> {
      const token = credentials.fields['BEEPER_ACCESS_TOKEN'] ?? ''
      if (!token) {
        process.stderr.write('[facebook] BEEPER_ACCESS_TOKEN is not set. Open Beeper Desktop and export it, then re-run.\n')
        process.exit(1)
        return
      }
      const fetcher = createFacebookAttachmentFetcher(token)
      await runIncrementalImpl(createBeeperFacebookClient(token), since, account, fetcher)
    },
    startListener(_db: Database.Database): void {},
  }
}

export const facebookAdapter: PlatformAdapter = createFacebookAdapter('default', {
  name: 'default',
  fields: { BEEPER_ACCESS_TOKEN: process.env['BEEPER_ACCESS_TOKEN'] ?? '' },
})

async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  await runSyncEntrypoint('facebook', createFacebookAdapter, db, process.argv)
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
