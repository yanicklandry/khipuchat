import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'

export type ContactMap = ReadonlyMap<string, string>

interface ContactRow {
  m_nsUsrName: string
  m_nsNickName: string
}

/**
 * Build a map of contact ID → display name from the WeChat contact database.
 * Handles both old format (WCDB_Contact.db recursively searched) and new format
 * (contact.db in db_storage/contact/).
 *
 * @param contactDir  The db_storage/contact directory for xwechat_files format,
 *                    or any directory to search recursively for WCDB_Contact.db.
 * @param hexKey      64-char hex SQLCipher key, or '' for unencrypted.
 */
export function buildWechatContactMap(
  contactDir: string,
  hexKey = process.env['WECHAT_DB_KEY'] ?? '',
): ContactMap {
  const map = new Map<string, string>()

  // Try new format: contact.db directly in contactDir
  const newFormatPath = path.join(contactDir, 'contact.db')
  if (fs.existsSync(newFormatPath)) {
    tryOpenContactDb(newFormatPath, hexKey, map)
    return map
  }

  // Fallback: search recursively for WCDB_Contact.db (old format)
  const oldFormatPath = findDbRecursive(contactDir, 'WCDB_Contact.db')
  if (oldFormatPath) {
    tryOpenContactDb(oldFormatPath, '', map)  // old format was unencrypted
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
      db.pragma(`key = "x'${hexKey}'"`)
    }
    db.pragma('user_version')

    // Try common WeChat contact table schemas
    const tablesToTry = ['WCContact', 'Contact', 'Friend']
    for (const table of tablesToTry) {
      try {
        const rows = db.prepare(
          `SELECT m_nsUsrName, m_nsNickName FROM "${table}"`,
        ).all() as ContactRow[]
        for (const row of rows) {
          if (row.m_nsUsrName && row.m_nsNickName) {
            map.set(row.m_nsUsrName, row.m_nsNickName)
          }
        }
        break
      } catch {
        // Table doesn't exist or wrong schema, try next
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
