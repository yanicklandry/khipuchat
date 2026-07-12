# Implementation Plan

- [ ] 1. Foundation: dependency install and platform registration
- [x] 1.1 Install the @beeper/desktop-api SDK
  - Add `@beeper/desktop-api@^5.0.0` to `dependencies` in `package.json`
  - Run `npm install` to update `package-lock.json` with the new dependency
  - `import { BeeperDesktop } from '@beeper/desktop-api'` compiles without error from a TypeScript file
  - _Requirements: 2.1_

- [x] 1.2 (P) Register `signal` as a recognized platform
  - Add `| 'signal'` to the `Platform` union in `src/platforms/types.ts`
  - Add `'signal'` to the `PLATFORMS` array in `src/sync-all.ts`
  - `khipu sync signal` becomes a valid CLI dispatch target (PLATFORM_SET includes `signal`)
  - `khipu sync` (all-platform) includes Signal in its execution loop, and existing `runAllPlatforms` error-tolerance applies to Signal failures automatically
  - _Requirements: 1.1, 1.2, 1.3, 7.2_
  - _Boundary: Platform union (types.ts), PLATFORMS array (sync-all.ts)_

- [x] 2. Implement BeeperSignalClient in `src/platforms/signal/client.ts`
  - Create the `src/platforms/signal/` directory and `client.ts`
  - Implement `createBeeperSignalClient(accessToken)` that constructs a `BeeperDesktop` instance with `remote_access: false`
  - `signalAccountIds()` calls `accounts.list()`, filters to `network === 'signal'`, and memoizes the resolved IDs
  - `listChats()` yields all Signal chats via paginated `chats.search` scoped to the resolved Signal account IDs
  - `listChatMessages(chatId)` yields all messages for a chat (newest-to-oldest) using cursor-based pagination
  - `listNewChatMessages(chatId, since)` yields only messages after `since` via `messages.search({ dateAfter: since.toISOString() })`
  - Every query includes the Signal account IDs filter; no non-Signal data is ever exposed
  - Empty or missing `accessToken` throws a fatal error before any network call
  - ECONNREFUSED and 401 errors from Beeper are wrapped with a message naming Beeper Desktop
  - `import { createBeeperSignalClient } from './client'` compiles and is callable from `sync.ts`
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 1.1_

- [ ] 3. Implement SignalAdapter in `src/platforms/signal/sync.ts`
- [x] 3.1 Implement mapChat and mapMessage pure mapping functions
  - Create `src/platforms/signal/sync.ts` exporting `mapChat` and `mapMessage`
  - `mapChat(c, account)` maps `BeeperChat.id` to `external_id`, `title` to `name`, and chat type to `'private' | 'group'`; sets `platform: 'signal'`
  - `mapMessage(m, chatId)` maps `senderName`, `timestamp` (ms to unix seconds), `isSender` to `is_sender` (0/1), `linkedMessageID` to `reply_to_external_id`, and `text`; sets `platform: 'signal'`
  - All `media_*` columns (`media_file_path`, `media_url`, `media_width`, `media_height`, `ocr_text`) are explicitly `null`
  - `type` is `'text'` only when `m.type === 'TEXT'` and `m.text` is non-empty; otherwise `'other'`
  - Messages where `m.isDeleted` or `m.isHidden` is true are skipped by the caller (mapMessage returns a sentinel or the caller checks before invoking)
  - Both functions are pure: no I/O, no side effects, no imports from `client.ts`
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 3.2 Implement the backfill sync loop
  - Add `runBackfillImpl(client, account)` to `sync.ts` that iterates all chats from `client.listChats()`
  - For each chat: calls `upsertChat(mapChat(...))`, then streams all messages via `client.listChatMessages()`, calling `insertMessage(mapMessage(...))` for each non-deleted/non-hidden message
  - Each chat's fetch-and-insert block is wrapped in a per-chat try/catch; errors are logged and the loop continues to the next chat
  - After each chat: calls `embedNewMessages([chatId])` and `embedNewChats([chatId])` guarded by `isIndexed`
  - Logs a summary line `[signal] Sync complete: N chats, M messages` on completion
  - Running a second backfill against the same data inserts zero new rows (idempotent via `upsertChat` and `insertMessage` ON CONFLICT)
  - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4_

- [x] 3.3 Implement the incremental sync loop
  - Add `runIncrementalImpl(client, since, account)` to `sync.ts` that iterates all chats from `client.listChats()`
  - For each chat: upserts the chat row, then checks `getLastSyncedId(chatId)` to distinguish first-time from returning chats
  - First-time chat (null result): fetches full message history via `client.listChatMessages()`, matching backfill behavior
  - Returning chat: fetches only messages after `since` via `client.listNewChatMessages(chatId, since)`
  - Per-chat try/catch isolation and embedding hooks applied identically to `runBackfillImpl`
  - Sync point is persisted by `runPlatformSync` after the incremental run completes, so the next call to `runIncrementalImpl` uses a later `since`
  - _Requirements: 2.4, 4.1, 4.2, 4.3_

- [x] 3.4 Wire adapter factory, credential guard, and CLI entrypoint
  - Implement `createSignalAdapter(account, credentials)` in `sync.ts` that reads `credentials.fields['BEEPER_ACCESS_TOKEN']`
  - Empty token: writes a human-readable error to `stderr` naming Beeper Desktop and calls `process.exit(1)` (matching Discord/Slack pattern)
  - `startListener` is a no-op function exported from the adapter
  - Export a default `signalAdapter` instance using `process.env['BEEPER_ACCESS_TOKEN']` as fallback credential
  - `main()` calls `initDb` and `runPlatformSync(signalAdapter, db, process.argv)`, then exits
  - A Beeper-unreachable error thrown by the client propagates through the adapter to `runPlatformSync`, which exits non-zero for `khipu sync signal` and is caught-and-continued for `khipu sync`
  - `khipu sync signal` runs end-to-end: resolves Signal accounts, syncs chats and messages, exits cleanly with zero status
  - _Requirements: 1.2, 2.3, 7.1, 7.3, 7.4_

- [ ] 4. Tests for the Signal adapter
- [x] 4.1 Unit tests for mapChat and mapMessage
  - In `tests/signal.test.ts`, test `mapMessage` for correct `sender_name`, `timestamp` (ms-to-unix-s conversion), `is_sender` (0/1), `reply_to_external_id`, and `text` fields
  - Verify all `media_*` fields on the returned row are `null`
  - Verify `type` is `'text'` only when `m.type === 'TEXT'` and `m.text` is non-empty; verify `'other'` for media-only messages
  - Verify `mapChat` maps a 1:1 chat to `private` and a group chat to `group`, and uses `title` as `name`
  - All unit test assertions pass in `tests/signal.test.ts`
  - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6_

- [x] 4.2 Integration tests for adapter behavior against a mock client
  - In `tests/signal.test.ts`, stub `BeeperSignalClient` with controlled chat and message responses
  - `runBackfillImpl` upserts all chats and inserts all messages; a second run against the same data produces zero additional rows
  - `runIncrementalImpl` fetches only messages after `since` for a chat with a prior sync point; fetches full history for a chat where `getLastSyncedId` returns `null`
  - A mock client that throws on one chat's message fetch still processes the remaining chats without aborting
  - A mock with empty `signalAccountIds()` completes with no rows written and no error thrown
  - `createSignalAdapter` with an empty `BEEPER_ACCESS_TOKEN` calls `process.exit(1)` and writes a Beeper-naming message to stderr
  - All integration test cases pass in `tests/signal.test.ts`
  - _Requirements: 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 7.1, 7.3_

- [x]* 4.3 Query parity verification via existing MCP and CLI query paths
  - In `tests/signal.test.ts`, run a mocked Signal sync into an in-memory database, then exercise the existing query handlers
  - `handleListChats` returns the synced Signal chat; `handleSearchMessages` resolves it by name
  - `handleListMessages` and `handleSearchMessages` return Signal messages for the synced chat without Signal-specific arguments
  - `rebuildFtsIndex` followed by `handleSearchMessages` includes Signal message text in full-text search results
  - No changes to MCP tools, CLI commands, or Web UI are required to satisfy any of the above assertions
  - All parity assertions pass in `tests/signal.test.ts`
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
