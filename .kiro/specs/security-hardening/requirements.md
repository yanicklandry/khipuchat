# Requirements Document

## Introduction

Security Hardening adds four independent, opt-in protection layers to KhipuChat: database encryption at rest, web UI password authentication, MCP server bearer token authentication, and localhost-only binding verification. All layers are activated by environment variables and degrade gracefully to the current unprotected behaviour when those variables are absent.

## Boundary Context

- **In scope**: SQLCipher DB encryption via `better-sqlite3-multiple-ciphers`, `express-basic-auth` on web API routes, `Authorization: Bearer` check on MCP requests, `DB_KEY` / `WEB_USER` / `WEB_PASS` / `MCP_SECRET` env vars, tests for each layer.
- **Out of scope**: TLS/HTTPS, multi-user management, audit logging, 2FA, any new web UI features.
- **Adjacent expectations**: `src/db.ts` `initDb` call is modified (open with cipher key when `DB_KEY` set). `src/mcp.ts` CallToolRequestSchema handler gains a bearer check. `src/web/routes.ts` gains basic-auth middleware. In-memory DB (`:memory:`) in tests must continue to work without any key.

## Requirements

### Requirement 1: Database Encryption at Rest

**Objective:** As a user, I want my SQLite database file encrypted so that access to the file does not expose message contents.

#### Acceptance Criteria

1. When `DB_KEY` is set, the DB Encryption layer shall open the database with that key using SQLCipher (via `better-sqlite3-multiple-ciphers`), making the file unreadable without the key.
2. When `DB_KEY` is not set, the DB Encryption layer shall open the database without a key, preserving the current unencrypted behaviour.
3. When `DB_KEY` changes between runs, the DB Encryption layer shall fail with a clear error message rather than silently corrupting the database.
4. The in-memory database (`:memory:`) used in tests shall work correctly whether or not `DB_KEY` is set in the test environment.

---

### Requirement 2: Web UI Password Authentication

**Objective:** As a user, I want the web UI to require a username and password so that other local processes cannot access my messages.

#### Acceptance Criteria

1. When `WEB_USER` and `WEB_PASS` are both set, the Web UI server shall require HTTP Basic Authentication on all `/api/*` routes and respond with `401` to unauthenticated requests.
2. When `WEB_USER` or `WEB_PASS` is not set, the Web UI server shall serve all routes without authentication (current behaviour).
3. The `GET /` HTML page shall never be gated by authentication (only the API routes require auth).

---

### Requirement 3: MCP Server Bearer Token Authentication

**Objective:** As a user, I want the MCP server to require a secret token so that other processes on the machine cannot issue MCP tool calls.

#### Acceptance Criteria

1. When `MCP_SECRET` is set, the MCP server shall reject any tool call request that does not include `Authorization: Bearer <token>` matching `MCP_SECRET`, responding with an MCP error.
2. When `MCP_SECRET` is not set, the MCP server shall handle all requests without authentication (current behaviour).

---

### Requirement 4: Localhost-Only Binding Verification

**Objective:** As an operator, I want a test to confirm the web server binds only to 127.0.0.1 so that a configuration change cannot accidentally expose the server to the network.

#### Acceptance Criteria

1. The test suite shall include a test that verifies the Express server's `address().address` equals `127.0.0.1`.
