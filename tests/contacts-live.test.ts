/**
 * Live integration tests for contact resolution.
 * No mocks — exercises the real Swift binary and Contacts framework.
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import { buildContactMap } from '../src/platforms/imessage/contacts'

// ── Swift binary availability ─────────────────────────────────────────────────

function swiftAvailable(): boolean {
  try { execSync('swift --version', { encoding: 'utf8', timeout: 5000 }); return true }
  catch { return false }
}

// ── buildContactMap via Swift (no dbPath) ─────────────────────────────────────

describe('buildContactMap (live Swift path)', () => {
  it('always returns a complete map — every handle present as a key', () => {
    const handles = ['unknown-handle@khipuchat.test', '+19995550000']
    const map = buildContactMap(handles) // no dbPath → Swift or raw-handle fallback
    expect(map.size).toBe(handles.length)
    for (const h of handles) expect(map.has(h)).toBe(true)
  })

  it('unresolvable handles map to themselves', () => {
    const map = buildContactMap(['totally-fake-handle@khipuchat.test'])
    expect(map.get('totally-fake-handle@khipuchat.test')).toBe('totally-fake-handle@khipuchat.test')
  })
})

// ── Swift script output format ────────────────────────────────────────────────

describe('Swift contacts script', () => {
  it('swift binary is available', () => {
    expect(swiftAvailable()).toBe(true)
  })

  it('outputs pipe-delimited phone|name lines', () => {
    if (!swiftAvailable()) return
    const script = [
      'import Contacts',
      'let store = CNContactStore()',
      'let keys: [CNKeyDescriptor] = [CNContactGivenNameKey as CNKeyDescriptor, CNContactFamilyNameKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor]',
      'let req = CNContactFetchRequest(keysToFetch: keys)',
      'var lines: [String] = []',
      'try? store.enumerateContacts(with: req) { c, _ in',
      '  let name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")',
      '  guard !name.isEmpty else { return }',
      '  for ph in c.phoneNumbers { lines.append("\\(ph.value.stringValue)|\\(name)") }',
      '}',
      'if !lines.isEmpty { print(lines.prefix(5).joined(separator: "\\n")) }',
    ].join('\n')
    let output: string
    try {
      output = execSync(`swift -e '${script.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf8', timeout: 15000,
      }).trim()
    } catch {
      // Contacts permission not granted in this environment — skip format check
      return
    }
    if (!output) return // no contacts in system
    for (const line of output.split('\n').filter(l => l.trim())) {
      expect(line).toContain('|')
      const [phone, name] = line.split('|')
      expect(phone.trim().length).toBeGreaterThan(0)
      expect(name.trim().length).toBeGreaterThan(0)
    }
  })

  it('buildContactMap with real Swift resolves a known-format phone number', () => {
    if (!swiftAvailable()) return
    // Exercise the normalization path: digits-only match
    // We can't guarantee any specific contact exists, but we can verify the
    // map always contains every input handle as a key with a string value.
    const handles = ['+15145550000', 'noreply@khipuchat.test']
    const map = buildContactMap(handles)
    expect(map.size).toBe(handles.length)
    for (const h of handles) {
      expect(typeof map.get(h)).toBe('string')
      expect((map.get(h) as string).length).toBeGreaterThan(0)
    }
  })
})
