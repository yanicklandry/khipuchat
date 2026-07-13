import * as fs from 'fs'
import type { Platform } from './platforms/types'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AccountCredentials {
  readonly name: string
  readonly fields: Readonly<Record<string, string>>
}

export type RegistryError =
  | { kind: 'missing_env'; account: string; platform: Platform; variable: string }
  | { kind: 'duplicate_name'; platform: Platform; name: string }
  | { kind: 'empty_name'; platform: Platform }
  | { kind: 'wechat_multi_account' }

export interface AccountRegistry {
  listAccounts(platform: Platform): readonly string[]
  credentialsFor(platform: Platform, account: string): AccountCredentials
}

// ── Legacy env-var mappings per platform ──────────────────────────────────────

/** Platforms that rely purely on the local system (no env vars needed). */
const LOCAL_ONLY_PLATFORMS: ReadonlySet<Platform> = new Set([
  'imessage',
  'whatsapp',
  'wechat',
])

/** Env vars each platform reads from in a legacy (no config file) install. */
const LEGACY_ENV_VARS: Partial<Record<Platform, readonly string[]>> = {
  telegram: ['TG_API_ID', 'TG_API_HASH', 'TG_PHONE'],
  discord: ['DISCORD_TOKEN'],
  slack: ['SLACK_USER_TOKEN'],
  email: ['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS'],
}

// ── $VAR resolution ───────────────────────────────────────────────────────────

function resolveField(
  value: string,
  fieldKey: string,
  accountName: string,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (!value.startsWith('$')) return value
  const varName = value.slice(1)
  const resolved = env[varName]
  if (resolved === undefined || resolved === '') {
    const err: RegistryError = {
      kind: 'missing_env',
      account: accountName,
      platform,
      variable: varName,
    }
    throw Object.assign(
      new Error(`Missing env var "${varName}" for account "${accountName}" on platform "${platform}" (field "${fieldKey}")`),
      err,
    )
  }
  return resolved
}

// ── Config shape (JSON) ───────────────────────────────────────────────────────

type RawAccountEntry = Record<string, string>
type RawConfig = Partial<Record<Platform, RawAccountEntry[]>>

// ── Legacy fallback builder ───────────────────────────────────────────────────

function buildLegacyAccounts(
  env: NodeJS.ProcessEnv,
): Map<Platform, AccountCredentials[]> {
  const map = new Map<Platform, AccountCredentials[]>()

  // Local-only platforms always get a 'default' account (no env needed)
  for (const platform of LOCAL_ONLY_PLATFORMS) {
    map.set(platform, [{ name: 'default', fields: {} }])
  }

  // Env-var platforms: only synthesize if at least one var is set
  for (const [platform, vars] of Object.entries(LEGACY_ENV_VARS) as [Platform, readonly string[]][]) {
    const fields: Record<string, string> = {}
    let anySet = false
    for (const v of vars) {
      const val = env[v]
      if (val) {
        fields[v] = val
        anySet = true
      }
    }
    if (anySet) {
      map.set(platform, [{ name: 'default', fields }])
    }
  }

  return map
}

// ── Config-file builder ───────────────────────────────────────────────────────

function buildConfigAccounts(
  raw: RawConfig,
  env: NodeJS.ProcessEnv,
): Map<Platform, AccountCredentials[]> {
  const map = new Map<Platform, AccountCredentials[]>()

  for (const [platformKey, entries] of Object.entries(raw)) {
    const platform = platformKey as Platform
    if (!Array.isArray(entries) || entries.length === 0) continue

    const seenNames = new Set<string>()
    const accounts: AccountCredentials[] = []

    for (const entry of entries) {
      const { name, ...rest } = entry as RawAccountEntry & { name?: string }

      if (!name) {
        const err: RegistryError = { kind: 'empty_name', platform }
        throw Object.assign(new Error(`Empty account name on platform "${platform}"`), err)
      }

      if (seenNames.has(name)) {
        const err: RegistryError = { kind: 'duplicate_name', platform, name }
        throw Object.assign(new Error(`Duplicate account name "${name}" on platform "${platform}"`), err)
      }
      seenNames.add(name)

      const fields: Record<string, string> = {}
      for (const [k, v] of Object.entries(rest)) {
        fields[k] = resolveField(String(v), k, name, platform, env)
      }

      accounts.push({ name, fields })
    }

    if (platform === 'wechat' && accounts.length > 1) {
      const err: RegistryError = { kind: 'wechat_multi_account' }
      throw Object.assign(new Error('WeChat does not support multiple accounts'), err)
    }

    map.set(platform, accounts)
  }

  return map
}

// ── loadRegistry ──────────────────────────────────────────────────────────────

export function loadRegistry(
  configPath: string = 'khipu.config.json',
  env: NodeJS.ProcessEnv = process.env,
): AccountRegistry {
  let accountMap: Map<Platform, AccountCredentials[]>

  let raw: RawConfig | null = null
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf8')
    raw = JSON.parse(text) as RawConfig
  }

  if (raw && Object.keys(raw).length > 0) {
    accountMap = buildConfigAccounts(raw, env)
  } else {
    accountMap = buildLegacyAccounts(env)
  }

  return {
    listAccounts(platform: Platform): readonly string[] {
      return (accountMap.get(platform) ?? []).map((a) => a.name)
    },

    credentialsFor(platform: Platform, account: string): AccountCredentials {
      const accounts = accountMap.get(platform)
      if (!accounts) {
        throw new Error(`No accounts configured for platform "${platform}"`)
      }
      const found = accounts.find((a) => a.name === account)
      if (!found) {
        throw new Error(`Account "${account}" not found for platform "${platform}"`)
      }
      return found
    },
  }
}
