import { describe, it, expect, expectTypeOf, vi } from 'vitest'
import {
  formatAuditLine,
  createStderrAudit,
  type AuditEvent,
  type AuthFailureReason,
} from '../src/remote-mcp/audit'

const NOW = new Date('2026-11-13T08:09:10.123Z')
const TS = 'ts=2026-11-13T08:09:10.123Z'

describe('formatAuditLine: exact line shapes (6.1, 6.3, 3.5)', () => {
  it('formats a tools/call line with client, tool, outcome and ms (6.1)', () => {
    const line = formatAuditLine(
      { op: 'tools/call', client: 'muse', tool: 'search_messages', outcome: 'ok', ms: 12 },
      NOW,
    )
    expect(line).toBe(`[remote-mcp] ${TS} client=muse op=tools/call tool=search_messages outcome=ok ms=12`)
  })

  it('covers the error and denied outcomes and rounds ms to whole milliseconds (6.1)', () => {
    expect(formatAuditLine({ op: 'tools/call', client: 'muse', tool: 'get_image', outcome: 'denied', ms: 0.4 }, NOW))
      .toBe(`[remote-mcp] ${TS} client=muse op=tools/call tool=get_image outcome=denied ms=0`)
    expect(formatAuditLine({ op: 'tools/call', client: 'muse', tool: 'list_chats', outcome: 'error', ms: 7.6 }, NOW))
      .toBe(`[remote-mcp] ${TS} client=muse op=tools/call tool=list_chats outcome=error ms=8`)
  })

  it('formats initialize and tools/list with only client and op (6.3)', () => {
    expect(formatAuditLine({ op: 'initialize', client: 'muse' }, NOW))
      .toBe(`[remote-mcp] ${TS} client=muse op=initialize`)
    expect(formatAuditLine({ op: 'tools/list', client: 'claude' }, NOW))
      .toBe(`[remote-mcp] ${TS} client=claude op=tools/list`)
  })

  it('formats a tool-error line with the error message (5.4, 6.1)', () => {
    expect(formatAuditLine({ op: 'tool-error', client: 'muse', tool: 'list_chats', message: 'boom' }, NOW))
      .toBe(`[remote-mcp] ${TS} client=muse op=tool-error tool=list_chats error=boom`)
  })

  it('formats an auth-failed line with reason, method, path and addr (3.5)', () => {
    expect(formatAuditLine(
      { op: 'auth-failed', reason: 'unknown-token', method: 'POST', path: '/mcp', addr: '100.64.0.3' },
      NOW,
    )).toBe(`[remote-mcp] ${TS} op=auth-failed reason=unknown-token method=POST path=/mcp addr=100.64.0.3`)
  })

  it('formats every auth-failure reason category (3.5)', () => {
    const reasons: AuthFailureReason[] = ['origin', 'missing', 'malformed', 'unknown-token', 'query-token']
    for (const reason of reasons) {
      expect(formatAuditLine({ op: 'auth-failed', reason, method: 'GET', path: '/x', addr: '::1' }, NOW))
        .toBe(`[remote-mcp] ${TS} op=auth-failed reason=${reason} method=GET path=/x addr=::1`)
    }
  })
})

describe('formatAuditLine: no credentials or query strings (3.5, 6.2)', () => {
  it('strips the query string from the auth-failed path so a query token is never logged', () => {
    const line = formatAuditLine(
      { op: 'auth-failed', reason: 'query-token', method: 'POST', path: '/mcp?token=s3cr3t&x=1', addr: '1.2.3.4' },
      NOW,
    )
    expect(line).toBe(`[remote-mcp] ${TS} op=auth-failed reason=query-token method=POST path=/mcp addr=1.2.3.4`)
    expect(line).not.toContain('s3cr3t')
  })

  it('strips a fragment and a bare trailing question mark too', () => {
    expect(formatAuditLine({ op: 'auth-failed', reason: 'missing', method: 'GET', path: '/a#frag', addr: '1.2.3.4' }, NOW))
      .toContain(' path=/a ')
    expect(formatAuditLine({ op: 'auth-failed', reason: 'missing', method: 'GET', path: '/a?', addr: '1.2.3.4' }, NOW))
      .toContain(' path=/a ')
  })

  it('logs only the declared fields even if a caller smuggles extra properties at runtime (6.2)', () => {
    const smuggled = {
      op: 'tools/call', client: 'muse', tool: 'search_messages', outcome: 'ok', ms: 3,
      arguments: { query: 'secret message' }, result: 'private content', token: 'tok_abc',
    } as unknown as AuditEvent
    const line = formatAuditLine(smuggled, NOW)
    expect(line).toBe(`[remote-mcp] ${TS} client=muse op=tools/call tool=search_messages outcome=ok ms=3`)
    expect(line).not.toMatch(/secret message|private content|tok_abc|arguments|result|token/)
  })

  it('has no event shape with a field for arguments, results, or tokens (6.2, type level)', () => {
    type Keys = AuditEvent extends infer E ? (E extends unknown ? keyof E : never) : never
    expectTypeOf<Extract<Keys, 'args' | 'arguments' | 'params' | 'result' | 'results' | 'content' | 'token' | 'authorization'>>()
      .toEqualTypeOf<never>()
    expectTypeOf<Keys>().toEqualTypeOf<'op' | 'client' | 'tool' | 'outcome' | 'ms' | 'message' | 'reason' | 'method' | 'path' | 'addr'>()
    // @ts-expect-error an AuditEvent cannot carry arguments
    const bad: AuditEvent = { op: 'initialize', client: 'muse', arguments: {} }
    expect(bad).toBeDefined()
  })
})

describe('formatAuditLine: value encoding cannot forge lines or fields', () => {
  it('JSON-quotes values containing whitespace, "=" or quotes and escapes newlines', () => {
    const line = formatAuditLine(
      { op: 'tool-error', client: 'muse', tool: 'list_chats', message: 'bad thing\n[remote-mcp] ts=x client=evil op=tools/call outcome=ok' },
      NOW,
    )
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\r')
    expect(line).toBe(
      `[remote-mcp] ${TS} client=muse op=tool-error tool=list_chats error="bad thing\\n[remote-mcp] ts=x client=evil op=tools/call outcome=ok"`,
    )
  })

  it('escapes embedded quotes, carriage returns, and control characters inside quoted values', () => {
    const line = formatAuditLine(
      { op: 'tool-error', client: 'muse', tool: 'x', message: 'say "hi"\r\u0000\u001b[31m' },
      NOW,
    )
    expect(line).toBe(`[remote-mcp] ${TS} client=muse op=tool-error tool=x error="say \\"hi\\"\\r\\u0000\\u001b[31m"`)
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  it('escapes Unicode line and paragraph separators and DEL', () => {
    const line = formatAuditLine({ op: 'tool-error', client: 'muse', tool: 'x', message: 'a\u2028b\u2029c\u007fd' }, NOW)
    expect(line).toBe(`[remote-mcp] ${TS} client=muse op=tool-error tool=x error="a\\u2028b\\u2029c\\u007fd"`)
  })

  it('quotes values with "=" so a field cannot be injected, and quotes empty values', () => {
    expect(formatAuditLine({ op: 'tool-error', client: 'muse', tool: 'x', message: 'a=b' }, NOW))
      .toBe(`[remote-mcp] ${TS} client=muse op=tool-error tool=x error="a=b"`)
    expect(formatAuditLine({ op: 'tool-error', client: 'muse', tool: 'x', message: '' }, NOW))
      .toBe(`[remote-mcp] ${TS} client=muse op=tool-error tool=x error=""`)
  })

  it('applies the same encoding to every field, including path, method and addr', () => {
    const line = formatAuditLine(
      { op: 'auth-failed', reason: 'missing', method: 'GET X', path: '/a b\nop=evil?q=1', addr: 'x y' },
      NOW,
    )
    expect(line).toBe(`[remote-mcp] ${TS} op=auth-failed reason=missing method="GET X" path="/a b\\nop=evil" addr="x y"`)
  })

  it('leaves plain values (letters, digits, . _ - / : @ +) bare', () => {
    expect(formatAuditLine({ op: 'auth-failed', reason: 'origin', method: 'POST', path: '/v1/mcp-x_y.z', addr: '::ffff:10.0.0.1' }, NOW))
      .toBe(`[remote-mcp] ${TS} op=auth-failed reason=origin method=POST path=/v1/mcp-x_y.z addr=::ffff:10.0.0.1`)
  })
})

describe('createStderrAudit', () => {
  it('writes one formatted line per event to an injected sink', () => {
    const lines: string[] = []
    const audit = createStderrAudit((l) => lines.push(l))
    audit.record({ op: 'initialize', client: 'muse' })
    audit.record({ op: 'tools/call', client: 'muse', tool: 'list_chats', outcome: 'ok', ms: 5 })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[remote-mcp\] ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z client=muse op=initialize$/)
    expect(lines[1]).toMatch(/ client=muse op=tools\/call tool=list_chats outcome=ok ms=5$/)
  })

  it('defaults to process.stderr with a trailing newline', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      createStderrAudit().record({ op: 'tools/list', client: 'muse' })
      expect(spy).toHaveBeenCalledTimes(1)
      const written = String(spy.mock.calls[0][0])
      expect(written).toMatch(/^\[remote-mcp\] ts=\S+ client=muse op=tools\/list\n$/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('formatAuditLine: C1 controls and bidi overrides', () => {
  it('escapes NEL and RLO inside quoted values', () => {
    const line = formatAuditLine(
      { op: 'tool-error', client: 'muse', tool: 'list_chats', message: 'a\u0085b‮c' },
      new Date('2026-11-13T00:00:00.000Z'),
    )
    expect(line).toContain('"a\\u0085b\\u202ec"')
    expect(line).not.toMatch(/[\u0085‮]/)
  })
})
