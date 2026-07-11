# Requirements Document

## Introduction

KhipuChat currently performs a full backfill on every `sync:*` invocation - every message from every chat is re-read from the source platform and re-inserted (or silently skipped) on each run. WeChat in particular is slow because it decrypts and scans dozens of database files on each call. There is no way to run a quick "catch-up" sync that fetches only messages newer than the last successful run.

This feature introduces per-platform incremental sync: a `sync_state` table records the timestamp of the last successful sync per platform, and each adapter uses that timestamp to filter the source query so only new messages are fetched. All `sync:*` scripts default to incremental mode; a `--force` flag forces a full scan and rebuilds the semantic search index. The sync timestamp is written only on clean completion to prevent partial-write corruption.

## Boundary Context

- **In scope**: `sync_state` DB table and helper functions; `PlatformAdapter` interface extension (`syncIncremental` optional method); per-platform incremental logic for all existing adapters (telegram, imessage, wechat, discord, slack, email, whatsapp); `--force` flag on all `sync:*` CLI entry points with `--backfill` as deprecated alias; post-sync semantic search index rebuild when `--force` is set; atomic last-sync-at write on success.
- **Out of scope**: Real-time push / webhook triggering; changing or removing the existing `runBackfill` signature; adding new sync platforms; the `sync-watcher` daemon; how messages are stored once fetched.
- **Adjacent expectations**: `platform-abstraction` spec owns the `PlatformAdapter` interface - this spec extends it by adding an optional method. The `sync-watcher` downstream spec depends on incremental sync being available so it can poll without re-fetching everything each cycle. The `multi-account` spec will require `sync_state` to be keyed by (platform, account) rather than platform alone (see Requirement 6).

## Requirements

### Requirement 1: sync_state persistence

**Objective:** As a KhipuChat operator, I want the last successful sync timestamp to be stored persistently per platform, so that subsequent runs know where to resume without re-reading old data.

#### Acceptance Criteria

1. The sync system shall maintain a `sync_state` table with columns `platform` (TEXT PRIMARY KEY) and `last_synced_at` (INTEGER, Unix seconds).
2. When a sync run completes without error, the sync system shall update `last_synced_at` for that platform to the current Unix timestamp.
3. If a sync run fails or is interrupted before completion, the sync system shall not update `last_synced_at` for that platform.
4. When the database is initialized, the sync system shall create the `sync_state` table if it does not already exist.
5. The sync system shall expose a `getLastSyncedAt(platform)` function that returns the stored Unix timestamp or `null` if no prior sync has been recorded.
6. The sync system shall expose a `setLastSyncedAt(platform, timestamp)` function that writes the timestamp atomically within the caller's transaction.

### Requirement 2: PlatformAdapter incremental interface

**Objective:** As a platform adapter author, I want a standard optional method on `PlatformAdapter` for incremental sync, so that new adapters can declare incremental capability without modifying the base interface contract.

#### Acceptance Criteria

1. The `PlatformAdapter` interface shall declare an optional method `syncIncremental(db, since: Date)` returning a promise.
2. When a platform adapter implements `syncIncremental`, the sync runner shall call it instead of `runBackfill` when a prior `last_synced_at` is available and the `--force` flag is not set.
3. When a platform adapter does not implement `syncIncremental`, the sync runner shall fall back to `runBackfill` regardless of whether a prior `last_synced_at` exists.
4. The `runBackfill` method signature shall remain unchanged.

### Requirement 3: Incremental sync per platform

**Objective:** As a KhipuChat operator, I want each platform adapter to fetch only messages newer than the last successful sync, so that sync runs complete faster when little has changed.

#### Acceptance Criteria

1. When `syncIncremental` is called for the telegram adapter with a `since` date, the telegram adapter shall fetch only messages with a server timestamp after `since` for each dialog.
2. When `syncIncremental` is called for the imessage adapter with a `since` date, the imessage adapter shall query the local iMessage database filtered to messages received after `since`.
3. When `syncIncremental` is called for the wechat adapter with a `since` date, the wechat adapter shall filter each message table to records created after `since`.
4. When `syncIncremental` is called for the discord adapter with a `since` date, the discord adapter shall request only messages created after `since` from the Discord API.
5. When `syncIncremental` is called for the slack adapter with a `since` date, the slack adapter shall request only messages created after `since` from the Slack API.
6. When `syncIncremental` is called for the email adapter with a `since` date, the email adapter shall fetch only messages received after `since` using a server-side date filter.
7. When `syncIncremental` is called for the whatsapp adapter with a `since` date, the whatsapp adapter shall filter fetched messages client-side to those with a timestamp after `since`.
8. If a platform source does not support time-based filtering and no client-side filter is feasible, the sync system shall fall back to full backfill and log a warning to stdout.

### Requirement 4: CLI --force flag and default incremental mode

**Objective:** As a KhipuChat operator, I want `sync:*` scripts to default to incremental mode and accept a `--force` flag that performs a full scan and rebuilds the semantic search index, so that day-to-day syncs are fast while a complete resync remains possible in a single command.

#### Acceptance Criteria

1. When a `sync:*` script is invoked without `--force`, the sync runner shall use incremental mode if `last_synced_at` is available for that platform.
2. When a `sync:*` script is invoked without `--force` and no prior `last_synced_at` exists, the sync runner shall fall back to `runBackfill` (first-run behaviour).
3. When a `sync:*` script is invoked with `--force`, the sync runner shall perform a full backfill regardless of stored `last_synced_at`.
4. When a `sync:*` script is invoked with `--force`, the sync runner shall rebuild the semantic search index for the affected messages after the sync completes.
5. The `--backfill` flag shall be accepted as a deprecated alias for `--force`.
6. The `npm run sync` aggregate script shall support the `--force` flag and pass it through to each platform sync.
7. The sync runner shall print either `incremental` or `backfill` to stdout before the sync begins.

### Requirement 5: Atomic last-sync-at update on success

**Objective:** As a KhipuChat operator, I want the sync timestamp to be written only after a clean successful run, so that an interrupted sync does not leave the system thinking it has already processed messages it has not.

#### Acceptance Criteria

1. When a platform sync completes all message insertions without throwing, the sync runner shall write the new `last_synced_at` timestamp to `sync_state`.
2. If an unhandled error is thrown during a sync run, the sync system shall not write a new `last_synced_at` for that platform.
3. The sync system shall write `last_synced_at` at the platform level (not per-chat), capturing the timestamp of when the run completed.
4. While `last_synced_at` is updated at the platform level, per-chat sync timestamps shall continue to be updated after each individual chat sync as before.

### Requirement 6: Per-account sync state

**Objective:** As a KhipuChat operator using multiple accounts per platform, I want sync state to be tracked per (platform, account) pair, so that each account's sync history is independent and a resync of one account does not affect others.

#### Acceptance Criteria

1. Where multi-account support is enabled, the sync system shall key `sync_state` rows by (platform, account) rather than platform alone.
2. Where multi-account support is enabled, `getLastSyncedAt` and `setLastSyncedAt` shall accept an account argument in addition to platform.
3. When migrating from single-account to multi-account keying, the sync system shall migrate existing `sync_state` rows to account `"default"` without data loss.
4. Where multi-account support is not enabled, the sync system shall key `sync_state` rows by platform alone, preserving backward compatibility.
