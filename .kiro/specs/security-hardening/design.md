# Design Document — security-hardening

## Overview

Four additive, independently toggleable layers. Each layer is opt-in via a single env var; absent var = current behaviour unchanged. `better-sqlite3-multiple-ciphers` is a drop-in replacement for `better-sqlite3` (same API) that adds SQLCipher support. `express-basic-auth` is a minimal Express middleware. The MCP bearer check is three lines in `src/mcp.ts`. The localhost test asserts a fact already guaranteed by `web-ui` spec.

### Non-Goals
- TLS/HTTPS, multi-user, audit logging.

## Boundary Commitments

### This Spec Owns
- `initDb` cipher key support in `src/db.ts`.
- Basic-auth middleware in `src/web/routes.ts`.
- Bearer token check in `src/mcp.ts`.
- Localhost-binding test in `tests/web.test.ts`.
- `better-sqlite3-multiple-ciphers` replacing `better-sqlite3`; `express-basic-auth` new dep.

### Out of Boundary
- Any new web UI features.
- MCP tool signature changes (only error path added).
- Any platform sync adapter changes.

### Allowed Dependencies
- `better-sqlite3-multiple-ciphers` (replaces `better-sqlite3`); `express-basic-auth`.

### Revalidation Triggers
- Changes to `initDb` signature; changes to MCP request handling in `src/mcp.ts`.

## File Structure Plan

```
No new files.
```

**Modified**:
- `src/db.ts` — `initDb`: conditionally apply `PRAGMA key` when `DB_KEY` set; swap import to `better-sqlite3-multiple-ciphers`.
- `src/web/routes.ts` — mount `expressBasicAuth` middleware when `WEB_USER` + `WEB_PASS` set.
- `src/mcp.ts` — add bearer check in `CallToolRequestSchema` handler when `MCP_SECRET` set.
- `package.json` — replace `better-sqlite3` with `better-sqlite3-multiple-ciphers`; add `express-basic-auth`.
- `tests/web.test.ts` — add localhost-binding assertion.
- `tests/security.test.ts` — new: tests for all four layers.

## Components and Interfaces

### DB Encryption (`src/db.ts`)

```typescript
// initDb change (conceptual):
// const db = new Database(path)
// if (process.env.DB_KEY) { db.pragma(`key="${process.env.DB_KEY.replace(/"/g, '')}"`)) }
// Note: better-sqlite3-multiple-ciphers accepts PRAGMA key or constructor option
```

- `:memory:` paths skip key application (SQLCipher doesn't apply to in-memory DBs).
- Wrong key → SQLite throws `SQLITE_NOTADB`; surface as: "DB_KEY is set but the database could not be opened — key may be incorrect."

### Web Auth (`src/web/routes.ts`)

```typescript
// Added at top of router:
if (process.env.WEB_USER && process.env.WEB_PASS) {
  router.use(expressBasicAuth({
    users: { [process.env.WEB_USER]: process.env.WEB_PASS },
    challenge: true,
  }))
}
// GET / is NOT on the router; it's mounted on the app in server.ts — unaffected.
```

### MCP Bearer (`src/mcp.ts`)

```typescript
// In CallToolRequestSchema handler, before dispatching:
const secret = process.env.MCP_SECRET
if (secret) {
  const auth = request.params?._meta?.authorization as string | undefined
  if (auth !== `Bearer ${secret}`) {
    return { error: { code: -32001, message: 'Unauthorized' } }
  }
}
```

## Requirements Traceability

| Requirement | Modified File |
|-------------|--------------|
| 1.1–1.4 | src/db.ts |
| 2.1–2.3 | src/web/routes.ts |
| 3.1–3.2 | src/mcp.ts |
| 4.1 | tests/web.test.ts |

## Testing Strategy

- **DB encryption**: `initDb('test.db')` with `DB_KEY` set → file is encrypted (open without key fails); without `DB_KEY` → opens normally. `:memory:` works in both cases.
- **Web auth**: supertest `GET /api/chats` with no credentials returns 401; with correct Basic auth returns 200; `GET /` always 200.
- **MCP bearer**: mock MCP request with correct token → dispatched; with wrong/missing token → `Unauthorized` error.
- **Localhost binding**: `server.address().address === '127.0.0.1'`.
