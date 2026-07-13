# Design Document : security-hardening

## Overview

KhipuChat adds four independent, opt-in protection layers: database encryption at rest, web UI Basic Auth, MCP bearer-token auth, and localhost-only binding verification. Each layer is toggled by a single environment variable and degrades to current unprotected behaviour when the variable is absent.

Gap analysis (`research.md`, 2026-07-12) established that layers 1-3 are **already implemented and covered by `tests/security.test.ts`**. This design therefore has a narrow remaining scope: implement the Requirement 4 localhost-binding guarantee (currently untested) and confirm the existing layers remain correct. The design records the current implementation as the authoritative contract so future changes can be revalidated against it.

### Goals
- Guarantee, via an executed test, that the web server binds only to `127.0.0.1` (Requirement 4).
- Preserve the already-shipped, already-tested behaviour of layers 1-3 (Requirements 1-3) as stable contracts.
- Keep every layer opt-in and backward compatible (absent env var = current behaviour).

### Non-Goals
- TLS/HTTPS, multi-user management, audit logging, 2FA.
- Any new web UI features or MCP tool signature changes.
- Re-implementing layers 1-3 (they exist and pass).

## Boundary Commitments

### This Spec Owns
- `initDb` cipher-key behaviour in `src/db.ts` (open with `PRAGMA key` when `DB_KEY` set; `:memory:` bypass).
- Basic-auth gate on `/api/*` in `src/web/routes.ts`.
- Bearer-token check in the `CallToolRequestSchema` handler in `src/mcp.ts`.
- Localhost bind guarantee for the web server, made testable via an exported `startServer` helper in `src/web/server.ts`.
- Security test coverage in `tests/security.test.ts` for all four layers.

### Out of Boundary
- Any new web UI features or endpoints.
- MCP tool signatures (only the unauthorized error path is owned here).
- Any platform sync adapter changes.
- The `express` / MCP SDK request-transport internals.

### Allowed Dependencies
- `better-sqlite3-multiple-ciphers` (already the `Database` import, replacing `better-sqlite3`).
- `express-basic-auth` (already a production dependency).
- `supertest`, `vitest` (test-only, already used).

### Revalidation Triggers
- Change to the `initDb(path)` signature or key-application logic.
- Change to MCP request handling (`req.params._meta.authorization`) in `src/mcp.ts`.
- Change to how or where the web server binds (host/port) in `src/web/server.ts`.
- Change to the `/api` path prefix used to gate Basic Auth.

## Architecture

### Existing Architecture Analysis

The three runtime layers are already integrated at their natural seams and require no change:

- **DB layer** (`src/db.ts:89-98`): `initDb` opens the DB, then applies `PRAGMA key` when `DB_KEY` is set and the path is not `:memory:`. A wrong key surfaces as a clear error string.
- **Web layer** (`src/web/routes.ts:10-16`): a router-level middleware gates only `/api`-prefixed paths behind `express-basic-auth` when both `WEB_USER` and `WEB_PASS` are set. `GET /` is registered on the app in `server.ts`, outside the router, so it is never gated.
- **MCP layer** (`src/mcp.ts:57-64`): the `CallToolRequestSchema` handler checks `req.params._meta.authorization === Bearer <MCP_SECRET>` before dispatch when `MCP_SECRET` is set.

The single structural gap is testability of the bind address: `src/web/server.ts` performs `app.listen(3333, '127.0.0.1', ...)` inside the non-exported `main()`. `createApp()` returns only the Express `Application`, so no test can currently assert the production bind host.

### Architecture Decision: R4 bind testability

**Selected: export a `startServer` helper (Option B).** Extract the listen call from `main()` into an exported `startServer(app, host?, port?)` whose `host` defaults to `127.0.0.1`. `main()` calls `startServer(app)`; the test calls `startServer(createApp(), undefined, 0)` and asserts the default bind is `127.0.0.1`.

Rationale: Requirement 4's objective is to prevent a configuration change from accidentally exposing the server to the network. A test that itself passes `'127.0.0.1'` to `listen` (Option A) is near-tautological and would still pass if `main()` were changed to bind `0.0.0.0`. Testing the helper's default host is the smallest change that actually guards the requirement's intent. The refactor keeps `server.ts` well under the size limit and introduces no new dependency.

### Technology Stack

| Layer | Choice / Version | Role in Feature | Notes |
|-------|------------------|-----------------|-------|
| Data / Storage | `better-sqlite3-multiple-ciphers` ^11.10 | SQLCipher key application in `initDb` | Already the `Database` import; drop-in for `better-sqlite3` |
| Backend / Services | `express-basic-auth` ^1.2 | Basic Auth on `/api/*` | Already a production dependency |
| Backend / Services | `@modelcontextprotocol/sdk` | Bearer check in tool-call handler | Existing; only the auth branch is owned |
| Test | `vitest` + `supertest` | Coverage for all four layers | Existing patterns in `tests/security.test.ts` |

## File Structure Plan

### New Files
```
(none)
```

### Modified Files
- `src/web/server.ts` — extract `app.listen(port, host, cb)` from `main()` into an exported `startServer(app, host = '127.0.0.1', port = 3333)`; `main()` delegates to it. No behaviour change for production (same default host/port).
- `tests/security.test.ts` — add the Requirement 4 test: start the app on an ephemeral port via `startServer(createApp(), undefined, 0)`, assert `server.address().address === '127.0.0.1'`, close the server in cleanup.

> Layers 1-3 (`src/db.ts`, `src/web/routes.ts`, `src/mcp.ts`) are already implemented and require no change. They appear in traceability below as verified contracts, not as modifications.

## Components and Interfaces

| Component | Layer | Intent | Req Coverage | Status |
|-----------|-------|--------|--------------|--------|
| `initDb` cipher key | Data | Encrypt DB file when `DB_KEY` set; bypass for `:memory:` | 1.1-1.4 | Implemented (verify) |
| `/api` Basic Auth middleware | Web | 401 unauthenticated API access when `WEB_USER`+`WEB_PASS` set | 2.1-2.3 | Implemented (verify) |
| MCP bearer check | MCP | Reject tool calls without matching `Bearer <MCP_SECRET>` | 3.1-3.2 | Implemented (verify) |
| `startServer` helper | Web | Bind web server; default host `127.0.0.1`, testable | 4.1 | New |

### Web / `startServer` (`src/web/server.ts`)

The only component introducing a new boundary in this design.

**Contracts**: Service [x]

##### Service Interface
```typescript
import type { Application } from 'express'
import type { Server } from 'node:http'

// Extracted from main(); default host guarantees localhost-only binding.
export function startServer(
  app: Application,
  host?: string,   // default '127.0.0.1'
  port?: number,   // default 3333
): Server
```
- Preconditions: `app` is a configured Express `Application` (from `createApp()`).
- Postconditions: returns a listening `http.Server`; `server.address().address === host` (default `127.0.0.1`).
- Invariants: default `host` is `127.0.0.1`; `main()` must not pass a broader host.

**Implementation Notes**
- Integration: `main()` calls `startServer(createApp())`; the existing `EADDRINUSE` handler stays attached to the returned server (moved or reattached around the helper). Production bind host/port are unchanged.
- Validation: covered by the R4 test asserting the default-host bind (see Testing Strategy).
- Risks: low; a pure extraction. Only risk is dropping the `EADDRINUSE` handler during the move, which the existing web startup path exercises.

### Verified Contracts (already implemented, no change)

- **DB Encryption** (`src/db.ts` `initDb`): applies `PRAGMA key="<DB_KEY>"` (double-quotes in the key stripped) when `DB_KEY` set and `path !== ':memory:'`; wrong key rethrows `DB_KEY is set but the database could not be opened — key may be incorrect`. Requirements 1.1-1.4.
- **Web Basic Auth** (`src/web/routes.ts`): router middleware calls `expressBasicAuth({ users: { [WEB_USER]: WEB_PASS }, challenge: true })` only for `req.path` starting with `/api` and only when both vars set; `GET /` (mounted in `server.ts`) is never gated. Requirements 2.1-2.3.
- **MCP Bearer** (`src/mcp.ts`): returns `{ error: { code: -32001, message: 'Unauthorized' } }` when `MCP_SECRET` set and `req.params._meta.authorization !== Bearer <MCP_SECRET>`. Requirements 3.1-3.2.

## Requirements Traceability

| Requirement | Summary | Component / File | Status |
|-------------|---------|------------------|--------|
| 1.1-1.4 | DB encryption at rest + `:memory:` bypass | `src/db.ts` `initDb` | Implemented + tested |
| 2.1-2.3 | Web `/api/*` Basic Auth; `GET /` never gated | `src/web/routes.ts` | Implemented + tested |
| 3.1-3.2 | MCP bearer token | `src/mcp.ts` | Implemented + tested |
| 4.1 | Web server binds only to `127.0.0.1` | `src/web/server.ts` `startServer` + `tests/security.test.ts` | New |

## Testing Strategy

### Unit / Integration Tests (existing, confirm still pass)
- DB encryption: `initDb(tmpPath)` with `DB_KEY` set produces a file that fails to open without the key; `:memory:` works with or without `DB_KEY`; unencrypted path opens normally when unset. (1.1-1.4)
- Web auth: supertest `GET /api/chats` → 200 when unset, 401 when set without/with wrong credentials, 200 with valid Basic auth; `GET /` → 200 regardless. (2.1-2.3)
- MCP bearer: tool call allowed when `MCP_SECRET` unset; `Unauthorized` (`-32001`) when set and token missing; dispatched when `Bearer <MCP_SECRET>` matches. (3.1-3.2)

### New Test (Requirement 4)
- Localhost binding: call `startServer(createApp(), undefined, 0)` (ephemeral port, default host), assert `server.address().address === '127.0.0.1'`, then close the server in cleanup. Located in `tests/security.test.ts`, co-located with the other three layers. Verifies the requirement's intent: the default bind is localhost-only, so a future change to `main()` that broadened the host would fail this test. (4.1)

## Security Considerations

- All four controls are defence-in-depth for a single-user, self-hosted, localhost-only deployment; they are opt-in and independent (failure or absence of one does not affect the others).
- The `DB_KEY` value is passed to SQLCipher via `PRAGMA key`; the implementation strips embedded double-quotes to keep the pragma well-formed. Key management (storage, rotation) is the operator's responsibility and out of scope.
- Requirement 4 is specifically a guard against accidental network exposure; the `startServer` default-host test is the enforcement point.
