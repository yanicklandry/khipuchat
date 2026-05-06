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

const SWIFT_CONTACTS_SCRIPT = `
import Contacts
let store = CNContactStore()
let keys: [CNKeyDescriptor] = [
  CNContactGivenNameKey as CNKeyDescriptor,
  CNContactFamilyNameKey as CNKeyDescriptor,
  CNContactPhoneNumbersKey as CNKeyDescriptor,
  CNContactEmailAddressesKey as CNKeyDescriptor,
]
let req = CNContactFetchRequest(keysToFetch: keys)
var lines: [String] = []
try? store.enumerateContacts(with: req) { c, _ in
  let name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
  guard !name.isEmpty else { return }
  for ph in c.phoneNumbers { lines.append("\\(ph.value.stringValue)|\\(name)") }
  for em in c.emailAddresses { lines.append("\\(em.value)|\\(name)") }
}
print(lines.joined(separator: "\\n"))
`.trim()

/**
 * Export all phone/email→name mappings using Swift + Contacts framework.
 * Fast (~1s), no Full Disk Access needed, requires Contacts permission.
 */
function loadContactsViaSwift(): Map<string, string> | null {
  try {
    const raw = execSync(`swift -e '${SWIFT_CONTACTS_SCRIPT.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf8', timeout: 15000,
    }).trim()
    if (!raw) return null
    const map = new Map<string, string>()
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('|')
      if (idx > 0) {
        const key = line.slice(0, idx).trim()
        const val = line.slice(idx + 1).trim()
        if (key && val) map.set(key, val)
      }
    }
    return map.size > 0 ? map : null
  } catch {
    return null
  }
}

function matchHandle(handle: string, contactsMap: Map<string, string>): string | null {
  if (contactsMap.has(handle)) return contactsMap.get(handle)!
  // Normalized digit-only comparison for phone numbers with different formatting
  const digits = handle.replace(/\D/g, '')
  if (digits.length < 7) return null
  for (const [key, name] of contactsMap) {
    if (key.replace(/\D/g, '') === digits) return name
  }
  return null
}

/**
 * Resolve a phone number or email handle to a display name.
 * Uses AddressBook sqlite directly (needs Full Disk Access).
 * Pass dbPath explicitly to skip the Contacts fallback (used in tests).
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
 * Strategy: AddressBook sqlite (Full Disk Access) → Swift Contacts framework → raw handles.
 */
export function buildContactMap(handles: ReadonlyArray<string>, dbPath?: string): Map<string, string> {
  const resolvedPath = dbPath ?? findAddressBookDb()

  // Path A: AddressBook sqlite (fast, needs Full Disk Access)
  if (resolvedPath) {
    const map = new Map<string, string>()
    for (const h of handles) map.set(h, resolveContactName(h, resolvedPath))
    return map
  }

  // Path B: Swift Contacts framework (one call for all handles, no Full Disk Access needed)
  if (dbPath === undefined) {
    const contactsMap = loadContactsViaSwift()
    if (contactsMap) {
      const map = new Map<string, string>()
      for (const h of handles) map.set(h, matchHandle(h, contactsMap) ?? h)
      return map
    }
  }

  // Path C: fall back to raw handles
  process.stderr.write('khipuchat: contacts not accessible — using raw handles as names\n')
  const map = new Map<string, string>()
  for (const h of handles) map.set(h, h)
  return map
}
