# Implementation Plan

## Deferred / Already-Complete Requirements

- **Req 1.1, 1.4, 1.5, 1.6** (`sync_state` DDL and platform-level helper functions): Implemented and tested in Task 1 below.
- **Req 2.1, 2.4** (`PlatformAdapter` interface extension and frozen `runBackfill` signature): Implemented in Task 2 below.
- **Req 3.1-3.8** (per-platform incremental fetch logic): All seven `syncIncremental` implementations are already complete in the adapter layer (confirmed by research.md Gap Analysis). Marked complete in Task 4 below; this spec calls them, it does not rewrite them.
- **Req 5.4** (per-chat sync timestamps): Already maintained by the adapters and per-chat `setLastSyncedAt` helpers; not touched by this spec.
- **Req 6.1-6.4** (per-account `sync_state` keying and migration): Deferred to the `multi-account` spec. This spec's runner is forward-compatible: it calls helpers by platform only, with no assumption that blocks adding an `account` parameter later.

---

## Task 1: DB Layer — sync_state table and platform-level helpers

- [x] 1.1 Add sync_state table to createSchema and expose platform-level helper functions
  - Add `CREATE TABLE IF NOT EXISTS sync_state (platform TEXT NOT NULL PRIMARY KEY, last_synced_at INTEGER NOT NULL)` inside `createSchema` in `src/db.ts`
  - Add `getPlatformLastSyncedAt(platform: Platform): number | null` — `SELECT last_synced_at FROM sync_state WHERE platform = ?`, returns null if no row
  - Add `setPlatformLastSyncedAt(platform: Platform, timestamp: number): void` — `INSERT OR REPLACE INTO sync_state ...`
  - Export both new functions; do NOT rename or touch existing `setLastSyncedAt(chatId, timestamp)` for per-chat use
  - Observable: `initDb(':memory:')` creates the `sync_state` table; `getPlatformLastSyncedAt('telegram')` returns null; after `setPlatformLastSyncedAt('telegram', 1000)`, returns 1000
  - _Requirements: 1.1, 1.4, 1.5, 1.6, 5.3_
  - _Boundary: DB Layer (src/db.ts)_

- [x] 1.2 Write unit tests for sync_state helpers
  - Test `getPlatformLastSyncedAt` returns null for unknown platform and correct value after upsert
  - Test `setPlatformLastSyncedAt` overwrites on second call (upsert semantics)
  - Test that `sync_state` table is present after `initDb(':memory:')`
  - Observable: all new tests pass with `npm test`
  - _Requirements: 1.1, 1.4, 1.5, 1.6_
  - _Boundary: DB Layer (src/db.ts)_

## Task 2: Interface — optional syncIncremental on PlatformAdapter

- [x] 2.1 Extend PlatformAdapter with optional syncIncremental method
  - Add `syncIncremental?(db: Database.Database, since: Date): Promise<void>` to the `PlatformAdapter` interface in `src/platforms/types.ts`
  - No adapter implementations changed in this task — only the interface declaration
  - Observable: TypeScript compiles without errors after the interface change; existing adapter objects (which omit `syncIncremental`) still satisfy the interface
  - _Requirements: 2.1, 2.4_
  - _Boundary: PlatformAdapter interface (src/platforms/types.ts)_

## Task 3: Shared sync runner — flag parsing and mode routing

- [ ] 3.1 (P) Extract `rebuildEmbeddings(platform?)` from `index-embeddings.ts`
  - Pull the existing embedding batch loop out of `main()` into a named exported async function `rebuildEmbeddings(platform?: Platform): Promise<void>`
  - With no argument the function behaves exactly as before (whole-database sweep), preserving `npm run index:embeddings`
  - With a platform argument the sweep filters to chats and messages for that platform; use the existing index on `messages(chat_id)` by joining messages to chats on `chats.platform`
  - `main()` becomes a single `await rebuildEmbeddings()` call
  - Observable: `npm run index:embeddings` completes successfully; a direct `rebuildEmbeddings('telegram')` returns without error and touches only telegram rows in `vec_messages`/`vec_chats`
  - _Requirements: 4.4_
  - _Boundary: rebuildEmbeddings (Search Index)_

- [ ] 3.2 (P) Implement `parseSyncArgs` in `src/sync-runner.ts`
  - Create `src/sync-runner.ts` and export `parseSyncArgs(argv: readonly string[]): { force: boolean }`
  - `--force` sets `force: true` with no stderr output
  - `--backfill` sets `force: true` and writes a one-line deprecation warning to stderr
  - Neither flag gives `force: false`; both flags present gives `force: true`
  - Observable: `parseSyncArgs(['--force'])` returns `{ force: true }` with no stderr; `parseSyncArgs(['--backfill'])` returns `{ force: true }` and emits the deprecation line to stderr; `parseSyncArgs([])` returns `{ force: false }`
  - _Requirements: 4.3, 4.5_
  - _Boundary: parseSyncArgs (SyncRunner)_

- [ ] 3.3 Implement `runPlatformSync` in `src/sync-runner.ts`
  - Snapshot `runStartedAt` (Unix seconds, `Math.floor(Date.now() / 1000)`) immediately on entry, before any fetch or state read
  - Call `parseSyncArgs(argv)` to determine the `force` flag
  - Mode selection: if `force`, route to `adapter.runBackfill(db)` and print `backfill`; else call `getPlatformLastSyncedAt(adapter.platform)` to get `since`; if `since !== null` AND `typeof adapter.syncIncremental === 'function'`, route to `adapter.syncIncremental(db, new Date(since * 1000))` and print `incremental`; otherwise route to `adapter.runBackfill(db)` and print `backfill`
  - Print the mode string to stdout before invoking the adapter method
  - On clean completion (no throw): call `setPlatformLastSyncedAt(adapter.platform, runStartedAt)`; if `force` was set, also call `rebuildFtsIndex()` then `await rebuildEmbeddings(adapter.platform)`
  - On any thrown error: propagate the error to the caller and do NOT write to `sync_state`
  - Must not import any concrete adapter; operates solely on the `PlatformAdapter` type
  - Observable: given a fake adapter that resolves, `sync_state` contains a row with `last_synced_at` equal to `runStartedAt`; given a fake adapter that throws, `sync_state` is unchanged and the error propagates out of `runPlatformSync`
  - _Requirements: 1.2, 1.3, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 4.4, 4.7, 5.1, 5.2, 5.3_
  - _Boundary: SyncRunner_
  - _Depends: 3.1, 3.2_

## Task 4: Per-platform syncIncremental implementations (already complete)

- [x] 4.1 (P) Telegram: implement syncIncremental
  - _Requirements: 2.1, 3.1_
  - _Boundary: TelegramAdapter (telegram/sync.ts)_

- [x] 4.2 (P) iMessage: implement syncIncremental
  - _Requirements: 2.1, 3.2_
  - _Boundary: iMessageAdapter (imessage/sync.ts)_

- [x] 4.3 (P) WeChat: implement syncIncremental
  - _Requirements: 2.1, 3.3_
  - _Boundary: WechatAdapter (wechat/sync.ts)_

- [x] 4.4 (P) Discord: implement syncIncremental
  - _Requirements: 2.1, 3.4_
  - _Boundary: DiscordAdapter (discord/sync.ts)_

- [x] 4.5 (P) Slack: implement syncIncremental
  - _Requirements: 2.1, 3.5_
  - _Boundary: SlackAdapter (slack/sync.ts)_

- [x] 4.6 (P) Email: implement syncIncremental
  - _Requirements: 2.1, 3.6_
  - _Boundary: EmailAdapter (email/sync.ts)_

- [x] 4.7 (P) WhatsApp: implement syncIncremental with client-side filter
  - _Requirements: 2.1, 3.7, 3.8_
  - _Boundary: WhatsAppAdapter (whatsapp/sync.ts)_

## Task 5: Refactor platform entry points to delegate to runPlatformSync

- [ ] 5.1 (P) Delegate six simple adapter entry points to the shared runner
  - Refactor `main()` in `src/platforms/discord/sync.ts`, `slack/sync.ts`, `email/sync.ts`, `whatsapp/sync.ts`, `wechat/sync.ts`, and `imessage/sync.ts`
  - Each `main()` calls `initDb()`, then `await runPlatformSync(adapter, db, process.argv)`, exits 0 on success; catches, logs, and exits 1 on error
  - WhatsApp retains any client/QR initialization before the `runPlatformSync` call; other adapters need no preamble
  - Remove any per-adapter mode-select logic that was added in earlier iterations; the runner owns that logic now
  - Observable: `npx tsx src/platforms/discord/sync.ts` exits 0 and writes a `sync_state` row; running it a second time prints `incremental` to stdout before processing
  - _Requirements: 4.1, 4.2, 4.3, 4.7, 5.1, 5.2_
  - _Boundary: discord, slack, email, whatsapp, wechat, imessage entry points_
  - _Depends: 3.3_

- [ ] 5.2 Refactor telegram entry point to use the shared runner
  - Replace the broken `runSync` function (which always called `runBackfill`) in `src/platforms/telegram/sync.ts` with a `runPlatformSync` call
  - Retain the auth wizard flow and Telegram client connection lifecycle before the runner call
  - Retain `--backfill-only` gating: when the flag is present, the runner completes and `process.exit(0)`; otherwise `startListener` is invoked after the runner returns
  - Observable: `npx tsx src/platforms/telegram/sync.ts` completes a sync, writes `sync_state`, and either exits (with `--backfill-only`) or starts the listener; a second run without `--force` prints `incremental`, confirming the always-backfill bug is gone
  - _Requirements: 4.1, 4.2, 4.3, 4.7, 5.1, 5.2_
  - _Boundary: telegram entry point_
  - _Depends: 3.3_

## Task 6: Aggregate orchestrator and package.json

- [ ] 6.1 Create `src/sync-all.ts` serial orchestrator
  - Implement a script that spawns `tsx src/platforms/<p>/sync.ts` for each of the 7 platforms in a fixed serial order using Node built-in `child_process`
  - Forward `--force` and `--backfill` flags from own argv to every child subprocess
  - Append `--backfill-only` to the telegram child's args so it exits after sync instead of blocking on the listener
  - Stream each child's stdout and stderr through to the parent process
  - Log a message when a child exits non-zero; continue to the next platform; after all platforms complete, exit non-zero if any child failed
  - Observable: `npx tsx src/sync-all.ts` runs all 7 platform syncs serially and exits 0 when all succeed; with a simulated failing child, the remaining platforms still run and the aggregate exits non-zero
  - _Requirements: 4.6_
  - _Boundary: AggregateOrchestrator_

- [ ] 6.2 Update `package.json` `sync` script
  - Change the `sync` script entry to `tsx src/sync-all.ts`
  - Verify all `sync:<platform>` scripts remain unchanged (delegation now happens inside each `main()`)
  - Observable: `npm run sync` triggers all 7 platform syncs; `npm run sync -- --force` passes `--force` through sync-all to each child; `npm run sync:discord` still works as before
  - _Requirements: 4.6_
  - _Boundary: package.json scripts_
  - _Depends: 6.1_

## Task 7: Tests

- [ ] 7.1 (P) Unit tests for `parseSyncArgs`
  - `['--force']` returns `{ force: true }` with no stderr
  - `['--backfill']` returns `{ force: true }` and emits the deprecation warning to stderr
  - `[]` returns `{ force: false }` with no stderr
  - `['--force', '--backfill']` returns `{ force: true }`
  - Observable: all four unit test cases pass
  - _Requirements: 4.3, 4.5_
  - _Boundary: parseSyncArgs_

- [ ] 7.2 (P) Integration tests for `runPlatformSync` mode selection and atomicity
  - Mode selection (four cases with fake adapter): (a) `since=null` selects backfill; (b) `since` set + `syncIncremental` present + no force selects incremental; (c) `since` set + adapter lacks `syncIncremental` selects backfill; (d) `force` + `since` set selects backfill
  - Stdout assertion: exactly one of `"incremental"` / `"backfill"` is printed before the adapter call in each case
  - Atomic write: fake adapter resolves => `setPlatformLastSyncedAt` called with `runStartedAt`; fake adapter throws => not called and error propagates
  - `--force` path: `rebuildFtsIndex` and `rebuildEmbeddings(platform)` both invoked on success; neither invoked without `--force`
  - Incremental dispatch: `adapter.syncIncremental` receives `new Date(since * 1000)` as its `since` argument
  - Observable: all integration test cases pass with zero failures
  - _Requirements: 1.2, 1.3, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 4.4, 4.7, 5.1, 5.2_
  - _Boundary: SyncRunner_
  - _Depends: 3.3_

- [ ] 7.3 E2E tests for sync-all orchestration and first-run behavior
  - sync-all: verify all 7 platform subprocesses are spawned serially; `--force` is forwarded to each child; `--backfill-only` is appended for telegram; a failing child does not abort remaining platforms; aggregate exit code is non-zero when any child failed
  - First-run flow against a temporary in-memory DB: empty `sync_state` causes `backfill` to be printed and the marker to be written; a second run prints `incremental`
  - Observable: E2E test suite passes, confirming serial execution order, flag forwarding, fault tolerance, and correct first-run / subsequent-run mode selection
  - _Requirements: 4.1, 4.2, 4.6_
  - _Boundary: AggregateOrchestrator, SyncRunner_
  - _Depends: 5.1, 5.2, 6.1_
