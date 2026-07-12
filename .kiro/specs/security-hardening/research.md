# Gap Analysis: security-hardening

_Generated: 2026-07-12_

## Analysis Summary

- **All four security layers are already implemented** in the codebase; this feature is not a greenfield implementation but a verification and test-coverage task.
- `src/db.ts:initDb` already reads `DB_KEY` and applies `PRAGMA key` via SQLCipher; in-memory bypass is already coded.
- `src/web/routes.ts` already has `express-basic-auth` middleware gated by `WEB_USER`/`WEB_PASS`.
- `src/mcp.ts:CallToolRequestSchema` handler already checks `Authorization: Bearer <MCP_SECRET>`.
- `tests/security.test.ts` already covers DB encryption, web auth, and MCP bearer token — but the **localhost-only binding verification test (Requirement 4)** is absent from both `security.test.ts` and `web.test.ts`.
- Both `express-basic-auth` and `better-sqlite3-multiple-ciphers` are already listed as production dependencies in `package.json`.

---

## Requirement-to-Asset Map

| Requirement | File(s) | Status |
|---|---|---|
| R1 — DB encryption at rest (`DB_KEY`) | `src/db.ts:58-76` | **Implemented** |
| R1.4 — `:memory:` bypass in tests | `src/db.ts:61` | **Implemented** |
| R2 — Web UI Basic Auth (`WEB_USER`/`WEB_PASS`) | `src/web/routes.ts:10-16` | **Implemented** |
| R2.3 — `GET /` never gated | `src/web/server.ts:11-17` (route registered after router) | **Implemented** |
| R3 — MCP bearer token (`MCP_SECRET`) | `src/mcp.ts:52-58` | **Implemented** |
| R4 — Localhost-only binding test | `tests/security.test.ts` / `tests/web.test.ts` | **Missing** |
| Security test suite (R1–R3) | `tests/security.test.ts` | **Implemented** |

---

## Gap Detail

### Only Gap: Requirement 4 — Localhost Binding Verification Test

`src/web/server.ts:24` already binds to `127.0.0.1` via `app.listen(3333, '127.0.0.1', ...)`. The implementation is correct, but no test asserts `server.address().address === '127.0.0.1'`.

**What is needed**: A test in `tests/security.test.ts` (or `tests/web.test.ts`) that:
1. Calls `createApp()` and `app.listen()` on a random port (`0`) to avoid port conflicts.
2. Reads `server.address()` and asserts `.address === '127.0.0.1'`.
3. Closes the server in an `afterEach`/`finally`.

**Complication**: `createApp()` in `src/web/server.ts` only exports the Express `Application`; the `listen` call with the `127.0.0.1` bind is inside `main()`, which is not exported. The test must therefore either:
- (A) Call `app.listen(0, '127.0.0.1')` in the test itself (mirroring the production pattern), or
- (B) Export a `createServer(app, host, port)` helper from `server.ts` to make the bind address testable.

Option A is simpler and matches the existing test style (no production code change needed). Option B offers stronger guarantees that the production `main()` is also tested.

---

## Implementation Approach Options

### Option A: Test-only fix (extend `tests/security.test.ts`)

Add one `it` block in `security.test.ts` that spins up the Express app on `127.0.0.1:0` (random port) and asserts the bound address.

- No production code change.
- Mirrors the production pattern without directly testing the `main()` entrypoint.
- Matches existing test conventions (supertest / `createApp()` pattern in `web.test.ts`).

**Trade-offs**:
- Faster to implement (S effort, Low risk).
- Does not guard against someone changing the host in `main()` without touching tests.

### Option B: Export `startServer` from `server.ts` + test it

Extract `app.listen(port, host, callback)` from `main()` into an exported `startServer(app, host?, port?)` function. Test calls `startServer(createApp(), '127.0.0.1', 0)` and asserts `.address().address`.

- Production code change: small refactor to `server.ts` (currently ~39 lines, well within 200-line limit).
- Directly tests the path that production traffic uses.

**Trade-offs**:
- Slightly more code (M effort, Low risk).
- Stronger correctness guarantee: if `main()` changes the host, the exported helper used in tests would catch it.

### Option C: No change needed (observation)

Requirements 1–3 are fully implemented and tested. Only Requirement 4 needs a test. There is no design decision required beyond Option A vs B above.

---

## Effort and Risk

| Dimension | Assessment | Justification |
|---|---|---|
| Effort | **S** (under 1 day) | Only one test to add; all production code already exists |
| Risk | **Low** | No new production logic; test-only work, well-understood Node.js net patterns |

---

## Recommendations for Design Phase

**Preferred approach**: Option A (test-only, no production code change). It is the smallest valid fix that satisfies Requirement 4 and aligns with the project's existing test pattern (`createApp()` + supertest in `web.test.ts` and `security.test.ts`).

**Key decision to confirm in design**: Whether the localhost binding test should live in `security.test.ts` (thematically correct, co-located with other security tests) or `web.test.ts` (tests all web server behaviour). Recommendation: `security.test.ts`.

**Research items to carry forward**: None — all dependencies are already installed, all APIs are understood.
