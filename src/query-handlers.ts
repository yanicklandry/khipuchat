import { getDb, searchMessages, type Platform } from './db'
import {
  isIndexed,
  semanticFindContacts,
  semanticSearchMessages,
  type SemanticContactResult,
  type SemanticMessageResult,
  type ContactFilters,
  type MessageFilters,
} from './vec-db'
import { embedOne } from './embeddings'

/**
 * Detect temporal keywords in a query and return timestamp filters.
 * Used server-side so both CLI and MCP calls benefit from temporal-aware scanning.
 */
export function parseTemporalFilters(query: string): Pick<MessageFilters, 'after_timestamp' | 'before_timestamp'> {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const rules: Array<{ pattern: RegExp; after: () => Date; before?: () => Date }> = [
    { pattern: /\b(tonight|today)\b/i,    after: () => new Date(today.getTime() - 7 * 86400_000) },
    { pattern: /\byesterday\b/i,           after: () => new Date(today.getTime() - 8 * 86400_000), before: () => today },
    { pattern: /\bthis week\b/i,           after: () => new Date(today.getTime() - 7 * 86400_000) },
    { pattern: /\bthis month\b/i,          after: () => new Date(today.getFullYear(), today.getMonth(), 1) },
    { pattern: /\brecently?\b/i,           after: () => new Date(today.getTime() - 30 * 86400_000) },
  ]

  for (const { pattern, after, before } of rules) {
    if (pattern.test(query)) {
      return {
        after_timestamp: Math.floor(after().getTime() / 1000),
        ...(before ? { before_timestamp: Math.floor(before().getTime() / 1000) } : {}),
      }
    }
  }
  return {}
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface ChatResult {
  chat_id: number
  name: string
  type: string
  username: string | null
  message_count: number
  platform: Platform
  account: string
}

export interface MessageResult {
  id: number
  sender_name: string | null
  text: string
  type: string
  timestamp: number
  is_sender: number
  platform: Platform
  account: string
}

export interface SummaryResult {
  name: string
  type: string
  username: string | null
  message_count: number
  first_message_date: number | null
  last_message_date: number | null
  last_5_texts: string[]
  platform: Platform
}

// ── Tool handlers (exported for testing) ─────────────────────────────────────

export function handleListChats(platform?: Platform, account?: string, limit = 200): ChatResult[] {
  const conditions: string[] = []
  const args: unknown[] = []
  if (platform !== undefined) { conditions.push('c.platform = ?'); args.push(platform) }
  if (account !== undefined) { conditions.push('c.account = ?'); args.push(account) }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  args.push(limit)
  return getDb().prepare(`
    SELECT c.id AS chat_id, c.name, c.type, c.username, c.platform, c.account,
           COUNT(m.id) AS message_count
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    ${whereClause}
    GROUP BY c.id
    ORDER BY MAX(m.timestamp) DESC NULLS LAST
    LIMIT ?
  `).all(...args) as ChatResult[]
}

export function handleFindChatByName(name: string, platform?: Platform, account?: string): ChatResult[] {
  const pattern = `%${name}%`
  const extraClauses: string[] = []
  const args: unknown[] = [pattern, pattern]
  if (platform !== undefined) { extraClauses.push('c.platform = ?'); args.push(platform) }
  if (account !== undefined) { extraClauses.push('c.account = ?'); args.push(account) }
  const extra = extraClauses.length > 0 ? `AND ${extraClauses.join(' AND ')}` : ''
  return getDb().prepare(`
    SELECT c.id AS chat_id, c.name, c.type, c.username, c.platform, c.account,
           COUNT(m.id) AS message_count
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE (LOWER(c.name) LIKE LOWER(?) OR LOWER(c.username) LIKE LOWER(?)) ${extra}
    GROUP BY c.id
    ORDER BY message_count DESC
  `).all(...args) as ChatResult[]
}

export function handleListMessages(
  chatId: number,
  opts?: { before?: number; limit?: number; account?: string },
): { messages: MessageResult[]; has_more: boolean } {
  const limit = opts?.limit ?? 50
  const beforeTimestamp = opts?.before
  const cap = Math.min(limit, 200)
  const fetchCount = cap + 1
  if (beforeTimestamp !== undefined) {
    // With before: fetch DESC LIMIT cap+1, reverse to ASC.
    // After reversing, probe row (oldest) is at index 0 — drop it when has_more.
    const rows = getDb().prepare(`
      SELECT m.id, m.sender_name, m.text, m.type, m.timestamp, m.is_sender, m.platform, c.account FROM (
        SELECT m.id, m.sender_name, m.text, m.type, m.timestamp, m.is_sender, m.platform
        FROM messages m
        WHERE m.chat_id = ? AND m.type = 'text' AND m.text IS NOT NULL AND m.text != ''
          AND m.timestamp < ?
        ORDER BY m.timestamp DESC LIMIT ?
      ) m
      JOIN chats c ON c.id = ?
      ORDER BY m.timestamp ASC
    `).all(chatId, beforeTimestamp, fetchCount, chatId) as MessageResult[]
    const has_more = rows.length > cap
    const messages = has_more ? rows.slice(1) : rows
    return { messages, has_more }
  } else {
    // No beforeTimestamp: return the N most recent messages in chronological order.
    // Fetch cap+1 DESC to detect if there are older messages (has_more).
    // After reversing to ASC, the extra "probe" row is at index 0 (oldest) — drop it when has_more.
    const rows = getDb().prepare(`
      SELECT m.id, m.sender_name, m.text, m.type, m.timestamp, m.is_sender, m.platform, c.account FROM (
        SELECT m.id, m.sender_name, m.text, m.type, m.timestamp, m.is_sender, m.platform
        FROM messages m
        WHERE m.chat_id = ? AND m.type = 'text' AND m.text IS NOT NULL AND m.text != ''
        ORDER BY m.timestamp DESC LIMIT ?
      ) m
      JOIN chats c ON c.id = ?
      ORDER BY m.timestamp ASC
    `).all(chatId, fetchCount, chatId) as MessageResult[]
    const has_more = rows.length > cap
    const messages = has_more ? rows.slice(1) : rows
    return { messages, has_more }
  }
}

export function handleSearchMessages(query: string, chatId?: number, platform?: Platform, account?: string) {
  return searchMessages(query, chatId, platform, account)
}

export function handleGetChatSummary(chatId: number): SummaryResult {
  const row = getDb().prepare(`
    SELECT c.name, c.type, c.username, c.platform,
           COUNT(m.id) AS message_count,
           MIN(m.timestamp) AS first_message_date,
           MAX(m.timestamp) AS last_message_date
    FROM chats c
    LEFT JOIN messages m ON m.chat_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(chatId) as {
    name: string; type: string; username: string | null; platform: Platform
    message_count: number; first_message_date: number | null; last_message_date: number | null
  } | undefined

  if (!row) throw new Error(`Chat ${chatId} not found`)

  const texts = getDb().prepare(`
    SELECT text FROM messages
    WHERE chat_id = ? AND type = 'text' AND text IS NOT NULL AND text != ''
    ORDER BY timestamp DESC LIMIT 5
  `).all(chatId).map((r) => (r as { text: string }).text).reverse()

  return { ...row, last_5_texts: texts }
}

export function listArchiveAccounts(): { platform: string; account: string }[] {
  return getDb().prepare(`
    SELECT DISTINCT platform, account FROM chats ORDER BY platform, account
  `).all() as { platform: string; account: string }[]
}

const INDEX_NOT_BUILT_MSG = 'Embedding index not built. Run: npm run index:embeddings'

export async function handleSemanticFindContacts(
  query: string,
  filters: ContactFilters,
): Promise<SemanticContactResult[] | { error: string }> {
  if (!isIndexed('chats')) return { error: INDEX_NOT_BUILT_MSG }
  const vector = await embedOne(query)
  return semanticFindContacts(vector, filters)
}

export async function handleSemanticSearchMessages(
  query: string,
  filters: MessageFilters,
): Promise<SemanticMessageResult[] | { error: string }> {
  if (!isIndexed('messages')) return { error: INDEX_NOT_BUILT_MSG }
  const vector = await embedOne(query)
  // Merge caller-supplied filters with temporal hints inferred from the query.
  // When a time window is active, default min_similarity to 0.45 to suppress noise —
  // callers can override by passing min_similarity explicitly.
  const temporal = parseTemporalFilters(query)
  const hasTemporalFilter = temporal.after_timestamp !== undefined
  const mergedFilters: MessageFilters = {
    ...(hasTemporalFilter ? { min_similarity: 0.45 } : {}),
    ...temporal,
    ...filters,
  }
  return semanticSearchMessages(vector, mergedFilters)
}
