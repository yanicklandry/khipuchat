/**
 * Zalo session persistence: read/write the local credential file (cookie + imei +
 * userAgent) so later syncs reconnect without a new QR scan. Credentials are
 * stored only on the local machine and are never transmitted anywhere except Zalo.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface SavedSession {
  imei: string
  cookie: unknown
  userAgent: string
}

export const DEFAULT_SESSION_PATH = path.join(process.cwd(), '.zalo_session.json')

/** Resolve the session file location: explicit path when non-empty, else the default. */
export function resolveSessionPath(sessionPath?: string): string {
  return sessionPath && sessionPath.length > 0 ? sessionPath : DEFAULT_SESSION_PATH
}

/** Read a saved session, or null when absent/unreadable/malformed. */
export function readSession(p: string): SavedSession | null {
  try {
    if (!fs.existsSync(p)) return null
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<SavedSession>
    if (raw && typeof raw.imei === 'string' && typeof raw.userAgent === 'string' && raw.cookie != null) {
      return { imei: raw.imei, cookie: raw.cookie, userAgent: raw.userAgent }
    }
  } catch {
    /* fall through to null */
  }
  return null
}

/** Persist a session to a local, owner-only-readable file. */
export function writeSession(p: string, s: SavedSession): void {
  fs.writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 })
}
