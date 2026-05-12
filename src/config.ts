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

export const config: Config = {
  apiId: parseInt(requireEnv('TELEGRAM_API_ID'), 10),
  apiHash: requireEnv('TELEGRAM_API_HASH'),
  phoneNumber: requireEnv('TELEGRAM_PHONE_NUMBER'),
  sessionString: process.env['TELEGRAM_SESSION_STRING'] ?? '',
}

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
