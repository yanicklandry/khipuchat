# Implementation Plan

- [ ] 1. Replace better-sqlite3 with better-sqlite3-multiple-ciphers
  - Replace `"better-sqlite3"` with `"better-sqlite3-multiple-ciphers"` in `package.json` dependencies; update `@types/better-sqlite3` if version differs
  - Update the import in `src/db.ts` to use `better-sqlite3-multiple-ciphers` (same API)
  - `npm test` passes with no changes (unencrypted path unchanged)
  - _Requirements: 1.2_

- [ ] 2. Implement DB encryption opt-in (parallel with 3, 4)
- [ ] 2.1 (P) Add DB_KEY cipher support to initDb
  - In `src/db.ts` `initDb`: after opening the DB, if `DB_KEY` is set AND the path is not `:memory:`, apply `PRAGMA key` using the env var value
  - If the key is wrong (SQLite throws `SQLITE_NOTADB`): catch and rethrow with "DB_KEY is set but the database could not be opened — key may be incorrect"
  - `:memory:` databases skip key application in all cases
  - Tests using `initDb(':memory:')` pass whether `DB_KEY` is set in environment or not
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Boundary: src/db.ts_

- [ ] 3. (P) Add HTTP Basic Auth to web API routes
  - Install `express-basic-auth` runtime dependency
  - In `src/web/routes.ts`: if both `WEB_USER` and `WEB_PASS` are set, mount `expressBasicAuth` middleware at the top of the router before all API routes
  - `GET /` (served from `server.ts`, not the router) must remain unauthenticated
  - `GET /api/chats` without credentials returns 401 when env vars set; returns 200 when not set
  - _Requirements: 2.1, 2.2, 2.3_
  - _Boundary: src/web/routes.ts_

- [ ] 4. (P) Add MCP bearer token check
  - In `src/mcp.ts` `CallToolRequestSchema` handler: if `MCP_SECRET` is set, extract `Authorization` from `request.params._meta`; if missing or not matching `Bearer ${MCP_SECRET}`, return `{ error: { code: -32001, message: 'Unauthorized' } }`
  - When `MCP_SECRET` is not set, all requests are handled as before
  - _Requirements: 3.1, 3.2_
  - _Boundary: src/mcp.ts_

- [ ] 5. Tests
- [ ] 5.1 Security layer tests
  - Create `tests/security.test.ts`
  - DB encryption: `initDb` with `DB_KEY` set → opening resulting file without key throws; `:memory:` works without key
  - Web auth: supertest `GET /api/chats` without credentials returns 401 (env set); with credentials returns 200; `GET /` always 200
  - MCP bearer: mock request with correct token dispatches; without token returns Unauthorized error
  - Localhost binding: assert `server.listen(...)` then `server.address().address === '127.0.0.1'` (can be added to `tests/web.test.ts`)
  - All tests pass with `npm test`
  - _Requirements: 1.1, 1.4, 2.1, 2.3, 3.1, 4.1_
