import { createHash } from 'node:crypto'
import { isIPv4 } from 'node:net'

// Pure parser for the remote MCP endpoint settings. The env is injected and the
// known tool names are passed in, so this module reads no global state.
// Tokens are reduced to SHA-256 digests immediately; no error carries a token.
// MCP_SECRET (stdio only) is never read here (Req 2.7).

export interface RemoteMcpClient {
  readonly name: string
  readonly setting: string
  readonly tokenDigest: Buffer
  readonly tools: ReadonlySet<string>
  readonly allowlisted: boolean
}

export interface RemoteMcpConfig {
  readonly host: string
  readonly port: number
  readonly clients: readonly RemoteMcpClient[]
  readonly allowedOrigins: ReadonlySet<string>
}

export type RemoteMcpConfigError =
  | { readonly kind: 'no-clients' }
  | { readonly kind: 'invalid-client-name'; readonly setting: string }
  | { readonly kind: 'unresolved-secret-file'; readonly setting: string }
  | { readonly kind: 'token-too-short'; readonly setting: string }
  | { readonly kind: 'duplicate-token'; readonly settings: readonly [string, string] }
  | { readonly kind: 'empty-allowlist'; readonly setting: string }
  | { readonly kind: 'unknown-tool'; readonly setting: string; readonly tool: string }
  | { readonly kind: 'allowlist-without-token'; readonly setting: string }
  | { readonly kind: 'invalid-port'; readonly value: string }

export type RemoteMcpConfigResult =
  | { readonly ok: true; readonly config: RemoteMcpConfig }
  | { readonly ok: false; readonly error: RemoteMcpConfigError }

const TOKEN_PREFIX = 'MCP_TOKEN_'
const TOOLS_PREFIX = 'MCP_TOOLS_'
const FILE_SUFFIX = '_FILE'
const CLIENT_SUFFIX = /^[A-Z0-9_]{1,32}$/
const MIN_TOKEN_LENGTH = 32
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3335

const fail = (error: RemoteMcpConfigError): RemoteMcpConfigResult => ({ ok: false, error })
const present = (value: string | undefined): value is string => value !== undefined && value !== ''

interface TokenEntry {
  readonly setting: string
  readonly suffix: string
  readonly token: string
}

export function parseRemoteMcpConfig(
  env: NodeJS.ProcessEnv,
  knownTools: readonly string[],
): RemoteMcpConfigResult {
  const keys = Object.keys(env).sort()
  const tokenKeys = keys.filter((k) => k.startsWith(TOKEN_PREFIX) && present(env[k]))
  if (tokenKeys.length === 0) return fail({ kind: 'no-clients' })

  const entries: TokenEntry[] = []
  for (const setting of tokenKeys) {
    if (setting.endsWith(FILE_SUFFIX)) continue
    const suffix = setting.slice(TOKEN_PREFIX.length)
    if (!CLIENT_SUFFIX.test(suffix)) return fail({ kind: 'invalid-client-name', setting })
    entries.push({ setting, suffix, token: env[setting] as string })
  }

  for (const setting of tokenKeys) {
    if (!setting.endsWith(FILE_SUFFIX)) continue
    if (!present(env[setting.slice(0, -FILE_SUFFIX.length)])) {
      return fail({ kind: 'unresolved-secret-file', setting })
    }
  }

  for (const entry of entries) {
    if (entry.token.length < MIN_TOKEN_LENGTH) return fail({ kind: 'token-too-short', setting: entry.setting })
  }

  const digests = entries.map((e) => createHash('sha256').update(e.token, 'utf8').digest())
  const seen = new Map<string, string>()
  for (const [i, entry] of entries.entries()) {
    const hex = digests[i].toString('hex')
    const first = seen.get(hex)
    if (first !== undefined) return fail({ kind: 'duplicate-token', settings: [first, entry.setting] })
    seen.set(hex, entry.setting)
  }

  const allowlists = parseAllowlists(env, keys)
  const allowlistError = validateAllowlists(allowlists, knownTools, new Set(entries.map((e) => e.suffix)))
  if (allowlistError) return fail(allowlistError)

  const host = env.MCP_HTTP_HOST?.trim() || DEFAULT_HOST
  const portRaw = env.MCP_HTTP_PORT
  let port = DEFAULT_PORT
  if (portRaw !== undefined && portRaw.trim() !== '') {
    const trimmed = portRaw.trim()
    port = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail({ kind: 'invalid-port', value: portRaw })
  }

  const clients: RemoteMcpClient[] = entries.map((entry, i) => {
    const list = allowlists.get(entry.suffix)
    return {
      name: entry.suffix.toLowerCase(),
      setting: entry.setting,
      tokenDigest: digests[i],
      tools: new Set(list ? list.tools : knownTools),
      allowlisted: list !== undefined,
    }
  })

  return { ok: true, config: { host, port, clients, allowedOrigins: parseOrigins(env.MCP_ALLOWED_ORIGINS) } }
}

interface Allowlist {
  readonly setting: string
  readonly tools: readonly string[]
}

function parseAllowlists(env: NodeJS.ProcessEnv, keys: readonly string[]): Map<string, Allowlist> {
  const result = new Map<string, Allowlist>()
  for (const setting of keys) {
    const value = env[setting]
    if (!setting.startsWith(TOOLS_PREFIX) || value === undefined) continue
    result.set(setting.slice(TOOLS_PREFIX.length), { setting, tools: value.split(',').map((t) => t.trim()) })
  }
  return result
}

function validateAllowlists(
  allowlists: ReadonlyMap<string, Allowlist>,
  knownTools: readonly string[],
  clientSuffixes: ReadonlySet<string>,
): RemoteMcpConfigError | undefined {
  const lists = [...allowlists.values()]
  for (const { setting, tools } of lists) {
    if (tools.every((t) => t === '')) return { kind: 'empty-allowlist', setting }
  }
  const known = new Set(knownTools)
  for (const { setting, tools } of lists) {
    const unknown = tools.find((t) => !known.has(t))
    if (unknown !== undefined) return { kind: 'unknown-tool', setting, tool: unknown }
  }
  for (const [suffix, { setting }] of allowlists) {
    if (!clientSuffixes.has(suffix)) return { kind: 'allowlist-without-token', setting }
  }
  return undefined
}

function parseOrigins(raw: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const part of (raw ?? '').split(',')) {
    const normalized = part.trim().toLowerCase().replace(/\/+$/, '')
    if (normalized !== '') origins.add(normalized)
  }
  return origins
}

export function formatConfigError(error: RemoteMcpConfigError): string {
  switch (error.kind) {
    case 'no-clients':
      return 'Remote MCP: at least one MCP_TOKEN_<CLIENT> setting is required.'
    case 'invalid-client-name':
      return `Remote MCP: ${error.setting} is not a valid client setting; <CLIENT> must be 1 to 32 uppercase letters, digits, or underscores.`
    case 'unresolved-secret-file':
      return `Remote MCP: ${error.setting} is set but its token was not loaded; start through the khipu CLI so secret files are resolved.`
    case 'token-too-short':
      return `Remote MCP: ${error.setting} must be at least ${MIN_TOKEN_LENGTH} characters long.`
    case 'duplicate-token':
      return `Remote MCP: ${error.settings[0]} and ${error.settings[1]} have the same token; each client needs its own token.`
    case 'empty-allowlist':
      return `Remote MCP: ${error.setting} is set but lists no tools.`
    case 'unknown-tool':
      return `Remote MCP: ${error.setting} names unknown tool ${JSON.stringify(error.tool)}.`
    case 'allowlist-without-token':
      return `Remote MCP: ${error.setting} has no matching MCP_TOKEN_ setting.`
    case 'invalid-port':
      return `Remote MCP: MCP_HTTP_PORT must be an integer from 1 to 65535 (got ${JSON.stringify(error.value)}).`
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (h === 'localhost' || h === '::1') return true
  const v4 = h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h
  return isIPv4(v4) && v4.startsWith('127.')
}
