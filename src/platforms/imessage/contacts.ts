import { execSync } from 'child_process'
import { readdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function findAddressBookDb(): string | null {
  const sourcesDir = join(homedir(), 'Library', 'Application Support', 'AddressBook', 'Sources')
  try {
    for (const dir of readdirSync(sourcesDir)) {
      const candidate = join(sourcesDir, dir, 'AddressBook.sqlitedb')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // AddressBook not accessible or not macOS
  }
  return null
}

/**
 * Resolve a phone number or email handle to a display name.
 * @param handleId - the handle identifier (phone/email)
 * @param dbPath - optional path to AddressBook.sqlitedb (for testing)
 */
export function resolveContactName(handleId: string, dbPath?: string): string {
  const path = dbPath ?? findAddressBookDb()
  if (!path) return handleId
  try {
    const escaped = handleId.replace(/'/g, "''")
    const sql = `SELECT COALESCE(First || ' ' || COALESCE(Last, ''), First, Last) FROM ABMultiValue JOIN ABPerson ON ABMultiValue.record_id = ABPerson.ROWID WHERE value = '${escaped}' LIMIT 1`
    const result = execSync(`sqlite3 "${path}" "${sql}"`, { encoding: 'utf8', timeout: 2000 }).trim()
    return result || handleId
  } catch {
    return handleId
  }
}

/**
 * Build a map from handle identifiers to display names.
 * @param handles - array of handle identifiers
 * @param dbPath - optional path to AddressBook.sqlitedb (for testing)
 */
export function buildContactMap(handles: ReadonlyArray<string>, dbPath?: string): Map<string, string> {
  const resolvedPath = dbPath ?? findAddressBookDb()
  if (!resolvedPath) {
    process.stderr.write('khipuchat: AddressBook not accessible — using raw handles as names\n')
  }
  const map = new Map<string, string>()
  for (const h of handles) map.set(h, resolveContactName(h, resolvedPath ?? undefined))
  return map
}
