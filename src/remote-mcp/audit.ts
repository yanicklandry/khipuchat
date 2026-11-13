// Audit lines for the remote MCP endpoint (Req 3.5, 6.1, 6.2, 6.3).
// One line per event, prefixed `[remote-mcp]`, ISO timestamp, then key=value fields.
// AuditEvent deliberately has no field for tool arguments, results, message
// content, or tokens, so none of them can be logged (6.2 enforced by type), and
// the formatter only reads the declared fields of each event shape.
//
// Value encoding: a value made only of [A-Za-z0-9._-/:@+] is written bare.
// Anything else (whitespace, '=', quotes, control characters, empty string,
// non-ASCII) is written as a JSON string literal, which escapes quotes,
// backslashes, CR, LF, and all other control characters; U+2028, U+2029 and
// DEL are escaped as well. A value therefore never contains a raw line break and
// cannot start a new field or a new line, so a hostile error message or path
// cannot forge audit entries.

export type AuditOutcome = 'ok' | 'error' | 'denied'

/** Auth-failure reason categories; owned here, imported by the auth module. */
export type AuthFailureReason = 'origin' | 'missing' | 'malformed' | 'unknown-token' | 'query-token'

export type AuditEvent =
  | { readonly op: 'initialize' | 'tools/list'; readonly client: string }
  | {
      readonly op: 'tools/call'
      readonly client: string
      readonly tool: string
      readonly outcome: AuditOutcome
      readonly ms: number
    }
  | { readonly op: 'tool-error'; readonly client: string; readonly tool: string; readonly message: string }
  | {
      readonly op: 'auth-failed'
      readonly reason: AuthFailureReason
      readonly method: string
      readonly path: string
      readonly addr: string
    }

export interface RemoteMcpAudit {
  record(event: AuditEvent): void
}

const PREFIX = '[remote-mcp]'
const BARE_VALUE = /^[A-Za-z0-9._\-/:@+]+$/

function encodeValue(value: string): string {
  if (BARE_VALUE.test(value)) return value
  return JSON.stringify(value).replace(/[\x7f-\x9f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Path without query string or fragment, so a query-string token is never logged. */
function stripQuery(path: string): string {
  const cut = path.search(/[?#]/)
  return cut === -1 ? path : path.slice(0, cut)
}

function wholeMs(ms: number): string {
  return Number.isFinite(ms) ? String(Math.max(0, Math.round(ms))) : '0'
}

function fields(event: AuditEvent): ReadonlyArray<readonly [string, string]> {
  switch (event.op) {
    case 'initialize':
    case 'tools/list':
      return [['client', event.client], ['op', event.op]]
    case 'tools/call':
      return [
        ['client', event.client],
        ['op', event.op],
        ['tool', event.tool],
        ['outcome', event.outcome],
        ['ms', wholeMs(event.ms)],
      ]
    case 'tool-error':
      return [['client', event.client], ['op', event.op], ['tool', event.tool], ['error', event.message]]
    case 'auth-failed':
      return [
        ['op', event.op],
        ['reason', event.reason],
        ['method', event.method],
        ['path', stripQuery(event.path)],
        ['addr', event.addr],
      ]
  }
}

export function formatAuditLine(event: AuditEvent, now: Date): string {
  const parts = [`ts=${now.toISOString()}`, ...fields(event).map(([k, v]) => `${k}=${encodeValue(v)}`)]
  return `${PREFIX} ${parts.join(' ')}`
}

export function createStderrAudit(
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`)
  },
): RemoteMcpAudit {
  return {
    record(event) {
      write(formatAuditLine(event, new Date()))
    },
  }
}
