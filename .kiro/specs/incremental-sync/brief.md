# Brief: incremental-sync

## Problem
Every `sync:*` script currently does a full backfill on every run — it re-reads everything from the source platform and re-inserts (or re-skips) all messages. WeChat in particular takes very long because it processes every message on each run. Users have no way to run a quick "catch up on new messages" sync.

## Current State
- `PlatformAdapter` has `runBackfill(db)` — unconditional full scan
- No per-platform last-sync timestamp is stored anywhere
- All `sync:*` scripts run a full sweep every invocation
- The `sync` npm script runs backfill-only for all platforms sequentially

## Desired Outcome
- A `sync_state` table stores `{ platform, last_synced_at }` per platform
- `PlatformAdapter` gains an optional `syncIncremental(db, since: Date)` method
- Each platform adapter implements incremental sync where the source supports it (timestamp/cursor filtering)
- `npm run sync:wechat` (and all others) defaults to incremental mode; `--backfill` flag forces a full scan
- Last successful sync timestamp is updated only on clean completion (no partial-write corruption)

## Approach
Add a `sync_state` table to `src/db.ts`. Extend `PlatformAdapter` in `src/platforms/types.ts` with an optional `syncIncremental(db, since)`. Update each existing adapter to implement it where feasible. Make the CLI entry points check for a stored `last_synced_at` and route to incremental or full-backfill accordingly.

## Scope
- **In**: `sync_state` DB table, `PlatformAdapter` interface extension, per-platform incremental implementation, `--backfill` flag on all `sync:*` scripts, last-sync-at update on success
- **Out**: Real-time push/webhook triggering, changing the existing `runBackfill` signature, removing full-backfill capability

## Boundary Candidates
- DB layer: `sync_state` table DDL + helpers in `src/db.ts`
- Interface: `syncIncremental` optional method on `PlatformAdapter` in `src/platforms/types.ts`
- Per-platform: each adapter in `src/platforms/<name>/sync.ts` implements incremental logic
- CLI glue: each `sync:*` entry point decides backfill vs incremental

## Out of Boundary
- Does not change how messages are stored — only which ones are fetched
- Does not implement the watcher daemon (that is `sync-watcher`)
- Does not add any new sync platforms

## Upstream / Downstream
- **Upstream**: `platform-abstraction` (PlatformAdapter interface, db schema conventions)
- **Downstream**: `sync-watcher` (needs incremental sync to avoid re-fetching everything on each poll cycle)

## Existing Spec Touchpoints
- **Extends**: `platform-abstraction` (adds to PlatformAdapter interface)
- **Adjacent**: `wechat-sync`, `discord-sync`, `email-sync`, `slack-sync`, `whatsapp-sync` (each adapter gains incremental logic)

## Constraints
- DB ops stay synchronous (better-sqlite3)
- `last_synced_at` must only be written on clean success — never on partial/failed run
- Platforms where the source doesn't support time-filtering (e.g. full-scan-only APIs) fall back to full backfill gracefully
- Each source file stays under 200 lines
