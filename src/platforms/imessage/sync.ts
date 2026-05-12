import Database from 'better-sqlite3-multiple-ciphers'
import { join } from 'path'
import { homedir } from 'os'
import { initDb, getDb, upsertChat, insertMessage, setLastSyncedAt, type Chat, type Message } from '../../db'
import { isIndexed } from '../../vec-db'
import { embedNewMessages, embedNewChats } from '../../index-embeddings'
import type { Platform, PlatformAdapter } from '../types'
import { buildContactMap } from './contacts'

// ── Row interfaces (iMessage chat.db) ─────────────────────────────────────────

export interface ChatDbRow {
  ROWID: number; guid: string; chat_identifier: string
  display_name: string | null; room_name: string | null
}
export interface HandleRow { ROWID: number; id: string }
export interface MessageDbRow {
  ROWID: number; guid: string; text: string | null; date: number
  is_from_me: 0 | 1; handle_id: number | null; reply_to_guid: string | null
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function hashGuid(guid: string): number {
  let hash = 2166136261
  for (let i = 0; i < guid.length; i++) {
    hash ^= guid.charCodeAt(i)
    hash = (hash * 16777619) >>> 0
  }
  return hash === 0 ? 1 : hash
}

export function cocoaToUnix(cocoaDate: number): number {
  const OFFSET = 978307200 // seconds from Unix epoch (1970) to Cocoa epoch (2001)
  return (cocoaDate < 1e10 ? cocoaDate : Math.floor(cocoaDate / 1e9)) + OFFSET
}

export function openChatDb(chatDbPath: string): Database.Database {
  try {
    return new Database(chatDbPath, { readonly: true })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      process.stderr.write(`chat.db not found at ${chatDbPath}. Is this macOS?\n`)
    } else if (e.code === 'EACCES') {
      process.stderr.write(
        'Cannot read chat.db. Grant Full Disk Access to Terminal in System Settings → Privacy & Security → Full Disk Access.\n',
      )
    } else {
      process.stderr.write(`Failed to open chat.db: ${(e as Error).message}\n`)
    }
    throw err
  }
}

export function mapChat(
  row: ChatDbRow,
  handleIds: ReadonlyArray<string>,
  contactMap: Map<string, string>,
): Chat {
  const primaryHandle = handleIds[0]
  const name = row.display_name
    ?? row.room_name
    ?? (primaryHandle ? contactMap.get(primaryHandle) : undefined)
    ?? primaryHandle
    ?? row.chat_identifier
  return {
    id: hashGuid(row.guid),
    name,
    type: handleIds.length > 1 ? 'group' : 'private',
    username: null,
    platform: 'imessage' as Platform,
  }
}

export function mapMessage(
  row: MessageDbRow,
  chatId: number,
  handleRow: HandleRow | undefined,
  contactMap: Map<string, string>,
): Message {
  const senderName = handleRow ? (contactMap.get(handleRow.id) ?? handleRow.id) : null
  return {
    external_id: row.guid,
    chat_id: chatId,
    sender_id: handleRow ? String(handleRow.ROWID) : null,
    sender_name: senderName,
    text: row.text ?? null,
    type: row.text ? 'text' : 'other',
    timestamp: cocoaToUnix(row.date),
    is_sender: row.is_from_me,
    reply_to_external_id: row.reply_to_guid ?? null,
    platform: 'imessage' as Platform,
  }
}

// ── Backfill (chatDb injectable for testing) ──────────────────────────────────

export async function runBackfillImpl(chatDb: Database.Database): Promise<void> {
  const handles = chatDb.prepare('SELECT ROWID, id FROM handle').all() as HandleRow[]
  const contactMap = buildContactMap(handles.map(h => h.id))
  const handleIndex = new Map(handles.map(h => [h.ROWID, h]))

  const chats = chatDb
    .prepare('SELECT ROWID, guid, chat_identifier, display_name, room_name FROM chat')
    .all() as ChatDbRow[]

  // Load per-chat last_synced_at for incremental mode
  const syncedAt = new Map<number, number>()
  const rows = getDb().prepare(
    "SELECT id, last_synced_at FROM chats WHERE platform = 'imessage' AND last_synced_at IS NOT NULL",
  ).all() as { id: number; last_synced_at: number }[]
  for (const row of rows) syncedAt.set(row.id, row.last_synced_at)
  const hasPriorSync = syncedAt.size > 0

  // iMessage chat.db dates: Cocoa epoch (seconds since 2001-01-01). May be nanoseconds on newer macOS.
  // cocoaToUnix converts to Unix seconds. We need the inverse: Unix seconds → Cocoa nanoseconds.
  const COCOA_OFFSET = 978307200
  let totalMessages = 0

  for (const chatRow of chats) {
    const chatHandles = (chatDb.prepare(
      'SELECT h.id FROM handle h JOIN chat_handle_join chj ON chj.handle_id = h.ROWID WHERE chj.chat_id = ?',
    ).all(chatRow.ROWID) as { id: string }[]).map(r => r.id)

    const chatId = hashGuid(chatRow.guid)
    upsertChat(mapChat(chatRow, chatHandles, contactMap))

    const chatLastSync = hasPriorSync ? syncedAt.get(chatId) : undefined
    // Convert Unix seconds threshold to Cocoa nanoseconds (what chat.db stores on modern macOS)
    const cocoaThreshold = chatLastSync !== undefined
      ? BigInt(chatLastSync - COCOA_OFFSET) * 1_000_000_000n
      : undefined

    const msgRows = chatDb.prepare(`
      SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, m.handle_id, m.reply_to_guid
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE cmj.chat_id = ?${cocoaThreshold !== undefined ? ' AND m.date > ?' : ''}
    `).all(...(cocoaThreshold !== undefined ? [chatRow.ROWID, cocoaThreshold] : [chatRow.ROWID])) as MessageDbRow[]

    for (const msgRow of msgRows) {
      const handleRow = msgRow.handle_id !== null ? handleIndex.get(msgRow.handle_id) : undefined
      insertMessage(mapMessage(msgRow, chatId, handleRow, contactMap))
    }
    setLastSyncedAt(chatId, Math.floor(Date.now() / 1000))
    if (isIndexed('messages')) await embedNewMessages([chatId])
    if (isIndexed('chats')) await embedNewChats([chatId])
    totalMessages += msgRows.length
  }

  const mode = hasPriorSync ? 'incremental' : 'first'
  console.log(`iMessage sync complete (${mode}): ${chats.length} chats, ${totalMessages} new messages imported.`)
}

export const iMessageAdapter: PlatformAdapter = {
  platform: 'imessage',
  async runBackfill(_db: Database.Database): Promise<void> {
    const chatDbPath = join(homedir(), 'Library', 'Messages', 'chat.db')
    const chatDb = openChatDb(chatDbPath)
    try { await runBackfillImpl(chatDb) } finally { chatDb.close() }
  },
  startListener(_db: Database.Database): void {},
}

async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  try { await iMessageAdapter.runBackfill(db) } catch { process.exit(1) }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
