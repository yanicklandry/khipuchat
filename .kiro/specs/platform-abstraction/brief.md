# Brief: platform-abstraction

## Problem
The codebase was built Telegram-first: `telegram_id` is hardcoded in the messages schema, `sync.ts` is a monolithic Telegram file, and MCP tool descriptions reference Telegram by name. Adding iMessage (or any future platform) requires schema migration, identifier renaming, and no clear home for new platform code.

## Current State
- `chats` table has no `platform` column — all records are implicitly Telegram
- `messages.telegram_id` is Telegram-specific naming
- `src/sync.ts` contains all Telegram sync logic at the top level
- MCP tools have no `platform` filter and responses carry no platform field

## Desired Outcome
- `chats.platform` and `messages.platform` exist, typed as `'telegram' | 'imessage' | 'discord' | 'slack' | 'whatsapp'`
- `messages.telegram_id` renamed to `messages.external_id`
- Source organized as `src/platforms/telegram/sync.ts`; shared Platform adapter interface at `src/platforms/types.ts`
- MCP tools accept optional `platform?` filter; all responses include a `platform` field
- All existing tests pass; new tests cover platform filtering in MCP tools and the renamed schema fields

## Approach
Approach B: `platform TEXT` on both `chats` and `messages`, typed union, shared `Platform` adapter interface. Additive MCP changes only (no tool renames, just new optional param + new response field).

## Scope
- **In**:
  - DB schema: add `platform TEXT NOT NULL DEFAULT 'telegram'` to `chats` and `messages`
  - DB schema: rename `messages.telegram_id` → `messages.external_id`
  - DB functions: update `upsertChat`, `insertMessage`, `getMessages`, `searchMessages`, `getLastSyncedId` signatures to include platform
  - Source: move `src/sync.ts` → `src/platforms/telegram/sync.ts`
  - Source: create `src/platforms/types.ts` with `Platform` type union and `PlatformAdapter` interface
  - MCP: add optional `platform?` parameter to `find_chat_by_name` and `search_messages`; add `platform` field to all tool responses
  - Tests: update existing tests for renamed fields; add platform-filter tests to mcp.test.ts
- **Out**:
  - iMessage sync implementation (next spec)
  - Any new MCP tools
  - Web UI changes
  - Config changes

## Boundary Candidates
- DB layer (`src/db.ts`): owns all schema and query changes
- Platform adapter interface (`src/platforms/types.ts`): defines the contract each platform must implement
- Telegram platform module (`src/platforms/telegram/sync.ts`): Telegram-specific sync logic, moved not rewritten
- MCP layer (`src/mcp.ts`): additive changes only

## Out of Boundary
- iMessage, Discord, Slack, WhatsApp sync logic
- New MCP tools beyond the four existing ones
- Migration tooling for existing deployed DBs (out of scope for now)

## Upstream / Downstream
- **Upstream**: existing Phase 1 implementation (db.ts, sync.ts, mcp.ts) — all currently passing tests must remain green
- **Downstream**: imessage-sync spec depends on the Platform adapter interface and the `platform` column being in place

## Existing Spec Touchpoints
- **Extends**: Phase 1 Telegram sync (all four files touched)
- **Adjacent**: none yet

## Constraints
- better-sqlite3 sync API throughout
- No tool renames in MCP (additive changes only — existing Claude Desktop configs must not break)
- Files stay under 200 lines; split if needed
- TypeScript strict mode, no `any`
