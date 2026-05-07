import 'dotenv/config'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'
import { initDb, upsertChat, insertMessage, type Chat, type Message } from '../../db'
import type { Platform, PlatformAdapter } from '../types'
import { buildWechatContactMap, type ContactMap } from './contacts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WechatMessageRow {
  // Legacy schema (WeChat 3.x / xwechat older)
  msgSvrID?: number | bigint
  MesSvrID?: number | bigint
  CreateTime?: number
  Message?: string | null
  strContent?: string | null
  Des?: 0 | 1
  isSend?: 0 | 1
  Type?: number
  MsgType?: number
  // WeChat 4.x schema
  server_id?: number | bigint
  create_time?: number
  message_content?: string | Buffer | null
  WCDB_CT_message_content?: number   // 0=plain text, 4=zstd blob
  real_sender_id?: number
  local_type?: number
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

export function mapChat(tableName: string, displayName: string, userName?: string): Chat {
  const typeHint = userName ?? displayName
  return {
    id: tableNameToChatId(tableName),
    name: displayName,
    type: typeHint.includes('@chatroom') ? 'group' : 'private',
    username: userName ?? null,
    platform: 'wechat' as Platform,
  }
}

/**
 * Build a map from Msg_<md5> table names to the original WeChat user_name (wxid or chatroom ID).
 * WeChat 4.x stores table names as MD5(user_name).
 */
export function buildTableNameMap(db: Database.Database): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const rows = db.prepare(
      "SELECT user_name FROM Name2Id WHERE is_session = 1",
    ).all() as { user_name: string }[]
    for (const row of rows) {
      const hash = createHash('md5').update(row.user_name).digest('hex')
      map.set(`Msg_${hash}`, row.user_name)
    }
  } catch {
    // Name2Id table absent in this DB (legacy schema or no sessions)
  }
  return map
}

/** Extract readable text from a WeChat 4.x message_content value.
 *  Group chat messages are prefixed with `sender_wxid:\n`. */
function extractWechat4Text(content: string | Buffer | null | undefined): string | null {
  if (!content || Buffer.isBuffer(content)) return null  // zstd blob — skip
  const s = content as string
  // Strip group-chat sender prefix: `wxid_xxx:\ntext` or `chatroom_id:\ntext`
  const newline = s.indexOf('\n')
  if (newline > 0 && newline < 80 && s[newline - 1] !== undefined) {
    const prefix = s.slice(0, newline)
    if (/^[a-zA-Z0-9_@.:-]+$/.test(prefix)) return s.slice(newline + 1) || null
  }
  return s || null
}

export function mapMessage(row: WechatMessageRow, chatId: number): Message {
  // WeChat 4.x uses server_id / create_time / message_content / local_type
  const isV4 = row.server_id !== undefined || row.create_time !== undefined
  const externalId = isV4
    ? String(row.server_id ?? `${chatId}_${row.create_time}`)
    : String(row.MesSvrID ?? row.msgSvrID ?? `${chatId}_${row.CreateTime}`)
  const isSend: 0 | 1 = row.Des === 0 || row.isSend === 1 ? 1 : 0  // V4 is_sender unknown → 0
  const rawText = isV4
    ? (row.WCDB_CT_message_content === 0 ? extractWechat4Text(row.message_content) : null)
    : (row.Message ?? row.strContent ?? null)
  const msgType = isV4 ? (row.local_type ?? 1) : (row.Type ?? row.MsgType ?? 1)
  const timestamp = isV4 ? (row.create_time ?? 0) : (row.CreateTime ?? 0)
  return {
    external_id: externalId,
    chat_id: chatId,
    sender_id: null,
    sender_name: null,
    text: rawText,
    type: msgType === 1 && rawText ? 'text' : 'other',
    timestamp,
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

// ── Key loading ───────────────────────────────────────────────────────────────

/** Load the salt→key map from .wechat-keys.json (written by setup-wechat.sh). */
export function loadWechatKeyMap(): Map<string, string> {
  const keysFile = path.resolve(process.cwd(), '.wechat-keys.json')
  try {
    const raw = fs.readFileSync(keysFile, 'utf8')
    const obj = JSON.parse(raw) as Record<string, string>
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

/**
 * Given a database file path and a salt→key map, return the hex key for that file.
 * Returns '' if no key found (file will be opened as unencrypted / fail gracefully).
 */
export function resolveHexKey(filePath: string, keyMap: Map<string, string>): string {
  if (keyMap.size === 0) return ''
  try {
    const buf = fs.readFileSync(filePath)
    const salt = buf.slice(0, 16).toString('hex')
    return keyMap.get(salt) ?? ''
  } catch {
    return ''
  }
}

// ── Database opening ──────────────────────────────────────────────────────────

/**
 * Open a WeChat SQLCipher database.
 * @param filePath  Path to the .db file
 * @param hexKey    64-char hex key, or '' for plaintext
 */
export function openWechatDb(
  filePath: string,
  hexKey: string,
): Database.Database | null {
  let db: Database.Database | null = null
  try {
    db = new Database(filePath, { readonly: true })
    if (hexKey) {
      // WeChat 4.x uses SQLCipher 4 — must set cipher before key
      db.pragma(`cipher='sqlcipher'`)
      db.pragma(`legacy=4`)
      // Raw-key syntax: bypasses KDF, uses the 32-byte key directly
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

/** Return all Chat_* or Msg_* table names in a database, or [] on failure. */
export function listChatTables(db: Database.Database): string[] {
  try {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'Chat_%' OR name LIKE 'Msg_%')",
    ).all() as { name: string }[]
    return rows.map(r => r.name)
  } catch {
    return []
  }
}

// ── Sync core ─────────────────────────────────────────────────────────────────

/**
 * Detect the message column schema (WeChat 3.x vs 4.x) and return the SELECT columns.
 * WeChat 4.x tables use: server_id, create_time, message_content, WCDB_CT_message_content,
 *   real_sender_id, local_type.
 * Older tables use: msgSvrID/MesSvrID, CreateTime, Message/strContent, Des/isSend, Type/MsgType.
 */
function buildSelectColumns(db: Database.Database, tableName: string): string {
  const info = db.prepare(`PRAGMA table_info("${tableName}")`).all() as { name: string }[]
  const cols = new Set(info.map(c => c.name))

  if (cols.has('create_time') && cols.has('server_id')) {
    // WeChat 4.x schema
    const ct = cols.has('WCDB_CT_message_content') ? 'WCDB_CT_message_content' : '0 AS WCDB_CT_message_content'
    return `server_id, create_time, message_content, ${ct}, real_sender_id, local_type`
  }

  // Legacy schema
  const externalIdCol = cols.has('msgSvrID') ? 'msgSvrID' : cols.has('MesSvrID') ? 'MesSvrID' : 'rowid'
  const textCol = cols.has('strContent') ? 'strContent' : cols.has('Message') ? 'Message' : 'NULL'
  const dirCol = cols.has('isSend') ? 'isSend' : cols.has('Des') ? 'Des' : '0'
  const typeCol = cols.has('Type') ? 'Type' : cols.has('MsgType') ? 'MsgType' : '1'
  return `${externalIdCol} AS msgSvrID, CreateTime, ${textCol} AS Message, ${dirCol} AS Des, ${typeCol} AS Type`
}

export async function runBackfillImpl(
  messageDbs: ReadonlyArray<string>,
  contactMap: ContactMap,
  keyMap: Map<string, string>,
): Promise<void> {
  let totalMessages = 0
  let totalChats = 0

  for (const dbPath of messageDbs) {
    const hexKey = resolveHexKey(dbPath, keyMap)
    const chatDb = openWechatDb(dbPath, hexKey)
    if (!chatDb) continue

    try {
      // Build Msg_<md5> → user_name map for WeChat 4.x type detection
      const tableNameMap = buildTableNameMap(chatDb)
      const tables = listChatTables(chatDb)
      for (const tableName of tables) {
        const userName = tableNameMap.get(tableName)        // undefined for legacy Chat_ tables
        const displayName = (userName && contactMap.get(userName)) ?? userName ?? contactMap.get(tableName) ?? tableName
        const chatId = tableNameToChatId(tableName)
        upsertChat(mapChat(tableName, displayName, userName))
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

    const keyMap = loadWechatKeyMap()
    if (keyMap.size === 0) {
      process.stderr.write(
        '[wechat] No keys found (.wechat-keys.json is missing or empty).\n' +
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
    const contactMap = buildWechatContactMap(contactDir, keyMap)
    await runBackfillImpl(messageDbs, contactMap, keyMap)
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
