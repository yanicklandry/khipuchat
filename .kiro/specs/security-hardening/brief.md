# Brief: security-hardening

## Problem
The DB is plain-text SQLite and the web UI has no auth — unsafe on a shared machine or if the user wants to expose it beyond localhost.

## Current State
Web UI exists (web-ui spec), bound to localhost. DB is unencrypted better-sqlite3. MCP server has no auth. No password protection anywhere.

## Desired Outcome
The DB file is encrypted at rest. The web UI requires a password. The MCP server requires a bearer token. The web server still binds to 127.0.0.1 only (already enforced by web-ui, verified here).

## Approach
Four independent hardening layers applied in one spec:
1. **DB encryption**: swap `better-sqlite3` for `better-sqlite3-multiple-ciphers`, add `DB_KEY` env var, all existing db.ts code unchanged above the open() call
2. **Web auth**: `express-basic-auth` middleware on all `/api/*` routes, `WEB_USER` + `WEB_PASS` env vars
3. **MCP bearer token**: check `Authorization: Bearer <token>` header on each MCP request, `MCP_SECRET` env var, reject with error if missing/wrong
4. **Localhost binding verification**: assert server binds to 127.0.0.1 in tests

## Scope
- **In**: SQLCipher via better-sqlite3-multiple-ciphers, express-basic-auth middleware, MCP bearer token check in mcp.ts, env vars DB_KEY / WEB_USER / WEB_PASS / MCP_SECRET, tests for each layer
- **Out**: TLS/HTTPS (localhost only, not needed), user management (single user only), audit logging, 2FA

## Boundary Candidates
- DB encryption layer — isolated to the `initDb()` call in db.ts
- Web auth middleware — Express middleware, no business logic changes
- MCP auth — small addition to the CallToolRequestSchema handler

## Out of Boundary
- Any new web UI features — web-ui spec owns those
- Changing MCP tool signatures — auth is additive (new error response only)

## Upstream / Downstream
- **Upstream**: web-ui (the server to protect), platform-abstraction (db.ts to encrypt)
- **Downstream**: release (ships the hardened version)

## Existing Spec Touchpoints
- **Extends**: src/db.ts (initDb open call), src/mcp.ts (bearer token check), src/web.ts (auth middleware)
- **Adjacent**: All tests that call initDb(':memory:') — must still work without DB_KEY set (in-memory DB skips encryption)

## Constraints
- All auth is opt-in via env vars — if env var is not set, behavior is unchanged (backward compatible)
- better-sqlite3-multiple-ciphers must be a drop-in replacement for better-sqlite3 (same API)
- In-memory DB (`:memory:`) used in tests must not require a key
