import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { resolveHexKey } from './sync'

export type ContactMap = ReadonlyMap<string, string>

interface ContactRow {
  username: string
  display_name: string
}

/**
 * Build a map of contact ID → display name from the WeChat contact database.
 * Handles both old format (WCDB_Contact.db recursively searched) and new format
 * (contact.db in db_storage/contact/).
 *
 * @param contactDir  The db_storage/contact directory for xwechat_files format,
 *                    or any directory to search recursively for WCDB_Contact.db.
 * @param keyMap      salt→key map from .wechat-keys.json
 */
export function buildWechatContactMap(
  contactDir: string,
  keyMap: Map<string, string> = new Map(),
): ContactMap {
  const map = new Map<string, string>()

  // Try new format: contact.db directly in contactDir
  const newFormatPath = path.join(contactDir, 'contact.db')
  if (fs.existsSync(newFormatPath)) {
    const hexKey = resolveHexKey(newFormatPath, keyMap)
    tryOpenContactDb(newFormatPath, hexKey, map)
    return map
  }

  // Fallback: search recursively for WCDB_Contact.db (old format, unencrypted)
  const oldFormatPath = findDbRecursive(contactDir, 'WCDB_Contact.db')
  if (oldFormatPath) {
    tryOpenContactDb(oldFormatPath, '', map)
    return map
  }

  process.stderr.write(
    `[wechat] Contact database not found in ${contactDir} — names will show as raw IDs\n`,
  )
  return map
}

function tryOpenContactDb(dbPath: string, hexKey: string, map: Map<string, string>): void {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    if (hexKey) {
      db.pragma(`cipher='sqlcipher'`)
      db.pragma(`legacy=4`)
      db.pragma(`key = "x'${hexKey}'"`)
    }
    db.pragma('user_version')

    // Try common WeChat contact table schemas.
    // WeChat 4.x uses lowercase 'contact' with 'username'/'nick_name'/'remark'.
    // Legacy WCDB uses 'WCContact'/'Contact'/'Friend' with 'm_nsUsrName'/'m_nsNickName'.
    const tablesToTry = ['contact', 'WCContact', 'Contact', 'Friend']
    for (const table of tablesToTry) {
      try {
        const info = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
        if (info.length === 0) continue  // table doesn't exist
        const cols = new Set(info.map((c) => c.name))

        let userCol: string
        let nameExpr: string
        if (cols.has('username') && cols.has('nick_name')) {
          // WeChat 4.x schema
          userCol = 'username'
          nameExpr = cols.has('remark')
            ? `COALESCE(NULLIF(TRIM(remark), ''), nick_name)`
            : 'nick_name'
        } else if (cols.has('m_nsUsrName') && cols.has('m_nsNickName')) {
          // Legacy WCDB schema
          userCol = 'm_nsUsrName'
          nameExpr = cols.has('m_nsRemark')
            ? `COALESCE(NULLIF(TRIM(m_nsRemark), ''), m_nsNickName)`
            : 'm_nsNickName'
        } else {
          continue  // unknown schema
        }

        const rows = db.prepare(
          `SELECT ${userCol} AS username, ${nameExpr} AS display_name FROM "${table}"`,
        ).all() as ContactRow[]
        for (const row of rows) {
          if (row.username && row.display_name) {
            map.set(row.username, row.display_name)
          }
        }
        break
      } catch {
        // unexpected error, try next
      }
    }

    process.stderr.write(`[wechat] Loaded ${map.size} contacts from ${dbPath}\n`)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('file is not a database')) {
      process.stderr.write(
        `[wechat] Contact database is encrypted — contact names will show as raw IDs\n` +
        `        Run: npm run setup:wechat\n`,
      )
    } else {
      process.stderr.write(
        `[wechat] Failed to read contacts from ${dbPath}: ${msg}\n`,
      )
    }
  } finally {
    if (db) { try { db.close() } catch { /* ignore */ } }
  }
}

function findDbRecursive(dir: string, filename: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findDbRecursive(full, filename)
      if (found) return found
    } else if (entry.name === filename) {
      return full
    }
  }
  return null
}
