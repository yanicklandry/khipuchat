# Implementation Plan

## sync-watcher

- [ ] 1. Add `watch` script to package.json and scaffold `src/watch.ts` entry point
- [x] 1.1 Add `"watch": "tsx src/watch.ts"` to package.json scripts
  - Append the `watch` entry to the `scripts` object in `package.json`.
  - Running `npm run watch` resolves to `tsx src/watch.ts` without errors.
  - _Requirements: 1.4_
  - _Boundary: package.json_

- [x] 1.2 Create `src/watch.ts` with dotenv load, DB init, constants, and ADAPTER_FACTORIES map
  - Import `dotenv/config`, `initDb` from `src/db.ts`, and `Platform` / `PlatformAdapter` from `src/platforms/types.ts`.
  - Define `DEFAULT_INTERVAL_MS = 300_000` (5 minutes).
  - Call `initDb('./khipuchat.db')` at module startup and store the DB handle.
  - Define `ADAPTER_FACTORIES: Record<Platform, AdapterFactory>` including a `createWechatAdapter` wrapper over the WeChat singleton so the loop has no special cases.
  - File exists at `src/watch.ts`, compiles without TypeScript errors, and `npm run watch` starts without crashing on DB init.
  - _Requirements: 1.1, 5.2_
  - _Boundary: watch.ts_

- [ ] 2. Implement core poll-cycle helpers
- [x] 2.1 Implement `getIntervalMs(platform)` helper
  - Read `` process.env[`WATCH_INTERVAL_${platform.toUpperCase()}_MS`] ``.
  - Parse as integer; return the parsed value if it is a positive finite number, otherwise return `DEFAULT_INTERVAL_MS`.
  - `getIntervalMs('telegram')` returns 300000 when env var is unset; returns the env var integer value when set to a valid positive integer.
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: watch.ts_

- [x] 2.2 Implement `isConfigured(platform)` credential check
  - For each platform in the `Platform` union, inspect the known required env vars (e.g. `TELEGRAM_SESSION` for telegram, `DISCORD_TOKEN` for discord, `SLACK_TOKEN` for slack, `EMAIL_USER`/`EMAIL_PASSWORD` for email, `BEEPER_ACCESS_TOKEN` for signal; imessage, whatsapp, and wechat are local-only and always return `true`).
  - Returns `true` if required env vars are non-empty strings, `false` otherwise.
  - `isConfigured('discord')` returns `false` when `DISCORD_TOKEN` is unset; returns `true` when set.
  - _Requirements: 1.2_
  - _Boundary: watch.ts_

- [x] 2.3 Implement `pollCycle(adapter, db)` with account-scoped message counting, sync routing, and error isolation
  - Call `getPlatformLastSyncedAt(adapter.platform, adapter.account)` to get `since` (null or Unix seconds number).
  - If `adapter.syncIncremental` is defined and `since` is non-null, call `adapter.syncIncremental(db, new Date(since * 1000))`; otherwise call `adapter.runBackfill(db)`.
  - Count messages with `SELECT COUNT(*) FROM messages WHERE platform = ? AND account = ?` bound to both `adapter.platform` and `adapter.account` before and after the sync; this scoping correctly isolates each account's delta when multiple accounts of the same platform run concurrently.
  - Log `[platform/account] synced N new messages` when `newMessages > 0`; log `[platform/account] up to date` otherwise.
  - Wrap the entire body in try/catch; on error, log `[platform/account] error: <error.message>` to stderr and return without rethrowing.
  - Track in-flight calls with an `inFlight` counter incremented before the body and decremented in a `finally` block.
  - `pollCycle` never throws; the `inFlight` counter returns to its prior value after each call regardless of success or error.
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3_
  - _Boundary: watch.ts_

- [x] 2.4 Add embedding indexing step within pollCycle
  - After a successful sync that fetched one or more new messages, call `rebuildEmbeddings(adapter.platform)` before the cycle resolves (sync then index then return).
  - Skip the indexing call entirely when `newMessages === 0`.
  - Wrap the indexing call in its own try/catch; on error log `[platform/account] index error: <error.message>` and continue.
  - `pollCycle` resolves normally even when the indexing step throws; the `inFlight` counter is still decremented in the outer `finally` block.
  - _Requirements: 6.1, 6.2, 6.3_
  - _Boundary: watch.ts_
  - _Depends: 2.3_

- [ ] 3. Implement daemon startup loop
- [x] 3.1 Build active adapter list from the account registry; skip and log unconfigured pairs
  - Call `loadRegistry()` then iterate `PLATFORMS` from `src/sync-all.ts`.
  - For each platform, call `isConfigured(platform)` and `listAccounts(platform)`; skip with `[platform] skipped: not configured (missing credentials)` if either check fails.
  - For each configured (platform, account) pair, call `credentialsFor(platform, account)` and instantiate the adapter via `ADAPTER_FACTORIES[platform]`.
  - Running `npm run watch` with no platforms configured logs all platforms as skipped and idles cleanly (no crash).
  - _Requirements: 1.1, 1.2, 2.6_
  - _Boundary: watch.ts_

- [x] 3.2 Schedule per-platform/account polling intervals and trigger immediate first poll
  - For each configured adapter, call `getIntervalMs(platform)` and log `[platform/account] polling every Xms`.
  - Call `pollCycle(adapter, db)` once immediately (fire-and-forget, do not await) so the first sync starts on startup without waiting for the first interval.
  - Register `setInterval(() => pollCycle(adapter, db), intervalMs)` and store each timer handle.
  - All configured platforms begin their first poll immediately on startup without waiting for the first interval to expire.
  - _Requirements: 1.3, 2.1_
  - _Boundary: watch.ts_

- [ ] 4. Implement graceful shutdown handler
- [x] 4.1 Register SIGINT/SIGTERM handlers with in-flight drain and clean exit
  - Register `process.on('SIGINT', shutdown)` and `process.on('SIGTERM', shutdown)` handlers.
  - `shutdown()` guards against re-entry with a `shutdownRequested` flag, calls `clearInterval` for all stored timer handles, and logs `Watch daemon shutting down...`.
  - Poll `inFlight` every 100ms until it reaches 0 or a 30-second deadline passes, then call `process.exit(0)`.
  - Log `Watch daemon stopped.` immediately before `process.exit(0)`.
  - Sending SIGINT to `npm run watch` results in a clean exit (exit code 0) with both shutdown log lines in stdout.
  - _Requirements: 4.1, 4.2_
  - _Boundary: watch.ts_

- [ ] 5. Implement single-pass mode (`--once`)
- [x] 5.1 Detect `--once` flag and run one sync+index pass then exit
  - Detect `process.argv.includes('--once')` at startup before any interval scheduling.
  - When `--once` is set, skip `setInterval` scheduling; instead run one `pollCycle` per configured adapter via `Promise.all`.
  - Wrap each per-adapter call in its own try/catch; log errors and continue with the remaining adapters rather than aborting the pass.
  - After all adapters complete, log `Watch daemon: single-pass complete.` and call `process.exit(0)`.
  - Running with `--once` exits after exactly one sync+index pass over all configured platforms with no lingering intervals.
  - _Requirements: 7.1, 7.2, 7.3_
  - _Boundary: watch.ts_
  - _Depends: 3.1, 2.3, 2.4_

- [x] 6. Route `khipu sync all` to the daemon in `src/khipu.ts`
  - In `src/khipu.ts`, detect the `sync all` subcommand (second argv token is `all`) and import/invoke the daemon entry point from `src/watch.ts`.
  - Expose the `--once` flag in the `khipu sync all` usage or help text.
  - Running `khipu sync all` and `npm run watch` produce identical daemon behaviour (both reach `watch.ts`).
  - _Requirements: 1.4_
  - _Boundary: src/khipu.ts_

- [ ] 7. Write unit and integration tests
- [x] 7.1 (P) Unit test `getIntervalMs`
  - Test: returns 300000 when env var is absent.
  - Test: returns parsed integer when env var is a valid positive integer string.
  - Test: returns 300000 when env var is set to a non-numeric or non-positive string.
  - All three cases pass in `vitest run`.
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: watch.test.ts_

- [ ] 7.4 (P) Unit test `isConfigured`
  - Test: returns `false` when a network platform's required env vars are all absent or empty strings.
  - Test: returns `true` when at least one required env var for a network platform is set to a non-empty string.
  - Test: returns `true` unconditionally for local-only platforms (imessage, whatsapp, wechat).
  - All three cases pass in `vitest run`.
  - _Requirements: 1.2_
  - _Boundary: watch.test.ts_

- [x] 7.2 (P) Unit test `pollCycle` routing, indexing, and error isolation
  - Test: when adapter has `syncIncremental` and `getPlatformLastSyncedAt` returns a number, `syncIncremental` is called.
  - Test: when adapter lacks `syncIncremental`, `runBackfill` is called.
  - Test: account-scoped message counting (`WHERE platform = ? AND account = ?`) reports the correct per-account delta N.
  - Test: when `syncIncremental` throws, the error is caught, logged, and `pollCycle` resolves without rethrowing.
  - Test: `inFlight` counter is 0 after `pollCycle` resolves regardless of success or error.
  - Test: when new messages are fetched, `rebuildEmbeddings` is called; it is skipped when no new messages were fetched.
  - Test: when the indexing step throws, `pollCycle` still resolves and the error is logged.
  - All cases pass in `vitest run`.
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 3.1, 6.1, 6.2, 6.3_
  - _Boundary: watch.test.ts_

- [x] 7.3 (P) Integration test startup, error isolation, and single-pass mode
  - Test: with a mock registry of one configured and one unconfigured adapter, the configured adapter's `pollCycle` is called immediately and the unconfigured adapter is skipped with a log message.
  - Test: if one adapter throws on every poll, a second adapter's cycles still execute normally.
  - Test: running with `--once` executes one pass over all configured adapters and exits without scheduling intervals; a throwing adapter does not prevent the others from completing.
  - Test: graceful shutdown clears all timers, drains in-flight cycles, and emits both shutdown log lines before exit.
  - All cases pass in `vitest run`.
  - _Requirements: 1.2, 1.3, 3.2, 3.3, 4.1, 4.2, 7.1, 7.2, 7.3_
  - _Boundary: watch.test.ts_
  - _Depends: 7.1, 7.2_
