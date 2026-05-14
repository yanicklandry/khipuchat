# Requirements Document

## Introduction

KhipuChat currently performs a full backfill on every `sync:*` invocation — every message from every chat is re-read from the source platform and re-inserted (or silently skipped) on each run. WeChat in particular is slow because it decrypts and scans dozens of database files on each call. There is no way to run a quick "catch-up" sync that fetches only messages newer than the last successful run.

This feature introduces per-platform incremental sync: a `sync_state` table records the timestamp of the last successful sync per platform, and each adapter uses that timestamp to filter the source query so only new messages are fetched. All `sync:*` scripts default to incremental mode; a `--backfill` flag forces a full scan. The sync timestamp is written only on clean completion to prevent partial-write corruption.

## Boundary Context

- **In scope**: `sync_state` DB table and helper functions; `PlatformAdapter` interface extension (`syncIncremental` optional method); per-platform incremental logic for all existing adapters (telegram, imessage, wechat, discord, slack, email, whatsapp); `--backfill` flag on all `sync:*` CLI entry points; atomic last-sync-at write on success.
- **Out of scope**: Real-time push / webhook triggering; changing or removing the existing `runBackfill` signature; adding new sync platforms; the `sync-watcher` daemon; how messages are stored once fetched.
- **Adjacent expectations**: `platform-abstraction` spec owns the `PlatformAdapter` interface — this spec extends it by adding an optional method. The `sync-watcher` downstream spec depends on incremental sync being available so it can poll without re-fetching everything each cycle.

## Requirements

### Requirement 1: sync_state persistence

**Objective:** As a KhipuChat operator, I want the last successful sync timestamp to be stored persistently per platform, so that subsequent runs know where to resume without re-reading old data.

#### Acceptance Criteria

1. The sync system shall maintain a `sync_state` table with columns `platform` (TEXT PRIMARY KEY) and `last_synced_at` (INTEGER, Unix seconds).
2. When a sync run completes without error, the sync system shall update `last_synced_at` for that platform to the current Unix timestamp.
3. If a sync run fails or is interrupted before completion, the sync system shall not update `last_synced_at` for that platform.
4. When `initDb` is called, the sync system shall create the `sync_state` table if it does not already exist.
5. The sync system shall expose a `getLastSyncedAt(platform)` function that returns the stored Unix timestamp or `null` if no prior sync has been recorded.
6. The sync system shall expose a `setLastSyncedAt(platform, timestamp)` function that writes the timestamp inside the caller's transaction boundary.

### Requirement 2: PlatformAdapter incremental interface

**Objective:** As a platform adapter author, I want a standard optional method on `PlatformAdapter` for incremental sync, so that new adapters can declare incremental capability without modifying the base interface contract.

#### Acceptance Criteria

1. The `PlatformAdapter` interface shall declare an optional method `syncIncremental(db: Database.Database, since: Date): Promise<void>`.
2. When a platform adapter implements `syncIncremental`, the sync runner shall call it instead of `runBackfill` when a prior `last_synced_at` is available and the `--backfill` flag is not set.
3. When a platform adapter does not implement `syncIncremental`, the sync runner shall fall back to `runBackfill` regardless of whether a prior `last_synced_at` exists.
4. The `runBackfill` method signature shall remain unchanged.

### Requirement 3: Incremental sync per platform

**Objective:** As a KhipuChat operator, I want each platform adapter to fetch only messages newer than the last successful sync, so that sync runs complete faster when little has changed.

#### Acceptance Criteria

1. When `syncIncremental` is called for the telegram adapter with a `since` date, the telegram adapter shall fetch only messages with a server timestamp after `since` for each dialog.
2. When `syncIncremental` is called for the imessage adapter with a `since` date, the imessage adapter shall query `chat.db` with a `WHERE date > <cocoa_threshold>` filter derived from `since`.
3. When `syncIncremental` is called for the wechat adapter with a `since` date, the wechat adapter shall apply a `WHERE create_time > since` (or `WHERE CreateTime > since` for legacy schema) filter to each message table.
4. When `syncIncremental` is called for the discord adapter with a `since` date, the discord adapter shall pass `after: <snowflake>` to the Discord API derived from `since`.
5. When `syncIncremental` is called for the slack adapter with a `since` date, the slack adapter shall pass `oldest: <unix_seconds>` to the Slack conversations.history API.
6. When `syncIncremental` is called for the email adapter with a `since` date, the email adapter shall use an IMAP `SINCE <date>` search criterion.
7. When `syncIncremental` is called for the whatsapp adapter with a `since` date, the whatsapp adapter shall filter fetched messages client-side to those with a timestamp after `since` (WhatsApp Web API does not support server-side time filtering).
8. If a platform source does not support time-based filtering and no client-side filter is feasible, the sync system shall fall back to full backfill and log a warning.

### Requirement 4: CLI --backfill flag and default incremental mode

**Objective:** As a KhipuChat operator, I want `sync:*` scripts to default to incremental mode and accept a `--backfill` flag that forces a full scan, so that day-to-day syncs are fast while a full resync is still possible.

#### Acceptance Criteria

1. When a `sync:*` script is invoked without `--backfill`, the sync runner shall use incremental mode if `last_synced_at` is available for that platform.
2. When a `sync:*` script is invoked without `--backfill` and no prior `last_synced_at` exists, the sync runner shall fall back to `runBackfill` (first-run behaviour).
3. When a `sync:*` script is invoked with the `--backfill` flag, the sync runner shall call `runBackfill` regardless of stored `last_synced_at`.
4. The `npm run sync` aggregate script shall support the `--backfill` flag and pass it through to each platform sync.
5. When the sync mode chosen is logged, the sync runner shall print either `incremental` or `backfill` to stdout before the sync begins.

### Requirement 5: Atomic last-sync-at update on success

**Objective:** As a KhipuChat operator, I want the sync timestamp to be written only after a clean successful run, so that an interrupted sync does not leave the system thinking it has already processed messages it has not.

#### Acceptance Criteria

1. When a platform sync completes all message insertions without throwing, the sync runner shall write the new `last_synced_at` timestamp to `sync_state`.
2. If an unhandled error is thrown during a sync run, the sync system shall not write a new `last_synced_at` for that platform.
3. The sync system shall write `last_synced_at` at the platform level (not per-chat), capturing the timestamp of when the run completed.
4. While `last_synced_at` is updated at the platform level, per-chat `chats.last_synced_at` shall continue to be updated after each individual chat sync as before.
