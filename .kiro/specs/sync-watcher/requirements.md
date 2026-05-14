# Requirements Document

## Introduction

KhipuChat operators currently have no built-in way to keep the message archive continuously up-to-date. The existing `npm run sync` performs a one-shot sequential backfill and the only path to automation is OS-level daemon setup (macOS LaunchAgent), which is complex and undiscoverable. This feature adds `npm run watch`, a long-running polling daemon that keeps every configured platform's message archive current without operator intervention.

## Boundary Context

- **In scope**: `npm run watch` daemon entry point; per-platform configurable polling interval; calling `syncIncremental` (or `runBackfill` as fallback) on each poll cycle; per-platform error isolation; skip-if-unconfigured logic; graceful shutdown on SIGINT/SIGTERM.
- **Out of scope**: Modifying any `sync:*` scripts or platform adapter internals; real-time push/webhook sync; adding new platforms; exposing a status endpoint or UI; replacing or removing the LaunchAgent setup path.
- **Adjacent expectations**: The watcher depends on each platform adapter exposing `runBackfill` and optionally `syncIncremental` (provided by the `incremental-sync` upstream spec). Credential-check logic from each adapter is reused as-is to detect unconfigured platforms.

## Requirements

### Requirement 1: Daemon Startup

**Objective:** As a KhipuChat operator, I want `npm run watch` to start a long-running daemon, so that the message archive is kept current without manual sync runs.

#### Acceptance Criteria

1. When `npm run watch` is invoked, the watch daemon shall start and emit a startup log listing each platform that will be polled and its configured interval.
2. When `npm run watch` is invoked and a platform's required credentials or configuration are absent, the watch daemon shall skip that platform and log a one-time informational message at startup indicating the platform is unconfigured.
3. The watch daemon shall begin polling all configured platforms immediately on startup without waiting for the first interval to expire.

### Requirement 2: Per-Platform Polling Loop

**Objective:** As a KhipuChat operator, I want each platform to be polled on its own configurable interval, so that more active platforms can sync more frequently without affecting others.

#### Acceptance Criteria

1. While the watch daemon is running, it shall poll each configured platform at the interval configured for that platform.
2. When a poll cycle completes and new messages were fetched, the watch daemon shall log `[platform] synced N new messages` where N is the count of new messages.
3. When a poll cycle completes and no new messages were found, the watch daemon shall log `[platform] up to date`.
4. When a platform adapter provides an incremental sync capability and a prior sync state exists, the watch daemon shall use incremental sync for that platform's poll cycle.
5. When a platform adapter does not provide an incremental sync capability, the watch daemon shall use the backfill sync for that platform's poll cycle.

### Requirement 3: Per-Platform Error Isolation

**Objective:** As a KhipuChat operator, I want a failing platform not to crash the watcher, so that other platforms continue to sync even when one has an error.

#### Acceptance Criteria

1. If a poll cycle for a platform raises an error, the watch daemon shall catch the error, log it with the platform name, and continue running.
2. If a poll cycle for a platform raises an error, the watch daemon shall not stop or affect the polling loops of other platforms.
3. While the watch daemon is running, a platform that repeatedly fails shall continue to be retried on each subsequent interval without requiring a restart.

### Requirement 4: Graceful Shutdown

**Objective:** As a KhipuChat operator, I want the watcher to shut down cleanly when I stop it, so that no in-progress sync operations are corrupted.

#### Acceptance Criteria

1. When the watch daemon receives SIGINT or SIGTERM, it shall stop scheduling new poll cycles and exit the process cleanly after any in-progress sync cycles complete.
2. When the watch daemon shuts down, it shall emit a log message confirming the shutdown.

### Requirement 5: Polling Interval Configuration

**Objective:** As a KhipuChat operator, I want to configure per-platform polling intervals via environment variables, so that I can tune sync frequency for each platform without code changes.

#### Acceptance Criteria

1. The watch daemon shall read a per-platform interval from an environment variable named `WATCH_INTERVAL_<PLATFORM>_MS` (where `<PLATFORM>` is the uppercase platform name, e.g. `WATCH_INTERVAL_TELEGRAM_MS`).
2. When no per-platform interval environment variable is set, the watch daemon shall apply a default interval of 5 minutes for that platform.
3. When a per-platform interval environment variable is set to a positive integer, the watch daemon shall use that value (in milliseconds) as the polling interval for that platform.
