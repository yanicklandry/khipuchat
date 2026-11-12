// Account <=> Zalo uid bindings, learned on the first successful import so later
// runs can refuse to import one Zalo login into another archive account (5.4).
// Stored as { [account]: zaloUid } in a local, gitignored JSON file. A uid is an
// identifier, not a secret (8.2); the file is still written owner-only.
import { readFileSync, writeFileSync, renameSync } from 'fs'
import path from 'path'
import type { ImportError, Result } from './types'

export const DEFAULT_UID_STORE_PATH = path.join(process.cwd(), '.zalo_uids.json')

export interface UidStore {
  /** configuredUid is the account's optional ZALO_UID field; it wins over the file. */
  checkBinding(account: string, ownUid: string, configuredUid: string | null): Result<{ firstRun: boolean }>
  bind(account: string, ownUid: string): Result<true>
}

type Bindings = Record<string, string>

function isBindings(v: unknown): v is Bindings {
  return typeof v === 'object' && v !== null && !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((u) => typeof u === 'string' && u.length > 0)
}

export function createUidStore(filePath: string = DEFAULT_UID_STORE_PATH): UidStore {
  const invalid: { ok: false; error: ImportError } = { ok: false, error: { kind: 'uid_store_invalid', step: 'account', path: filePath } }

  /** A missing file is empty; anything unreadable or malformed is invalid (never silently dropped). */
  function load(): Bindings | null {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      return isBindings(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  const mismatch = (expectedUid: string | null, actualUid: string, boundAccount?: string): { ok: false; error: ImportError } => ({
    ok: false,
    error: { kind: 'account_mismatch', step: 'account', expectedUid, actualUid, ...(boundAccount ? { boundAccount } : {}) },
  })

  return {
    checkBinding(account, ownUid, configuredUid) {
      if (configuredUid) return configuredUid === ownUid ? { ok: true, value: { firstRun: false } } : mismatch(configuredUid, ownUid)
      const bindings = load()
      if (!bindings) return invalid
      const bound = bindings[account]
      if (bound) return bound === ownUid ? { ok: true, value: { firstRun: false } } : mismatch(bound, ownUid)
      const other = Object.keys(bindings).find((a) => bindings[a] === ownUid)
      if (other) return mismatch(null, ownUid, other)
      return { ok: true, value: { firstRun: true } }
    },
    bind(account, ownUid) {
      const bindings = load()
      if (!bindings) return invalid
      const tmp = `${filePath}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ ...bindings, [account]: ownUid }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, filePath)
      return { ok: true, value: true }
    },
  }
}
