import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config()

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Config {
  apiId: number
  apiHash: string
  phoneNumber: string
  sessionString: string
}

// ── Load ──────────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

// Loaded without throwing: a `khipu sync telegram --account <name>` run is
// fully credentialed by the account registry and must not crash at import
// time just because the legacy global env vars happen to be unset.
export const config: Config = {
  apiId: parseInt(process.env['TELEGRAM_API_ID'] ?? '', 10),
  apiHash: process.env['TELEGRAM_API_HASH'] ?? '',
  phoneNumber: process.env['TELEGRAM_PHONE_NUMBER'] ?? '',
  sessionString: process.env['TELEGRAM_SESSION_STRING'] ?? '',
}

/**
 * Validates the legacy global Telegram env vars are present. Call this only
 * from the no-`--account` legacy sync path, which genuinely requires them —
 * the per-account registry path supplies its own credentials per account.
 */
export function assertLegacyConfig(): void {
  requireEnv('TELEGRAM_API_ID')
  requireEnv('TELEGRAM_API_HASH')
  requireEnv('TELEGRAM_PHONE_NUMBER')
}

// ── Media directory ───────────────────────────────────────────────────────────

export const mediaDir: string = process.env['MEDIA_DIR'] ?? path.resolve(process.cwd(), 'media')

// ── Write-back ────────────────────────────────────────────────────────────────

const ENV_PATH = path.resolve(process.cwd(), '.env')

export function saveSessionString(value: string, envPath: string = ENV_PATH): void {
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const updated = raw.match(/^TELEGRAM_SESSION_STRING=/m)
    ? raw.replace(/^TELEGRAM_SESSION_STRING=.*/m, `TELEGRAM_SESSION_STRING=${value}`)
    : raw + `\nTELEGRAM_SESSION_STRING=${value}\n`
  fs.writeFileSync(envPath, updated, 'utf8')
  config.sessionString = value
}
