# Brief: web-ui

## Problem
Claude is the only way to query synced messages. Users need a local browser UI to search, browse chats, and read message threads without involving an AI assistant.

## Current State
All messages are in SQLite. The MCP server exposes search and list logic. No HTTP layer or UI exists yet.

## Desired Outcome
`npm run web` starts a local server at `http://localhost:3333`. Users can search messages, browse the chat list, and read a thread — all in a plain browser tab, no framework, no build step.

## Approach
Express + plain HTML/CSS served from `src/web.ts`. Single-page app with three zones: search box at top, chat list sidebar, message thread view. All data comes from the same handler functions already used by the MCP server (`handleListChats`, `handleSearchMessages`, `handleListMessages`, `handleGetChatSummary`).

## Scope
- **In**: Express HTTP server, GET /api/chats, GET /api/search, GET /api/messages/:chatId, static HTML/CSS, platform badge on each message
- **Out**: Authentication (security-hardening owns that), sending messages, media rendering, mobile layout, real-time push

## Boundary Candidates
- HTTP route handlers (Express layer) — own JSON API surface
- Static assets (HTML/CSS) — served from `src/web/` or inline in `src/web.ts`
- Reuse of existing MCP handler functions — no new DB logic

## Out of Boundary
- Auth/encryption — security-hardening spec
- Any new DB schema changes — platform-abstraction already owns the schema
- MCP tool changes — web-ui only reads, never modifies MCP tools

## Upstream / Downstream
- **Upstream**: platform-abstraction (schema + handler functions), imessage-sync (data in DB)
- **Downstream**: security-hardening (wraps this server with auth), release (packages this)

## Existing Spec Touchpoints
- **Extends**: mcp.ts handler functions are reused (not modified) by the web routes
- **Adjacent**: src/mcp.ts — must not change MCP tool signatures

## Constraints
- No frontend framework, no build step (plain HTML/CSS/vanilla JS only)
- No new npm dependencies beyond Express (already planned) and possibly supertest for tests
- Server must bind to 127.0.0.1 only (localhost-only, enforced here not in security-hardening)
- Keep src/web.ts under 200 lines; split into src/web/ subdirectory if needed
