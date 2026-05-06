import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Chat, type Message } from '../../db'
import type { Platform, PlatformAdapter } from '../types'
import { buildWechatContactMap, type ContactMap } from './contacts'

export interface WechatMessageRow {
  MesSvrID: number
  CreateTime: number
  Message: string | null
  Des: 0 | 1
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h === 0 ? 1 : h
}

export function extractContactId(filePath: string): string {
  const base = path.basename(filePath)
  return base.replace(/^Chat_/, '').replace(/\.db$/, '')
}

export function mapChat(contactId: string, contactMap: ContactMap): Chat {
  return {
    id: hashStr(contactId),
    name: contactMap.get(contactId) ?? contactId,
    type: contactId.endsWith('@chatroom') ? 'group' : 'private',
    username: null,
    platform: 'wechat' as Platform,
  }
}

export function mapMessage(
  row: WechatMessageRow,
  chatId: number,
  contactId: string,
  contactMap: ContactMap,
): Message {
  return {
    external_id: row.MesSvrID.toString(),
    chat_id: chatId,
    sender_id: row.Des === 0 ? null : contactId,
    sender_name: row.Des === 0 ? null : (contactMap.get(contactId) ?? contactId),
    text: row.Message ?? null,
    type: row.Message ? 'text' : 'other',
    timestamp: row.CreateTime,
    is_sender: row.Des === 0 ? 1 : 0,
    reply_to_external_id: null,
    platform: 'wechat' as Platform,
  }
}

// ── Filesystem layer ──────────────────────────────────────────────────────────

function collectChatDbs(dir: string, results: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectChatDbs(full, results)
    } else if (/^Chat_.+\.db$/.test(entry.name)) {
      results.push(full)
    }
  }
}

export function discoverChatDbs(containerPath: string): string[] {
  try {
    fs.accessSync(containerPath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      throw new Error(`WeChat for Mac must be installed. Container not found at: ${containerPath}`)
    }
    throw new Error(
      `Cannot access WeChat container. Grant Full Disk Access to Terminal in System Settings → Privacy & Security → Full Disk Access. (${e.message})`,
    )
  }
  const results: string[] = []
  collectChatDbs(containerPath, results)
  return results
}

export function openWechatDb(filePath: string): Database.Database | null {
  let db: Database.Database | null = null
  try {
    db = new Database(filePath, { readonly: true })
    db.pragma('user_version') // probe: will throw SQLITE_NOTADB on encrypted/non-SQLite files
    return db
  } catch (err) {
    if (db) { try { db.close() } catch { /* ignore */ } }
    const e = err as Error
    if (e.message?.includes('file is not a database')) {
      process.stderr.write(
        `[wechat] Skipping ${filePath}: file is not a readable SQLite database (likely encrypted with SQLCipher/WCDB — key derivation not supported on Mac)\n`,
      )
    } else {
      process.stderr.write(`[wechat] Skipping ${filePath}: ${e.message}\n`)
    }
    return null
  }
}

// ── Sync core ─────────────────────────────────────────────────────────────────

export async function runBackfillImpl(
  chatDbPaths: ReadonlyArray<string>,
  contactMap: ContactMap,
): Promise<void> {
  let totalMessages = 0
  let processed = 0
  for (const dbPath of chatDbPaths) {
    const chatDb = openWechatDb(dbPath)
    if (!chatDb) continue
    processed++
    try {
      const contactId = extractContactId(dbPath)
      const chatId = hashStr(contactId)
      upsertChat(mapChat(contactId, contactMap))
      const tableName = `Chat_${contactId}`
      const rows = chatDb.prepare(
        `SELECT MesSvrID, CreateTime, Message, Des FROM "${tableName}"`,
      ).all() as WechatMessageRow[]
      for (const row of rows) {
        insertMessage(mapMessage(row, chatId, contactId, contactMap))
      }
      totalMessages += rows.length
    } finally {
      chatDb.close()
    }
  }
  console.log(`[wechat] Sync complete: ${processed} DB files processed, ${totalMessages} messages imported.`)
}

// ── Adapter ───────────────────────────────────────────────────────────────────

const DEFAULT_CONTAINER = path.join(
  homedir(),
  'Library', 'Containers', 'com.tencent.xinWeChat',
  'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat',
)

export const wechatAdapter: PlatformAdapter = {
  platform: 'wechat',
  async runBackfill(_db: Database.Database): Promise<void> {
    const containerPath = process.env['WECHAT_CONTAINER'] ?? DEFAULT_CONTAINER
    const chatDbPaths = discoverChatDbs(containerPath)
    const contactMap = buildWechatContactMap(containerPath)
    await runBackfillImpl(chatDbPaths, contactMap)
  },
  startListener(_db: Database.Database): void {},
}

async function main(): Promise<void> {
  const db = initDb('./telegram.db')
  try { await wechatAdapter.runBackfill(db) } catch { process.exit(1) }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
