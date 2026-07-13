# Implementation Plan

## Deferred / Already-Complete Requirements

- **Req 1.1, 1.4, 1.5, 1.6** (`sync_state` DDL and platform-level helper functions): already present in `src/db.ts` (confirmed by design Gap Analysis). Consumed by the sync runner in Task 2.
- **Req 2.1, 2.4** (`PlatformAdapter.syncIncremental` optional method and frozen `runBackfill` signature): already present in `src/platforms/types.ts`. This spec consumes the interface; it does not modify it.
- **Req 3.1–3.8** (per-platform incremental fetch logic): all seven `syncIncremental` implementations are already complete in the adapter layer (confirmed by research.md Gap Analysis). This spec calls them; it does not rewrite them.
- **Req 5.4** (per-chat sync timestamps): already maintained by the adapters via the existing `setLastSyncedAt(chatId)` helper; not touched by this spec.
- **Req 6.1–6.4** (per-account `sync_state` keying and migration): deferred to the `multi-account` spec. The runner calls helpers by platform only, with no assumption that blocks adding an `account` parameter later.

---

- [x] 1. Search Index — extract `rebuildEmbeddings` callable

- [x] 1.1 Extract `rebuildEmbeddings(platform?)` from `index-embeddings.ts`
  - Confirm `rebuildFtsIndex()` is already exported from `src/db.ts` and importable by `sync-runner.ts`; if not, add the export in this task
  - Pull the existing embedding batch loop out of `main()` in `src/index-embeddings.ts` into an exported async function `rebuildEmbeddings(platform?: Platform): Promise<void>`
  - With no argument: same whole-database sweep as before, preserving `npm run index:embeddings` behavior
  - With a platform argument: filter to chats and messages for that platform; join `messages` to `chats` on `chats.platform`, using the existing index on `messages(chat_id)` to avoid a full table scan
  - `main()` becomes a single `await rebuildEmbeddings()` call
  - Observable: `npm run index:embeddings` completes with the same result as before; calling `rebuildEmbeddings('telegram')` returns without error and writes only telegram rows to `vec_messages`/`vec_chats`
  - _Requirements: 4.4_
  - _Boundary: rebuildEmbeddings (src/index-embeddings.ts)_

- [x] 2. Shared sync runner — flag parsing and mode routing

- [x] 2.1 (P) Implement `parseSyncArgs` in `src/sync-runner.ts`
  - Create `src/sync-runner.ts` and export `parseSyncArgs(argv: readonly string[]): { force: boolean }`
  - `--force` sets `force: true` with no stderr output
  - `--backfill` sets `force: true` and writes a one-line deprecation warning to stderr
  - Neither flag gives `force: false`; both flags present gives `force: true`
  - Observable: `parseSyncArgs(['--force'])` returns `{ force: true }` with no stderr; `parseSyncArgs(['--backfill'])` returns `{ force: true }` and emits the deprecation line to stderr; `parseSyncArgs([])` returns `{ force: false }`
  - _Requirements: 4.3, 4.5_
  - _Boundary: parseSyncArgs (src/sync-runner.ts)_

- [x] 2.2 Implement `runPlatformSync` in `src/sync-runner.ts`
  - Import `getPlatformLastSyncedAt`, `setPlatformLastSyncedAt`, `rebuildFtsIndex` from `src/db.ts` and `rebuildEmbeddings` from `src/index-embeddings.ts`; must not import any concrete adapter (type-only import of `PlatformAdapter` from `src/platforms/types.ts`)
  - Snapshot `runStartedAt = Math.floor(Date.now() / 1000)` immediately on entry, before any fetch or state read
  - Call `parseSyncArgs(argv)` to determine the `force` flag
  - Mode selection: if `force`, call `adapter.runBackfill(db)` and print `backfill` to stdout **before** the call; else get `since = getPlatformLastSyncedAt(adapter.platform)`; if `since !== null` AND `typeof adapter.syncIncremental === 'function'`, call `adapter.syncIncremental(db, new Date(since * 1000))` and print `incremental` to stdout before the call; otherwise call `adapter.runBackfill(db)` and print `backfill` to stdout before the call
  - On clean completion (no throw): call `setPlatformLastSyncedAt(adapter.platform, runStartedAt)`; if `force` was set, also call `rebuildFtsIndex()` then `await rebuildEmbeddings(adapter.platform)`
  - On thrown error: propagate the error; do NOT write to `sync_state`
  - Observable: exactly one of `"incremental"` or `"backfill"` appears on stdout before the adapter method is invoked; given a resolving fake adapter, `sync_state` row has `last_synced_at = runStartedAt`; given a throwing fake adapter, `sync_state` is unchanged and the error propagates out
  - _Requirements: 1.2, 1.3, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 4.4, 4.7, 5.1, 5.2, 5.3_
  - _Boundary: SyncRunner (src/sync-runner.ts)_
  - _Depends: 1.1, 2.1_

- [x] 3. Platform entry points — delegate to shared runner

- [x] 3.1 (P) Delegate five simple adapter entry points to `runPlatformSync`
  - Refactor `main()` in `src/platforms/discord/sync.ts`, `slack/sync.ts`, `email/sync.ts`, `wechat/sync.ts`, and `imessage/sync.ts`
  - Each `main()`: call `initDb()`, then `await runPlatformSync(adapter, db, process.argv)`, exit 0 on success; catch, log, and exit 1 on error
  - Remove any per-adapter mode-select logic that was previously added; the runner owns that logic
  - Observable: `npx tsx src/platforms/discord/sync.ts` exits 0 and writes a `sync_state` row; running it a second time prints `incremental` to stdout before processing
  - _Requirements: 4.1, 4.2, 4.3, 4.7, 5.1, 5.2_
  - _Boundary: discord, slack, email, wechat, imessage entry points_
  - _Depends: 2.2_

- [x] 3.2 (P) Delegate WhatsApp entry point to `runPlatformSync`
  - Refactor `main()` in `src/platforms/whatsapp/sync.ts` to retain any client/QR initialization before the runner call, then `await runPlatformSync(whatsappAdapter, db, process.argv)`
  - Remove any per-adapter mode-select logic; the runner owns that logic
  - Observable: `npx tsx src/platforms/whatsapp/sync.ts` exits 0 after a sync run and writes a `sync_state` row; a second run prints `incremental`
  - _Requirements: 4.1, 4.2, 4.3, 4.7, 5.1, 5.2_
  - _Boundary: whatsapp entry point_
  - _Depends: 2.2_

- [x] 3.3 (P) Refactor telegram entry point to use `runPlatformSync`
  - Replace the broken `runSync` function in `src/platforms/telegram/sync.ts` (which always called `runBackfill`) with a `runPlatformSync` call
  - Retain the auth wizard flow and Telegram client connection lifecycle before the runner call
  - Retain `--backfill-only` gating: after the runner returns cleanly, if `--backfill-only` is present call `process.exit(0)`; otherwise invoke `startListener`
  - Observable: a sync run completes, writes `sync_state`, then either exits (with `--backfill-only`) or starts the listener; a second run without `--force` prints `incremental`, confirming the always-backfill bug is gone
  - _Requirements: 4.1, 4.2, 4.3, 4.7, 5.1, 5.2_
  - _Boundary: telegram entry point_
  - _Depends: 2.2_

- [x] 4. Aggregate orchestrator and package.json scripts

- [x] 4.1 Create `src/sync-all.ts` serial orchestrator
  - Spawn `tsx src/platforms/<p>/sync.ts` for each of the 7 platforms in a fixed serial order using Node built-in `child_process` (no new dependencies)
  - Forward `--force` and `--backfill` flags from own argv to every child subprocess; append `--backfill-only` to the telegram child's args so it exits after sync instead of blocking on the listener
  - Stream each child's stdout and stderr through to the parent process
  - Log a message when a child exits non-zero; continue to the next platform; after all 7 complete, exit non-zero overall if any child failed
  - Observable: `npx tsx src/sync-all.ts` runs all 7 platform syncs serially and exits 0 when all succeed; with a simulated failing child, the remaining platforms still run and the aggregate exits non-zero
  - _Requirements: 4.6_
  - _Boundary: AggregateOrchestrator (src/sync-all.ts)_

- [x] 4.2 Update `package.json` `sync` script
  - Change the `sync` script entry to `tsx src/sync-all.ts`
  - Verify all `sync:<platform>` scripts remain unchanged (delegation now happens inside each `main()`)
  - Observable: `npm run sync` triggers all 7 platform syncs; `npm run sync -- --force` passes `--force` through `sync-all` to each child; `npm run sync:discord` still works as before
  - _Requirements: 4.6_
  - _Boundary: package.json scripts_
  - _Depends: 4.1_

- [x] 5. Tests

- [x] 5.1 (P) Unit tests for `parseSyncArgs`
  - `['--force']` returns `{ force: true }` with no stderr
  - `['--backfill']` returns `{ force: true }` and emits the deprecation warning to stderr
  - `[]` returns `{ force: false }` with no stderr
  - `['--force', '--backfill']` returns `{ force: true }`
  - Observable: all four unit test cases pass
  - _Requirements: 4.3, 4.5_
  - _Boundary: parseSyncArgs_
  - _Depends: 2.1_

- [x] 5.2 (P) Integration tests for `runPlatformSync` mode selection and atomicity
  - Mode selection with fake adapters (four cases): (a) `since=null` selects backfill; (b) `since` set + `syncIncremental` present + no force selects incremental; (c) `since` set + adapter lacks `syncIncremental` selects backfill; (d) `force` + `since` set selects backfill
  - Stdout assertion: exactly one of `"incremental"` / `"backfill"` is printed **before** the adapter method is invoked in each case (Req 4.7 ordering)
  - Atomic write: resolving fake adapter results in `setPlatformLastSyncedAt` called with `runStartedAt`; throwing fake adapter results in no call and error propagation
  - `--force` path: `rebuildFtsIndex` and `rebuildEmbeddings(platform)` both invoked on success; neither invoked without `--force`
  - Incremental dispatch: `adapter.syncIncremental` receives `new Date(since * 1000)` as its `since` argument
  - Observable: all integration test cases pass with zero failures
  - _Requirements: 1.2, 1.3, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 4.4, 4.7, 5.1, 5.2_
  - _Boundary: SyncRunner_
  - _Depends: 2.2_

- [x] 5.3 E2E tests for `sync-all` orchestration and first-run behavior
  - sync-all: verify all 7 platform subprocesses are spawned serially; `--force` is forwarded to each child; `--backfill-only` is appended for telegram; a failing child does not abort remaining platforms; aggregate exit code is non-zero when any child failed
  - First-run flow against a temporary in-memory DB: empty `sync_state` causes `backfill` to be printed and the marker to be written; a second run causes `incremental` to be printed
  - Observable: E2E test suite passes, confirming serial execution order, flag forwarding, fault tolerance, and correct first-run / subsequent-run mode selection
  - _Requirements: 4.1, 4.2, 4.6_
  - _Boundary: AggregateOrchestrator, SyncRunner_
  - _Depends: 3.1, 3.2, 3.3, 4.1_
