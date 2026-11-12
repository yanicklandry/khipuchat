// Backward paging over one Zalo PC conversation, and idempotent per-page
// ingestion: one DB transaction per page, so an interruption leaves only whole
// pages committed (5.5) and a re-run resumes through dedupe (5.1, 5.2).
import type Database from 'better-sqlite3-multiple-ciphers'
import { getDb, upsertChat, insertMessage } from '../../../db'
import { collapseDuplicates, copyKey, toChat, toMessage } from './mapping'
import type { StoreReader } from './store-reader'
import type { PageCursor, Reporter, Result, ZaloPcConversation, ZaloPcRow } from './types'

export const DEFAULT_PAGE_SIZE = 500

/** Oldest row of a page by (sendDttm, msgId). Rows are oldest first, but never trust position. */
export function oldestCursor(rows: ZaloPcRow[]): PageCursor | null {
  let best: ZaloPcRow | null = null
  for (const r of rows) {
    if (!best) { best = r; continue }
    const d = Number(r.sendDttm) - Number(best.sendDttm)
    if (d < 0 || (d === 0 && r.msgId.localeCompare(best.msgId, undefined, { numeric: true }) < 0)) best = r
  }
  return best ? { sendDttm: best.sendDttm, msgId: best.msgId } : null
}

function olderThan(a: PageCursor, b: PageCursor): boolean {
  const d = Number(a.sendDttm) - Number(b.sendDttm)
  return d < 0 || (d === 0 && a.msgId.localeCompare(b.msgId, undefined, { numeric: true }) < 0)
}

/**
 * Pages from newest to oldest and stops after a short page. A page whose oldest
 * row is not strictly older than the cursor means the store ignored fromMsg: that is an error, never
 * a silent stop, and the repeated page is not ingested (3.3, 6.2).
 */
export async function forEachPage(
  reader: StoreReader, uid: string, pageSize: number,
  onPage: (rows: ZaloPcRow[]) => void,
  shouldStop: () => boolean = () => false,
): Promise<Result<true>> {
  let cursor: PageCursor | null = null
  for (;;) {
    if (shouldStop()) return { ok: false, error: { kind: 'interrupted', step: 'read', conversationsDone: 0 } }
    const page = await reader.getMessagePage(uid, cursor, pageSize)
    if (!page.ok) return page
    const next = oldestCursor(page.value)
    if (cursor && next && !olderThan(next, cursor)) {
      return { ok: false, error: { kind: 'shape_unrecognised', step: 'shape', detail: 'message paging cursor ignored by Zalo PC', zaloVersion: null } }
    }
    if (page.value.length > 0) onPage(page.value)
    if (page.value.length < pageSize || !next) return { ok: true, value: true }
    cursor = next
  }
}

/**
 * zalo-sync owns the names of chats it already knows, so an existing chat keeps
 * its name, unless that name is only the uid placeholder and Zalo PC now has a
 * real one. A new chat gets Zalo PC's name, or its uid when Zalo PC has none
 * (contacts whose profile Zalo PC never loaded).
 */
function chatName(conv: ZaloPcConversation, account: string): string {
  const existing = getDb().prepare(
    "SELECT name FROM chats WHERE platform = 'zalo' AND account = ? AND external_id = ?",
  ).get(account, conv.uid) as { name: string } | undefined
  const kept = existing?.name && existing.name !== conv.uid ? existing.name : null
  return kept ?? (conv.name || conv.uid)
}

const existsStmt = new WeakMap<Database.Database, Database.Statement<[number, string]>>()
function messageExists(db: Database.Database, chatId: number, externalId: string): boolean {
  let stmt = existsStmt.get(db)
  if (!stmt) {
    stmt = db.prepare<[number, string]>('SELECT 1 FROM messages WHERE chat_id = ? AND external_id = ?')
    existsStmt.set(db, stmt)
  }
  return stmt.get(chatId, externalId) !== undefined
}

/**
 * Per-conversation state carried across its pages: the chat row is resolved once,
 * and copies already handled on a newer page are not imported again (review
 * finding 4). Updated only after a page's transaction commits.
 * Known limit: across pages the first copy seen (the newer page) is kept, not
 * the preferred one; and copies split by a page boundary that moved between runs
 * are not detected (the archive stores no cliMsgId). The real archive had none.
 */
export interface ConversationState { chat: { id: number; name: string } | null; seen: Set<string> }
export const newConversationState = (): ConversationState => ({ chat: null, seen: new Set() })

export interface PageCounts { added: number; alreadyPresent: number }

/** Writes one page in one transaction. A failing message is logged and skipped (7.2). */
export function ingestPage(
  conv: ZaloPcConversation, account: string, ownUid: string, rows: ZaloPcRow[], reporter: Reporter,
  state: ConversationState = newConversationState(),
): PageCounts {
  const db = getDb()
  const pageKeys: string[] = []
  const result = db.transaction(() => {
    const counts: PageCounts = { added: 0, alreadyPresent: 0 }
    let chat = state.chat
    if (!chat) {
      const name = chatName(conv, account)
      chat = { id: upsertChat(toChat({ ...conv, name }, account)), name }
    }
    for (const row of collapseDuplicates(rows, ownUid)) {
      const key = copyKey(row, ownUid)
      if (state.seen.has(key)) continue
      try {
        const msg = toMessage(row, chat.id, ownUid, chat.name)
        if (messageExists(db, chat.id, msg.external_id)) counts.alreadyPresent++
        else { insertMessage(msg); counts.added++ }
        pageKeys.push(key) // only a copy that made it in shadows its siblings on later pages
      } catch (err) {
        reporter.warn(`Skipped message ${row.msgId} in ${conv.name || conv.uid}: ${(err as Error).message}`)
      }
    }
    return { counts, chat }
  })()
  state.chat = result.chat
  for (const k of pageKeys) state.seen.add(k)
  return result.counts
}
