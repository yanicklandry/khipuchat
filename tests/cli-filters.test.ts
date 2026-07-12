import { describe, it, expect } from 'vitest'
import { parseQueryFilters, parseDateArg } from '../src/cli-filters'

describe('parseDateArg', () => {
  it('converts YYYY-MM-DD to unix seconds', () => {
    expect(parseDateArg('2025-01-01')).toBe(1735689600)
  })

  it('converts full ISO date-time to unix seconds', () => {
    expect(parseDateArg('2025-01-01T00:00:00Z')).toBe(1735689600)
  })

  it('returns undefined for invalid date string', () => {
    expect(parseDateArg('invalid')).toBeUndefined()
  })

  it('returns undefined for ambiguous US-style date format', () => {
    expect(parseDateArg('01/01/2025')).toBeUndefined()
  })

  it('returns undefined for natural language dates', () => {
    expect(parseDateArg('yesterday')).toBeUndefined()
  })
})

describe('parseQueryFilters', () => {
  it('returns ok:true with empty filters and same rest when no flags', () => {
    const result = parseQueryFilters(['hello', 'world'])
    expect(result).toEqual({ ok: true, filters: {}, rest: ['hello', 'world'] })
  })

  it('parses --platform and strips it from rest', () => {
    const result = parseQueryFilters(['--platform', 'telegram', 'myquery'])
    expect(result).toEqual({ ok: true, filters: { platform: 'telegram' }, rest: ['myquery'] })
  })

  it('parses --account and strips it from rest', () => {
    const result = parseQueryFilters(['--account', 'john', 'myquery'])
    expect(result).toEqual({ ok: true, filters: { account: 'john' }, rest: ['myquery'] })
  })

  it('parses --limit and strips it from rest', () => {
    const result = parseQueryFilters(['--limit', '10', 'myquery'])
    expect(result).toEqual({ ok: true, filters: { limit: 10 }, rest: ['myquery'] })
  })

  it('parses --since and strips it from rest', () => {
    const result = parseQueryFilters(['--since', '2025-01-01', 'myquery'])
    expect(result).toEqual({ ok: true, filters: { since: 1735689600 }, rest: ['myquery'] })
  })

  it('parses --until and strips it from rest', () => {
    const result = parseQueryFilters(['--until', '2025-01-01', 'myquery'])
    expect(result).toEqual({ ok: true, filters: { until: 1735689600 }, rest: ['myquery'] })
  })

  it('parses --type and strips it from rest', () => {
    const result = parseQueryFilters(['--type', 'dm', 'myquery'])
    expect(result).toEqual({ ok: true, filters: { type: 'dm' }, rest: ['myquery'] })
  })

  it('parses multiple flags together', () => {
    const result = parseQueryFilters(['--platform', 'telegram', '--limit', '5', 'myquery'])
    expect(result).toEqual({
      ok: true,
      filters: { platform: 'telegram', limit: 5 },
      rest: ['myquery'],
    })
  })

  it('returns ok:false for invalid platform', () => {
    const result = parseQueryFilters(['--platform', 'myspace'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/platform/i)
    }
  })

  it('returns ok:false for non-numeric --limit', () => {
    const result = parseQueryFilters(['--limit', 'abc'])
    expect(result.ok).toBe(false)
  })

  it('returns ok:false for zero --limit', () => {
    const result = parseQueryFilters(['--limit', '0'])
    expect(result.ok).toBe(false)
  })

  it('returns ok:false for negative --limit', () => {
    const result = parseQueryFilters(['--limit', '-5'])
    expect(result.ok).toBe(false)
  })

  it('returns ok:false for unparseable --since date', () => {
    const result = parseQueryFilters(['--since', 'yesterday'])
    expect(result.ok).toBe(false)
  })

  it('returns ok:false for unparseable --until date', () => {
    const result = parseQueryFilters(['--until', 'invalid'])
    expect(result.ok).toBe(false)
  })

  it('accepts all valid platform values', () => {
    const platforms = ['telegram', 'imessage', 'discord', 'slack', 'whatsapp', 'wechat', 'email']
    for (const platform of platforms) {
      const result = parseQueryFilters(['--platform', platform])
      expect(result.ok).toBe(true)
    }
  })

  it('does not mutate the input array', () => {
    const input = ['--platform', 'telegram', 'query'] as const
    parseQueryFilters(input)
    expect(input).toEqual(['--platform', 'telegram', 'query'])
  })
})
