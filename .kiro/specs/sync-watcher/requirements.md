# Requirements Document

## Introduction

KhipuChat operators currently have no built-in way to keep the message archive continuously up-to-date. The existing `khipu sync` performs a one-shot sequential backfill, and the only path to automation is OS-level daemon setup (macOS LaunchAgent), which is complex and undiscoverable. This feature adds `khipu sync all` as a long-running polling daemon that keeps every configured platform and account's message archive current without operator intervention. It also supports a single-pass mode (`--once`) for cron-based scheduling.

## Boundary Context

- **In scope**: `khipu sync all` daemon entry point; `npm run watch` as a thin wrapper during transition; per-platform configurable polling interval via env vars; calling incremental sync (or backfill as fallback) on each poll cycle; running the embedding indexing step after cycles that fetch new messages; per-platform/account error isolation; skip-if-unconfigured logic; graceful shutdown on SIGINT/SIGTERM; single-pass mode via `--once` flag; per-account polling using the account registry.
- **Out of scope**: Modifying any `sync:*` scripts or platform adapter internals; real-time push/webhook sync; adding new platforms; exposing a status endpoint or UI; replacing or removing the LaunchAgent setup path.
- **Adjacent expectations**: The watcher depends on each platform adapter exposing a backfill sync function and optionally an incremental sync function (provided by the `incremental-sync` upstream spec). Credential-check logic from each adapter is reused as-is to detect unconfigured platform/accounts. The embedding indexing step is called after each cycle that fetches new messages; the watcher does not own that step's implementation.

## Requirements

### Requirement 1: Daemon Startup

**Objective:** As a KhipuChat operator, I want `khipu sync all` to start a long-running daemon, so that the message archive is kept current without manual sync runs.

#### Acceptance Criteria

1. When `khipu sync all` is invoked without `--once`, the watch daemon shall start and emit a startup log listing each platform/account that will be polled and its configured interval.
2. When `khipu sync all` is invoked and a platform/account's required credentials or configuration are absent, the watch daemon shall skip that platform/account and log a one-time informational message at startup indicating it is unconfigured.
3. The watch daemon shall begin polling all configured platforms/accounts immediately on startup without waiting for the first interval to expire.
4. When `npm run watch` is invoked, it shall behave identically to `khipu sync all` (thin wrapper during transition).

### Requirement 2: Per-Platform/Account Polling Loop

**Objective:** As a KhipuChat operator, I want each platform/account to be polled on its own configurable interval, so that more active sources can sync more frequently without affecting others.

#### Acceptance Criteria

1. While the watch daemon is running, it shall poll each configured platform/account at the interval configured for that platform.
2. When a poll cycle completes and new messages were fetched, the watch daemon shall log `[platform] synced N new messages` where N is the count of new messages.
3. When a poll cycle completes and no new messages were found, the watch daemon shall log `[platform] up to date`.
4. When a platform adapter provides an incremental sync capability and a prior sync state exists, the watch daemon shall use incremental sync for that platform/account's poll cycle.
5. When a platform adapter does not provide an incremental sync capability, the watch daemon shall use the backfill sync for that platform/account's poll cycle.
6. The watch daemon shall iterate over configured accounts per platform using the account registry, polling each account independently.

### Requirement 3: Per-Platform/Account Error Isolation

**Objective:** As a KhipuChat operator, I want a failing platform or account not to crash the watcher, so that other platforms continue to sync even when one has an error.

#### Acceptance Criteria

1. If a poll cycle for a platform/account raises an error, the watch daemon shall catch the error, log it with the platform and account name, and continue running.
2. If a poll cycle for a platform/account raises an error, the watch daemon shall not stop or affect the polling loops of other platforms or accounts.
3. While the watch daemon is running, a platform/account that repeatedly fails shall continue to be retried on each subsequent interval without requiring a restart.

### Requirement 4: Graceful Shutdown

**Objective:** As a KhipuChat operator, I want the watcher to shut down cleanly when I stop it, so that no in-progress sync operations are interrupted unexpectedly.

#### Acceptance Criteria

1. When the watch daemon receives SIGINT or SIGTERM, it shall stop scheduling new poll cycles and exit the process cleanly after any in-progress sync cycles complete.
2. When the watch daemon shuts down, it shall emit a log message confirming the shutdown.

### Requirement 5: Polling Interval Configuration

**Objective:** As a KhipuChat operator, I want to configure per-platform polling intervals via environment variables, so that I can tune sync frequency for each platform without code changes.

#### Acceptance Criteria

1. The watch daemon shall read a per-platform interval from an environment variable named `WATCH_INTERVAL_<PLATFORM>_MS` where `<PLATFORM>` is the uppercase platform name (e.g. `WATCH_INTERVAL_TELEGRAM_MS`).
2. When no per-platform interval environment variable is set, the watch daemon shall apply a default interval of 5 minutes for that platform.
3. When a per-platform interval environment variable is set to a positive integer, the watch daemon shall use that value in milliseconds as the polling interval for that platform.

### Requirement 6: Index After Sync

**Objective:** As a KhipuChat operator, I want each poll cycle to also index newly synced messages, so that new messages become semantically searchable without a separate manual step.

#### Acceptance Criteria

1. When a poll cycle for a platform/account fetches one or more new messages, the watch daemon shall run the embedding indexing step for those messages after the sync completes and before the next wait interval (sync then index then wait).
2. When a poll cycle fetches no new messages, the watch daemon shall skip the indexing step for that cycle.
3. If the indexing step raises an error, the watch daemon shall log the error with the platform and account name and continue running, applying the same error isolation as sync errors.

### Requirement 7: Single-Pass Mode

**Objective:** As a KhipuChat operator, I want to run a single sync and index pass and then exit, so that I can use the runner from cron or scripts without keeping a long-running process.

#### Acceptance Criteria

1. When `khipu sync all` is invoked with `--once`, the runner shall perform one sync+index pass over all configured platforms/accounts and then exit rather than entering the continuous polling loop.
2. When the `--once` pass completes, the runner shall emit a completion log message and exit.
3. If an error occurs during a `--once` pass for one platform/account, the runner shall log the error and continue with the remaining platforms/accounts rather than exiting early.
