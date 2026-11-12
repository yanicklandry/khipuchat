// Backward paging over one Zalo PC conversation, and idempotent per-page
// ingestion: one DB transaction per page, so an interruption leaves only whole
// pages committed (5.5) and a re-run resumes through dedupe (5.1, 5.2).
import { getDb, upsertChat, insertMessage, getMessageIdByExternalId } from '../../../db'
import { collapseDuplicates, toChat, toMessage } from './mapping'
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
): Promise<Result<true>> {
  let cursor: PageCursor | null = null
  for (;;) {
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
 * its name. A new chat gets Zalo PC's name, or its uid when Zalo PC has none
 * (contacts whose profile Zalo PC never loaded).
 */
function chatName(conv: ZaloPcConversation, account: string): string {
  const existing = getDb().prepare(
    "SELECT name FROM chats WHERE platform = 'zalo' AND account = ? AND external_id = ?",
  ).get(account, conv.uid) as { name: string } | undefined
  return existing?.name || conv.name || conv.uid
}

export interface PageCounts { added: number; alreadyPresent: number }

/** Writes one page in one transaction. A failing message is logged and skipped (7.2). */
export function ingestPage(
  conv: ZaloPcConversation, account: string, ownUid: string, rows: ZaloPcRow[], reporter: Reporter,
): PageCounts {
  return getDb().transaction((): PageCounts => {
    const counts: PageCounts = { added: 0, alreadyPresent: 0 }
    const name = chatName(conv, account)
    const chatId = upsertChat(toChat({ ...conv, name }, account))
    for (const row of collapseDuplicates(rows)) {
      try {
        const msg = toMessage(row, chatId, ownUid, name)
        if (getMessageIdByExternalId(chatId, msg.external_id) !== null) counts.alreadyPresent++
        else { insertMessage(msg); counts.added++ }
      } catch (err) {
        reporter.warn(`Skipped message ${row.msgId} in ${conv.name || conv.uid}: ${(err as Error).message}`)
      }
    }
    return counts
  })()
}
