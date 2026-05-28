# Implementation Plan

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

## Task 3: CLI mode-select pattern and aggregate sync script

- [ ] 3.1 Implement --backfill flag and mode-select logic in telegram adapter main()
  - Parse `--backfill` from `process.argv` in `main()` in `src/platforms/telegram/sync.ts`
  - Call `getPlatformLastSyncedAt('telegram')` after `initDb`
  - If `--backfill` OR no prior timestamp: call `runBackfill`; else call `adapter.syncIncremental(db, since)`
  - Log `[telegram] sync mode: incremental` or `[telegram] sync mode: backfill` before the sync starts
  - Wrap the sync call in try/catch: call `setPlatformLastSyncedAt('telegram', Math.floor(Date.now() / 1000))` only if no exception is thrown; on error log to stderr and exit 1
  - Observable: running with `--backfill` logs `sync mode: backfill`; running without flag after a prior sync logs `sync mode: incremental`; a thrown error leaves `sync_state` unchanged
  - _Requirements: 4.1, 4.2, 4.3, 4.5, 5.1, 5.2_
  - _Boundary: CLI mode-select (telegram/sync.ts main())_
  - _Depends: 1.1, 2.1_

- [ ] 3.2 (P) Apply same mode-select pattern to imessage, wechat, discord, slack, email, whatsapp adapter main() functions
  - Replicate the exact mode-select pattern from 3.1 in each of the remaining six adapter `main()` functions
  - Each uses its own `Platform` literal (`'imessage'`, `'wechat'`, etc.)
  - Observable: each `sync:*` script logs the correct mode; `sync_state` row is created on first successful run; missing `syncIncremental` on the adapter falls back to `runBackfill` (requirement 2.3)
  - _Requirements: 2.2, 2.3, 4.1, 4.2, 4.3, 4.5, 5.1, 5.2_
  - _Boundary: CLI mode-select (each adapter main())_
  - _Depends: 1.1, 2.1_

- [ ] 3.3 Update aggregate npm run sync script to support --backfill pass-through
  - Update the `"sync"` script in `package.json` to forward `--backfill` when present, or introduce a thin `src/sync.ts` runner that reads `--backfill` once and calls each adapter sequentially with the flag
  - Observable: `npm run sync -- --backfill` runs all adapters in backfill mode; `npm run sync` runs all in incremental mode
  - _Requirements: 4.4_
  - _Boundary: CLI (package.json / src/sync.ts)_
  - _Depends: 3.1, 3.2_

## Task 4: Per-platform syncIncremental implementations

- [ ] 4.1 (P) Telegram: implement syncIncremental
  - Add `async syncIncrementalImpl(client, since: Date)` in `src/platforms/telegram/sync.ts`
  - Convert `since` to Unix seconds: `sinceTs = Math.floor(since.getTime() / 1000)`
  - Reuse existing dialog iteration; skip dialogs where `dialogDate <= sinceTs`; paginate forward from `lastId` per chat (this path already exists in `runBackfill` — extract it as the incremental path driven by `since`)
  - Wire `syncIncrementalImpl` to the adapter object as `syncIncremental(db, since)`
  - Observable: after a prior run stores `sync_state`, calling `syncIncremental` with `since = new Date(priorTimestamp * 1000)` skips all dialogs with no activity since that time; newly added messages in a test dialog are fetched
  - _Requirements: 2.1, 3.1_
  - _Boundary: TelegramAdapter (telegram/sync.ts)_
  - _Depends: 2.1_

- [ ] 4.2 (P) iMessage: implement syncIncremental
  - Add `async syncIncrementalImpl(chatDb, since: Date)` in `src/platforms/imessage/sync.ts`
  - Convert `since` to Cocoa nanoseconds: `cocoaThreshold = BigInt(Math.floor(since.getTime() / 1000) - 978307200) * 1_000_000_000n`
  - Pass `cocoaThreshold` to the existing `WHERE date > ?` query path already inside `runBackfillImpl`
  - Wire to adapter object as `syncIncremental(db, since)` — opens `chat.db` as usual, calls `syncIncrementalImpl(chatDb, since)`
  - Observable: unit test with in-memory SQLite fixture containing messages before and after threshold returns only messages after threshold
  - _Requirements: 2.1, 3.2_
  - _Boundary: iMessageAdapter (imessage/sync.ts)_
  - _Depends: 2.1_

- [ ] 4.3 (P) WeChat: implement syncIncremental
  - Add `async syncIncrementalImpl(messageDbs, contactMap, keyMap, userDir, since: Date)` in `src/platforms/wechat/sync.ts`
  - Pass `since.getTime() / 1000` as Unix seconds threshold; the existing `buildSchemaInfo` provides `timeCol`; use `WHERE "${timeCol}" > ${sinceTs}` for all tables
  - Wire to adapter object as `syncIncremental(db, since)`
  - Observable: passing a `since` date into the incremental function produces a `WHERE create_time >` or `WHERE CreateTime >` clause in the query (verifiable via test spy or in-memory DB)
  - _Requirements: 2.1, 3.3_
  - _Boundary: WechatAdapter (wechat/sync.ts)_
  - _Depends: 2.1_

- [ ] 4.4 (P) Discord: implement syncIncremental
  - Add `dateToDiscordSnowflake(date: Date): string` helper in `src/platforms/discord/sync.ts`: `((BigInt(date.getTime()) - 1420070400000n) << 22n).toString()`
  - Add `async syncIncrementalImpl(client: DiscordClient, since: Date)` that iterates channels and passes `after: dateToDiscordSnowflake(since)` to the messages fetch
  - Wire to adapter object as `syncIncremental(db, since)`
  - Observable: unit test for `dateToDiscordSnowflake` produces the expected snowflake for a known date; integration test verifies `after` param is passed to the client
  - _Requirements: 2.1, 3.4_
  - _Boundary: DiscordAdapter (discord/sync.ts)_
  - _Depends: 2.1_

- [ ] 4.5 (P) Slack: implement syncIncremental
  - Add `async syncIncrementalImpl(client: SlackClient, since: Date)` in `src/platforms/slack/sync.ts`
  - Pass `oldest: (since.getTime() / 1000).toString()` to `conversations.history` calls
  - Wire to adapter object as `syncIncremental(db, since)`
  - Observable: unit test with mocked Slack client verifies `oldest` parameter equals expected Unix seconds string for a given `since` Date
  - _Requirements: 2.1, 3.5_
  - _Boundary: SlackAdapter (slack/sync.ts)_
  - _Depends: 2.1_

- [ ] 4.6 (P) Email: implement syncIncremental
  - Add `async syncIncrementalImpl(client: EmailClient, userEmail: string, since: Date)` in `src/platforms/email/sync.ts`
  - Pass `{ since }` as search criteria to `imapflow` `client.search()` for each folder
  - Wire to adapter object as `syncIncremental(db, since)`
  - Observable: unit test with mocked imapflow client verifies `search` is called with `{ since: <Date> }`
  - _Requirements: 2.1, 3.6_
  - _Boundary: EmailAdapter (email/sync.ts)_
  - _Depends: 2.1_

- [ ] 4.7 (P) WhatsApp: implement syncIncremental with client-side filter
  - Add `async syncIncrementalImpl(client: WhatsAppClient, since: Date)` in `src/platforms/whatsapp/sync.ts`
  - Log once: `[whatsapp] incremental: client-side filter only (WhatsApp Web API has no server-side time filter)`
  - Fetch messages per chat as in `runBackfillImpl`; filter: only insert messages where `msg.timestamp > since.getTime() / 1000`
  - Wire to adapter object as `syncIncremental(db, since)`
  - Observable: unit test verifies that messages with timestamp at or before `since` are not inserted; messages after `since` are inserted; warning is logged
  - _Requirements: 2.1, 3.7, 3.8_
  - _Boundary: WhatsAppAdapter (whatsapp/sync.ts)_
  - _Depends: 2.1_

## Task 5: Integration tests and error-path verification

- [ ] 5.1 Integration test: mode-selection routes correctly based on sync_state and --backfill flag
  - Use in-memory DB; set `sync_state` for a platform; verify adapter's `syncIncremental` is called (not `runBackfill`) when no `--backfill` flag
  - Verify `runBackfill` is called when `--backfill` is set even with prior `sync_state` entry
  - Verify `runBackfill` is called on first run (no prior `sync_state` entry) regardless of flag
  - Observable: test passes; all three branches verified
  - _Requirements: 4.1, 4.2, 4.3_

- [ ] 5.2 Integration test: error path does not advance sync_state
  - Stub adapter's sync method to throw; run the mode-select path; assert `getPlatformLastSyncedAt` still returns null (or prior value)
  - Observable: test passes; `sync_state` row absent or unchanged after error
  - _Requirements: 1.3, 5.1, 5.2_
  - _Depends: 5.1_

- [ ] 5.3 Integration test: sync_state written on clean completion
  - Run a successful sync (stubbed adapter, no throw); assert `getPlatformLastSyncedAt` returns a recent timestamp
  - Observable: test passes; timestamp is within a few seconds of test execution time
  - _Requirements: 1.2, 5.1_
  - _Depends: 5.1_
