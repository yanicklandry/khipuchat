# Implementation Plan

## sync-watcher

- [ ] 1. Add `watch` script to package.json and scaffold `src/watch.ts` entry point
- [x] 1.1 Add `"watch": "tsx src/watch.ts"` to package.json scripts
  - Append the `watch` entry to the `scripts` object in `package.json`.
  - Running `npm run watch` resolves to `tsx src/watch.ts` without errors.
  - _Requirements: 1.4_
  - _Boundary: package.json_

- [x] 1.2 Create `src/watch.ts` with dotenv load, DB init, and constants
  - Import `dotenv/config`, `initDb` from `src/db.ts`, and `Platform` / `PlatformAdapter` from `src/platforms/types.ts`.
  - Define `DEFAULT_INTERVAL_MS = 300_000` (5 minutes).
  - Call `initDb('./khipuchat.db')` at module startup and store the DB handle.
  - File exists at `src/watch.ts`, compiles without TypeScript errors, and `npm run watch` starts without crashing on DB init.
  - _Requirements: 1.1, 5.2_
  - _Boundary: watch.ts_

- [ ] 2. Implement core poll-cycle helpers
- [x] 2.1 Implement `getIntervalMs(platform)` helper
  - Read `` process.env[`WATCH_INTERVAL_${platform.toUpperCase()}_MS`] ``.
  - Parse as integer; return the parsed value if it is a positive finite number, otherwise return `DEFAULT_INTERVAL_MS`.
  - `getIntervalMs('telegram')` returns 300000 when env var is unset; returns the env var integer value when set.
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: watch.ts_

- [x] 2.2 Implement `isConfigured(platform)` credential check
  - For each platform in the `Platform` union, inspect the known required env vars (e.g., `TELEGRAM_SESSION` for telegram, `DISCORD_TOKEN` for discord, `SLACK_TOKEN` for slack, `EMAIL_USER` / `EMAIL_PASSWORD` for email, `WHATSAPP_SESSION` for whatsapp; iMessage and WeChat are file-system-based and return `true` unconditionally).
  - Returns `true` if required env vars are non-empty strings, `false` otherwise.
  - `isConfigured('discord')` returns `false` when `DISCORD_TOKEN` is unset; returns `true` when set.
  - _Requirements: 1.2_
  - _Boundary: watch.ts_

- [x] 2.3 Implement `pollCycle(adapter, db)` with routing and error isolation
  - Call `getPlatformLastSyncedAt(adapter.platform)` to get `since` (null or Unix seconds number).
  - If `adapter.syncIncremental` is defined and `since` is non-null, call `adapter.syncIncremental(db, new Date(since * 1000))`; otherwise call `adapter.runBackfill(db)`.
  - Count messages inserted during the cycle by querying `SELECT COUNT(*) FROM messages WHERE platform = ?` before and after; log `[platform] synced N new messages` if N > 0, else `[platform] up to date`.
  - Wrap the entire body in try/catch; on error, log `[platform] error: <error.message>` to stderr and return without rethrowing.
  - Increment an `inFlight` counter before the async call and decrement it in a `finally` block.
  - `pollCycle` never throws; the `inFlight` counter returns to its prior value after each call.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3_
  - _Boundary: watch.ts_

- [x] 2.4 Add embedding indexing step within pollCycle
  - After a successful sync that fetched one or more new messages, call the embedding indexing function for those messages before the cycle resolves.
  - Skip the indexing call when the cycle fetched zero new messages.
  - Wrap the indexing call in its own try/catch; on error log `[platform] index error: <error.message>` and continue (same isolation as sync errors).
  - `pollCycle` resolves normally even when the indexing step throws; the `inFlight` counter is still decremented in the outer `finally` block.
  - _Requirements: 6.1, 6.2, 6.3_
  - _Boundary: watch.ts_
  - _Depends: 2.3_

- [ ] 3. Implement daemon startup loop
- [x] 3.1 Build platform and account registry; detect unconfigured pairs at startup
  - Import all platform adapter objects from `src/platforms/*/sync.ts` into `watch.ts`.
  - For each platform, retrieve the list of configured accounts from the account registry and iterate over each platform/account pair independently (req 2.6).
  - Call `isConfigured(platform)` for each pair; for unconfigured pairs log `[platform] skipped: not configured (missing credentials)` and exclude from the active registry.
  - For configured pairs, call `getIntervalMs(platform)` and log `[platform] polling every Xms`.
  - Running `npm run watch` with no platforms configured logs all platforms as skipped and exits cleanly (no crash).
  - _Requirements: 1.1, 1.2, 2.6_
  - _Boundary: watch.ts_

- [x] 3.2 Schedule polling intervals and trigger immediate first poll
  - For each configured platform/account pair, call `pollCycle(adapter, db)` once immediately (do not await; fire-and-forget to avoid blocking startup).
  - Set up `setInterval(() => pollCycle(adapter, db), intervalMs)` for each configured pair and store the timer handle.
  - All configured platforms begin their first poll immediately on startup without waiting for the first interval.
  - _Requirements: 1.3, 2.1_
  - _Boundary: watch.ts_

- [ ] 4. Implement graceful shutdown handler
- [x] 4.1 Register SIGINT/SIGTERM handlers with drain-and-exit logic
  - Register `process.on('SIGINT', shutdown)` and `process.on('SIGTERM', shutdown)` handlers.
  - `shutdown()` sets a `shutdownRequested` flag, calls `clearInterval` for all stored timer handles, and logs `Watch daemon shutting down...`.
  - Wait for `inFlight` to reach 0, polling every 100ms; after 30 seconds, proceed regardless.
  - Log `Watch daemon stopped.` and call `process.exit(0)`.
  - Sending SIGINT to `npm run watch` results in a clean exit (exit code 0) and both shutdown log lines appear in stdout.
  - _Requirements: 4.1, 4.2_
  - _Boundary: watch.ts_

- [ ] 5. Implement single-pass mode (`--once`)
- [x] 5.1 Detect `--once` flag and run one sync+index pass then exit
  - Detect `process.argv.includes('--once')` at startup before any interval scheduling.
  - When `--once` is set, skip `setInterval` scheduling and instead run one `pollCycle` call per configured platform/account pair using `Promise.all`.
  - Wrap each call in its own try/catch within the single-pass loop; log errors and continue with remaining platforms rather than aborting.
  - After all platforms complete, log `Watch daemon: single-pass complete.` and call `process.exit(0)`.
  - Running with `--once` exits after exactly one sync+index pass over all configured platforms with no lingering intervals.
  - _Requirements: 7.1, 7.2, 7.3_
  - _Boundary: watch.ts_
  - _Depends: 3.1, 2.3, 2.4_

- [ ] 6. Write unit and integration tests
- [x] 6.1 (P) Unit test `getIntervalMs`
  - Test: returns 300000 when env var is absent.
  - Test: returns parsed integer when env var is a valid positive integer string.
  - Test: returns 300000 when env var is set to a non-numeric string.
  - All three cases pass in `vitest run`.
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: watch.test.ts_

- [x] 6.2 (P) Unit test `pollCycle` routing, indexing, and error isolation
  - Test: when adapter has `syncIncremental` and `getPlatformLastSyncedAt` returns a number, `syncIncremental` is called.
  - Test: when adapter lacks `syncIncremental`, `runBackfill` is called.
  - Test: when `syncIncremental` throws, the error is caught, logged, and `pollCycle` resolves without rethrowing.
  - Test: `inFlight` counter is 0 after `pollCycle` resolves regardless of success or error.
  - Test: when new messages are fetched, the indexing function is called; it is skipped when no new messages were fetched.
  - Test: when the indexing step throws, `pollCycle` still resolves and the error is logged.
  - All cases pass in `vitest run`.
  - _Requirements: 2.4, 2.5, 3.1, 6.1, 6.2, 6.3_
  - _Boundary: watch.test.ts_

- [x] 6.3 (P) Integration test startup, error isolation, and single-pass mode
  - Test: with a mock registry of one configured and one unconfigured adapter, the configured adapter's `pollCycle` is called immediately and the unconfigured adapter is skipped with a log message.
  - Test: if one adapter's `pollCycle` throws on every invocation, a second adapter's poll cycles still execute normally.
  - Test: running with `--once` executes one pass over all configured platforms and exits without scheduling intervals.
  - All cases pass in `vitest run`.
  - _Requirements: 1.2, 1.3, 3.2, 3.3, 7.1, 7.2_
  - _Boundary: watch.test.ts_
  - _Depends: 6.1, 6.2_
