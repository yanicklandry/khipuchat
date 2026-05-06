import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Chat, type Message } from '../../db'
import type { Platform, PlatformAdapter } from '../types'
import { buildWechatContactMap, type ContactMap } from './contacts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WechatMessageRow {
  msgSvrID?: number | bigint
  MesSvrID?: number | bigint
  CreateTime: number
  Message?: string | null
  strContent?: string | null
  Des?: 0 | 1
  isSend?: 0 | 1
  Type?: number
  MsgType?: number
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

/** Convert a table name (Chat_XXXX) to a stable numeric chat ID. */
export function tableNameToChatId(tableName: string): number {
  return hashStr(tableName)
}

export function mapChat(tableName: string, displayName: string): Chat {
  return {
    id: tableNameToChatId(tableName),
    name: displayName,
    type: displayName.includes('@chatroom') ? 'group' : 'private',
    username: null,
    platform: 'wechat' as Platform,
  }
}

export function mapMessage(row: WechatMessageRow, chatId: number): Message {
  // Handle both old (MesSvrID/Des) and new (msgSvrID/isSend) column names
  const externalId = String(row.MesSvrID ?? row.msgSvrID ?? chatId + '_' + row.CreateTime)
  const isSend = row.Des === 0 || row.isSend === 1 ? 1 : 0
  const text = row.Message ?? row.strContent ?? null
  const msgType = row.Type ?? row.MsgType ?? 1
  return {
    external_id: externalId,
    chat_id: chatId,
    sender_id: null,
    sender_name: null,
    text,
    type: msgType === 1 && text ? 'text' : 'other',
    timestamp: row.CreateTime,
    is_sender: isSend,
    reply_to_external_id: null,
    platform: 'wechat' as Platform,
  }
}

// ── Filesystem discovery ──────────────────────────────────────────────────────

/** Return the xwechat_files root: ~/Library/Containers/…/Documents/xwechat_files */
export function resolveXwechatRoot(): string {
  return path.join(
    homedir(),
    'Library', 'Containers', 'com.tencent.xinWeChat',
    'Data', 'Documents', 'xwechat_files',
  )
}

/** Find the first wxid_* user directory under xwechat_files. */
export function findUserDir(xwechatRoot: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(xwechatRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isDirectory() && /^wxid_/.test(e.name)) {
      return path.join(xwechatRoot, e.name)
    }
  }
  return null
}

/** Return paths to message_N.db files (N = 0..11) that exist on disk. */
export function discoverMessageDbs(userDir: string): string[] {
  const msgDir = path.join(userDir, 'db_storage', 'message')
  const found: string[] = []
  for (let i = 0; i <= 11; i++) {
    const p = path.join(msgDir, `message_${i}.db`)
    if (fs.existsSync(p)) found.push(p)
  }
  return found
}

/** Validate the container root exists; throw descriptive errors if not. */
export function validateContainer(containerRoot: string): void {
  try {
    fs.accessSync(containerRoot)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      throw new Error(
        '[wechat] WeChat for Mac is not installed or has never been launched.\n' +
        'Install WeChat from https://mac.weixin.qq.com/ and log in.',
      )
    }
    throw new Error(
      '[wechat] Cannot access WeChat container. Grant Full Disk Access to Terminal in\n' +
      'System Settings → Privacy & Security → Full Disk Access.',
    )
  }
}

// ── Database opening ──────────────────────────────────────────────────────────

/**
 * Open a WeChat SQLCipher database.
 * @param filePath  Path to the .db file
 * @param hexKey    64-char hex SQLCipher key (WECHAT_DB_KEY), or empty for plaintext
 */
export function openWechatDb(
  filePath: string,
  hexKey: string,
): Database.Database | null {
  let db: Database.Database | null = null
  try {
    db = new Database(filePath, { readonly: true })
    if (hexKey) {
      // SQLCipher raw-key syntax: x'<64 hex chars>'
      db.pragma(`key = "x'${hexKey}'"`)
    }
    // Probe: triggers SQLITE_NOTADB on wrong key or unencrypted file
    db.pragma('user_version')
    return db
  } catch (err) {
    if (db) { try { db.close() } catch { /* ignore */ } }
    const msg = (err as Error).message ?? ''
    if (msg.includes('file is not a database')) {
      if (!hexKey) {
        process.stderr.write(
          `[wechat] ${path.basename(filePath)}: encrypted (run 'npm run setup:wechat' to extract the key)\n`,
        )
      } else {
        process.stderr.write(
          `[wechat] ${path.basename(filePath)}: wrong key or not a SQLCipher database\n`,
        )
      }
    } else {
      process.stderr.write(`[wechat] ${path.basename(filePath)}: ${msg}\n`)
    }
    return null
  }
}

/** Return all Chat_* table names in a database, or [] on failure. */
export function listChatTables(db: Database.Database): string[] {
  try {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Chat_%'",
    ).all() as { name: string }[]
    return rows.map(r => r.name)
  } catch {
    return []
  }
}

// ── Sync core ─────────────────────────────────────────────────────────────────

/**
 * Detect the message column schema from the first row of a Chat_* table.
 * Returns a SQL fragment for SELECT and a type discriminator.
 */
function buildSelectColumns(db: Database.Database, tableName: string): string {
  // Probe column names
  const info = db.prepare(`PRAGMA table_info("${tableName}")`).all() as { name: string }[]
  const cols = new Set(info.map(c => c.name))

  const externalIdCol = cols.has('msgSvrID') ? 'msgSvrID' : cols.has('MesSvrID') ? 'MesSvrID' : 'rowid'
  const textCol = cols.has('strContent') ? 'strContent' : cols.has('Message') ? 'Message' : 'NULL'
  const dirCol = cols.has('isSend') ? 'isSend' : cols.has('Des') ? 'Des' : '0'
  const typeCol = cols.has('Type') ? 'Type' : cols.has('MsgType') ? 'MsgType' : '1'

  return `${externalIdCol} AS msgSvrID, CreateTime, ${textCol} AS Message, ${dirCol} AS Des, ${typeCol} AS Type`
}

export async function runBackfillImpl(
  messageDbs: ReadonlyArray<string>,
  contactMap: ContactMap,
  hexKey: string,
): Promise<void> {
  let totalMessages = 0
  let totalChats = 0

  for (const dbPath of messageDbs) {
    const chatDb = openWechatDb(dbPath, hexKey)
    if (!chatDb) continue

    try {
      const tables = listChatTables(chatDb)
      for (const tableName of tables) {
        // tableName is like Chat_a3f4b7...
        // Try to find a friendly name from contact map
        const chatId = tableNameToChatId(tableName)
        const displayName = contactMap.get(tableName) ?? tableName
        upsertChat(mapChat(tableName, displayName))
        totalChats++

        try {
          const selectCols = buildSelectColumns(chatDb, tableName)
          const rows = chatDb.prepare(
            `SELECT ${selectCols} FROM "${tableName}"`,
          ).all() as WechatMessageRow[]

          for (const row of rows) {
            insertMessage(mapMessage(row, chatId))
          }
          totalMessages += rows.length
        } catch (err) {
          process.stderr.write(
            `[wechat] Error reading ${tableName}: ${(err as Error).message}\n`,
          )
        }
      }
    } finally {
      chatDb.close()
    }
  }

  process.stdout.write(
    `[wechat] Sync complete: ${totalChats} chats, ${totalMessages} messages imported.\n`,
  )
}

// ── Adapter ───────────────────────────────────────────────────────────────────

const DEFAULT_CONTAINER = resolveXwechatRoot()

export const wechatAdapter: PlatformAdapter = {
  platform: 'wechat',
  async runBackfill(_db: Database.Database): Promise<void> {
    const containerPath = process.env['WECHAT_CONTAINER'] ?? DEFAULT_CONTAINER
    validateContainer(containerPath)

    const userDir = findUserDir(containerPath)
    if (!userDir) {
      throw new Error(
        '[wechat] No WeChat user directory found. Log in to WeChat first.',
      )
    }

    const hexKey = process.env['WECHAT_DB_KEY'] ?? ''
    if (!hexKey) {
      process.stderr.write(
        '[wechat] WECHAT_DB_KEY is not set. Databases are encrypted.\n' +
        'Run: npm run setup:wechat\n',
      )
    }

    const messageDbs = discoverMessageDbs(userDir)
    if (messageDbs.length === 0) {
      throw new Error('[wechat] No message databases found. Log in to WeChat first.')
    }
    process.stdout.write(
      `[wechat] Found ${messageDbs.length} message databases in ${userDir}\n`,
    )

    const contactDir = path.join(userDir, 'db_storage', 'contact')
    const contactMap = buildWechatContactMap(contactDir)
    await runBackfillImpl(messageDbs, contactMap, hexKey)
  },
  startListener(_db: Database.Database): void {},
}

async function main(): Promise<void> {
  const db = initDb('./telegram.db')
  try {
    await wechatAdapter.runBackfill(db)
  } catch (err) {
    process.stderr.write(`[wechat] Fatal: ${(err as Error).message}\n`)
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`[wechat] ${(err as Error).message}\n`)
    process.exit(1)
  })
}
