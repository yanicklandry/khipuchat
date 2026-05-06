# Brief: discord-sync

## Problem
Discord messages are siloed in the Discord app. Users want their DMs and group channels searchable alongside Telegram and iMessage without leaving their local archive.

## Current State
Platform abstraction is in place (`PlatformAdapter` interface, `platform` field on all records). No Discord adapter exists.

## Desired Outcome
`npm run sync:discord` fetches all DMs and non-broadcast channels the user is a member of, stores them in the shared SQLite DB with `platform='discord'`, and is idempotent (safe to re-run).

## Approach
Discord bot token with `dm_channel:read` + `message_content` intent via the official Discord REST API (no WebSocket needed for backfill). Implement `src/platforms/discord/sync.ts` following the same pattern as the Telegram adapter: `runBackfillImpl(client)` injectable for testing, `discordAdapter` exported as `PlatformAdapter`.

## Scope
- **In**: `src/platforms/discord/sync.ts`, `src/platforms/discord/` module, `npm run sync:discord` script, env vars `DISCORD_TOKEN`, pagination via `before` cursor, deduplication via `external_id`, tests with mocked REST client
- **Out**: Real-time listener (Discord gateway WebSocket), server/guild message sync (DMs and joined channels only), sending messages

## Boundary Candidates
- Discord REST client wrapper — thin typed wrapper around fetch
- Message mapping — Discord message JSON → shared Message interface
- Backfill runner — pagination loop, injectable client for testing

## Out of Boundary
- DB schema changes — platform-abstraction owns the schema
- MCP tool changes — existing platform filter handles Discord automatically once data is in DB

## Upstream / Downstream
- **Upstream**: platform-abstraction (PlatformAdapter interface, db functions)
- **Downstream**: release (packaged), security-hardening (no direct dependency)

## Existing Spec Touchpoints
- **Extends**: src/platforms/types.ts (add 'discord' to Platform union if not already present)
- **Adjacent**: src/db.ts — call only exported functions, never modify schema

## Constraints
- Official Discord API only (no unofficial clients)
- DISCORD_TOKEN stored in .env, never hardcoded
- No new runtime dependencies beyond a fetch-based Discord client (or plain node fetch)
- Rate-limit-aware: respect Discord's 50 req/s global limit
