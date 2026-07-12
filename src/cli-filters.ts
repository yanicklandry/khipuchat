import { type QueryFilters } from './query-handlers'
import { PLATFORMS } from './sync-all'
import type { Platform } from './platforms/types'

export type FilterParseResult =
  | { ok: true; filters: QueryFilters; rest: string[] }
  | { ok: false; error: string }

/**
 * Parse an ISO date string to unix seconds.
 * Accepts YYYY-MM-DD and full ISO 8601 strings.
 * Rejects ambiguous formats like MM/DD/YYYY.
 * Returns undefined if the string cannot be parsed.
 */
export function parseDateArg(value: string): number | undefined {
  // Only accept YYYY-MM-DD or full ISO 8601 with T separator
  const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T/

  if (!isoDateOnly.test(value) && !isoDateTime.test(value)) {
    return undefined
  }

  const ms = new Date(value).getTime()
  if (isNaN(ms)) return undefined

  return Math.floor(ms / 1000)
}

/**
 * Extract a flag and its value from a mutable argv array using index-based removal.
 * Returns [value, rest] where value is undefined if the flag was not found or had no value.
 */
function extractFlag(args: string[], flag: string): [string | undefined, string[]] {
  const rest = [...args]
  const idx = rest.indexOf(flag)
  if (idx === -1) return [undefined, rest]

  const value = rest[idx + 1]
  if (value !== undefined && !value.startsWith('--')) {
    rest.splice(idx, 2)
    return [value, rest]
  }

  rest.splice(idx, 1)
  return [undefined, rest]
}

/**
 * Parse CLI flags into QueryFilters.
 * Strips each recognized flag and its value from argv, returning the remainder in `rest`.
 * Returns { ok: false, error } if any validation fails.
 */
export function parseQueryFilters(argv: readonly string[]): FilterParseResult {
  let rest = [...argv]
  const filters: QueryFilters = {}

  // --platform
  let platform: string | undefined
  ;[platform, rest] = extractFlag(rest, '--platform')
  if (platform !== undefined) {
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      return {
        ok: false,
        error: `Invalid platform "${platform}". Valid platforms: ${PLATFORMS.join(', ')}`,
      }
    }
    filters.platform = platform as Platform
  }

  // --account
  let account: string | undefined
  ;[account, rest] = extractFlag(rest, '--account')
  if (account !== undefined) {
    filters.account = account
  }

  // --since
  let since: string | undefined
  ;[since, rest] = extractFlag(rest, '--since')
  if (since !== undefined) {
    const parsed = parseDateArg(since)
    if (parsed === undefined) {
      return { ok: false, error: `Invalid --since date "${since}". Use YYYY-MM-DD or full ISO format.` }
    }
    filters.since = parsed
  }

  // --until
  let until: string | undefined
  ;[until, rest] = extractFlag(rest, '--until')
  if (until !== undefined) {
    const parsed = parseDateArg(until)
    if (parsed === undefined) {
      return { ok: false, error: `Invalid --until date "${until}". Use YYYY-MM-DD or full ISO format.` }
    }
    filters.until = parsed
  }

  // --type
  let type: string | undefined
  ;[type, rest] = extractFlag(rest, '--type')
  if (type !== undefined) {
    filters.type = type
  }

  // --limit
  let limitStr: string | undefined
  ;[limitStr, rest] = extractFlag(rest, '--limit')
  if (limitStr !== undefined) {
    const limit = Number(limitStr)
    if (!Number.isInteger(limit) || limit <= 0) {
      return { ok: false, error: `Invalid --limit "${limitStr}". Must be a positive integer.` }
    }
    filters.limit = limit
  }

  return { ok: true, filters, rest }
}
