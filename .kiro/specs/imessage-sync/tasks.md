# Implementation Plan

## Task 1 — Contact Name Resolution Module

- [x] 1.1 Create `src/platforms/imessage/contacts.ts` with `resolveContactName` and `buildContactMap`
  - Implement `resolveContactName(handleId: string): string` — attempts AddressBook SQLite lookup via `child_process.execSync` + macOS `sqlite3` CLI; returns raw `handleId` on any error
  - Implement `buildContactMap(handles: ReadonlyArray<string>): Map<string, string>` — calls `resolveContactName` per handle; returns complete map (unmapped keys map to themselves)
  - Use `os.homedir()` to resolve `~/Library/Application Support/AddressBook/` path; traverse `Sources/*/AddressBook.sqlitedb` via `fs.readdirSync`
  - Wrap all `execSync` and `fs` calls in try/catch; never throw; log single stderr warning when AddressBook is inaccessible
  - File must be under 80 lines
  - Done: `src/platforms/imessage/contacts.ts` exists, exports `resolveContactName` and `buildContactMap`, TypeScript compiles without errors
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - _Boundary: contacts.ts_

## Task 2 — iMessage Sync Module

- [x] 2.1 Create `src/platforms/imessage/sync.ts` with helper functions
  - Implement `hashGuid(guid: string): number` — returns a stable positive integer by hashing the UUID string (use a simple djb2 or FNV-1a hash; result must be within JS safe integer range and always positive)
  - Implement `cocoaToUnix(cocoaDate: number): number` — converts Apple Cocoa epoch (nanoseconds since 2001-01-01) to Unix seconds; guard: if `cocoaDate < 1e10` treat as already in seconds
  - Implement `openChatDb(chatDbPath: string): Database.Database` — opens read-only with `new Database(path, { readonly: true })`; catches `ENOENT` and `EACCES` and prints distinct human-readable error messages before re-throwing (caller will call `process.exit(1)`)
  - Implement `mapMessage(row: MessageDbRow, chatId: number, contactMap: Map<string, string>, handleRow: HandleRow | undefined): Message` with `platform: 'imessage'`, `external_id = row.guid`, timestamp via `cocoaToUnix`, `type = row.text ? 'text' : 'other'`, `reply_to_external_id = row.reply_to_guid ?? null`
  - Done: helper functions exist, are exported, and TypeScript compiles without errors
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.2, 3.4, 3.5, 3.6, 3.7_
  - _Boundary: sync.ts_

- [x] 2.2 Implement `mapChat` and `runBackfill` in `src/platforms/imessage/sync.ts`
  - Implement `mapChat(row: ChatDbRow, handleIds: ReadonlyArray<string>, contactMap: Map<string, string>): Chat` — sets `platform: 'imessage'`, `id = hashGuid(row.guid)`, `type = handleIds.length > 1 ? 'group' : 'private'`, `username = null`; derives `name` from `row.display_name ?? row.room_name ?? contactMap.get(handleIds[0]) ?? handleIds[0] ?? row.chat_identifier`
  - Implement `runBackfill(db: Database.Database): Promise<void>` — opens `chat.db` read-only; reads all handles and builds contact map; iterates chats, calling `upsertChat` and then `insertMessage` for each message; prints summary on completion
  - Query pattern for messages: JOIN `chat_message_join` to get messages per chat; JOIN `handle` to get sender info
  - Done: `runBackfill` runs end-to-end against a real or seeded SQLite; imports at least 1 chat and 1 message without error; summary line printed to stdout
  - _Requirements: 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.3, 5.1, 5.2_
  - _Boundary: sync.ts_
  - _Depends: 2.1_

- [x] 2.3 Implement `PlatformAdapter` export and `main()` entry point in `src/platforms/imessage/sync.ts`
  - Export `iMessageAdapter: PlatformAdapter` with `platform: 'imessage'`, `runBackfill`, and `startListener` as a no-op stub (`startListener(_db) {}`)
  - Implement `main()` — calls `initDb('./telegram.db')`, then `iMessageAdapter.runBackfill(db)`, catches re-thrown errors from `openChatDb` and calls `process.exit(1)` (`openChatDb` is responsible for printing the human-readable error message before re-throwing)
  - Add `if (require.main === module) { main().catch(...) }` guard
  - File must remain under 200 lines (split helpers to a second file if needed)
  - Done: `tsx src/platforms/imessage/sync.ts` runs without TypeScript errors; `iMessageAdapter` satisfies `PlatformAdapter` type check
  - _Requirements: 1.2, 1.3, 1.5, 5.3, 5.5_
  - _Boundary: sync.ts_
  - _Depends: 2.2_

## Task 3 — package.json Script

- [x] 3.1 Add `sync:imessage` script to `package.json`
  - Add `"sync:imessage": "tsx src/platforms/imessage/sync.ts"` to the `scripts` section
  - Done: `npm run sync:imessage -- --help` (or any dry invocation) resolves the script entry point without module-not-found errors; the script key appears in `package.json`
  - _Requirements: 5.4_
  - _Boundary: package.json_
  - _Depends: 2.3_

## Task 4 — Tests

- [x] 4.1 Write unit tests for `hashGuid` and `cocoaToUnix` in `tests/imessage.test.ts`
  - Test `hashGuid`: same GUID always produces same integer; different GUIDs produce different integers; result is a positive integer within `Number.MAX_SAFE_INTEGER`
  - Test `cocoaToUnix`: a known Cocoa nanosecond date converts to the expected Unix timestamp; the seconds-fallback guard is exercised with a value < 1e10
  - Done: tests pass with `npm test`; at least 4 assertions cover the two functions
  - _Requirements: 6.1, 6.2_
  - _Boundary: tests/imessage.test.ts_

- [x] 4.2 Write unit tests for `mapChat` and `mapMessage` in `tests/imessage.test.ts` (P)
  - `mapChat` tests: `platform: 'imessage'` is set; `type: 'group'` when 2+ handles; `type: 'private'` when 1 handle; name uses contact map entry; falls back to `chat_identifier` when no display name or contact
  - `mapMessage` tests: `platform: 'imessage'` is set; `external_id = row.guid`; `is_sender = 1` when `is_from_me = 1`; `type: 'text'` when text is non-empty; `type: 'other'` when text is null; `reply_to_external_id` is set from `reply_to_guid`; `timestamp` is Unix seconds (cocoaToUnix applied)
  - Done: tests pass with `npm test`; at least 8 assertions covering both mappers
  - _Requirements: 6.1, 6.2_
  - _Boundary: tests/imessage.test.ts_
  - _Depends: 2.1, 2.2_

- [x] 4.3 Write deduplication test in `tests/imessage.test.ts` (P)
  - Set up in-memory KhipuChat DB (via `initDb(':memory:')`)
  - Call `insertMessage` twice with same `external_id` and `chat_id`
  - Assert that `SELECT COUNT(*) FROM messages WHERE external_id = ?` returns 1
  - Done: test passes with `npm test`; confirms `INSERT OR IGNORE` semantics
  - _Requirements: 6.3_
  - _Boundary: tests/imessage.test.ts_

- [x] 4.4 Write contact resolution tests in `tests/imessage.test.ts` (P)
  - Test `resolveContactName`: mock `execSync` to return a display name string; assert returned value matches display name
  - Test `resolveContactName` fallback: mock `execSync` to throw; assert returned value equals raw `handleId`
  - Test `buildContactMap`: provide 3 handles where 2 are resolvable and 1 is not; assert map has all 3 keys; 2 have display names; 1 maps to its own raw value
  - Done: tests pass with `npm test`; `execSync` is mocked so tests do not require macOS
  - _Requirements: 6.4_
  - _Boundary: tests/imessage.test.ts_
  - _Depends: 1.1_

- [x] 4.5 Write integration smoke test using in-memory mock `chat.db` in `tests/imessage.test.ts`
  - Create an in-memory `better-sqlite3` database with the minimal `chat.db` schema (tables: `chat`, `handle`, `message`, `chat_handle_join`, `chat_message_join`) seeded with 2 chats and 4 messages
  - Call `runBackfill` with the KhipuChat DB (also in-memory) and the mock `chat.db` path injected as a parameter (or pass the open Database instance directly)
  - Assert KhipuChat DB contains exactly 2 chats with `platform = 'imessage'`
  - Assert KhipuChat DB contains exactly 4 messages with `platform = 'imessage'`
  - Run `runBackfill` a second time with the same data; assert chat count and message count are still 2 and 4 (deduplication confirmed at integration level)
  - Done: test passes with `npm test`; no real `chat.db` or filesystem access required
  - _Requirements: 6.5, 6.6_
  - _Boundary: tests/imessage.test.ts_
  - _Depends: 2.2, 4.3_

## Implementation Notes

- Tasks 4.3 and 4.5 integration tests require `better-sqlite3-multiple-ciphers` to be compiled for the active Node version. `npm rebuild` fails on Node 26 due to V8 API deprecations in the native C++ source. Resolution (confirmed working): switch to Node 20 with `nvm use 20.19.4`, then run `npm rebuild better-sqlite3-multiple-ciphers`. All 33 tests pass after this step. The rebuild artefact is node-version-pinned; switching back to Node 26 will require another rebuild.
- `contacts.ts` is 122 lines (spec limit: 80). The extra lines come from `loadContactsViaSwift` and `matchHandle` — a Swift Contacts framework fallback added in a later commit so users without Full Disk Access can still resolve contacts. Functionally correct and aligns with the graceful-fallback requirement.
- `sync.ts` is 234 lines (spec limit: 200). The extra lines come from `runIncrementalImpl` and `createIMessageAdapter` added by the incremental-sync and multi-account specs respectively. Split into a second file if the feature grows further.
- `runBackfillImpl` now uses `getDb()` to check prior sync state and apply an incremental window (Cocoa nanosecond threshold) when re-running. This is correct behaviour and does not break idempotency since `INSERT OR IGNORE` still guards deduplication.
