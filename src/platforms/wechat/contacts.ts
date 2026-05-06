import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type ContactMap = ReadonlyMap<string, string>

interface ContactRow {
  m_nsUsrName: string
  m_nsNickName: string
}

function findContactDb(dir: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findContactDb(full)
      if (found) return found
    } else if (entry.name === 'WCDB_Contact.db') {
      return full
    }
  }
  return null
}

export function buildWechatContactMap(containerPath: string): ContactMap {
  const map = new Map<string, string>()
  try {
    const dbPath = findContactDb(containerPath)
    if (!dbPath) {
      process.stderr.write(`[wechat] WCDB_Contact.db not found under ${containerPath} — contact names will use raw IDs\n`)
      return map
    }
    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db.prepare('SELECT m_nsUsrName, m_nsNickName FROM WCContact').all() as ContactRow[]
      for (const row of rows) {
        if (row.m_nsUsrName && row.m_nsNickName) {
          map.set(row.m_nsUsrName, row.m_nsNickName)
        }
      }
    } finally {
      db.close()
    }
  } catch (err) {
    process.stderr.write(`[wechat] Failed to read contact map: ${(err as Error).message} — using raw IDs\n`)
  }
  return map
}
