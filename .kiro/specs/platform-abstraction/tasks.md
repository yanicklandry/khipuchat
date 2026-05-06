# Implementation Plan

## Tasks

- [ ] 1. Foundation: Platform types module and DB schema migration
- [ ] 1.1 Create `src/platforms/types.ts` with `Platform` union and `PlatformAdapter` interface
  - Create the `src/platforms/` directory
  - Export `Platform = 'telegram' | 'imessage' | 'discord' | 'slack' | 'whatsapp'`
  - Export `PlatformAdapter` interface with `readonly platform: Platform`, `runBackfill(db)`, and `startListener(db)` signatures
  - TypeScript compiler resolves `import { Platform } from './platforms/types'` without errors
  - _Requirements: 3.1, 3.2, 3.3_
  - _Boundary: src/platforms/types.ts_

- [ ] 1.2 Add `columnExists` migration guard and `platform` columns to `src/db.ts`
  - Add private `columnExists(db, table, column)` helper using `PRAGMA table_info`
  - Gate `ALTER TABLE chats ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'` on `!columnExists`
  - Gate `ALTER TABLE messages ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram'` on `!columnExists`
  - Update `Chat` interface to include `platform: Platform` (import from `src/platforms/types`)
  - After `initDb(':memory:')`, a query on `chats` and `messages` returns rows with `platform = 'telegram'`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Boundary: src/db.ts_

- [ ] 1.3 Rename `telegram_id` and `reply_to_telegram_id` columns in `src/db.ts`
  - Gate `ALTER TABLE messages RENAME COLUMN telegram_id TO external_id` on old column still existing
  - Gate `ALTER TABLE messages RENAME COLUMN reply_to_telegram_id TO reply_to_external_id` on old column still existing
  - Update `Message` interface: `external_id: string` replaces `telegram_id`; `reply_to_external_id` replaces `reply_to_telegram_id`; add `platform: Platform`
  - Update `MessageRow` interface to extend the updated `Message`
  - Update `insertMessage` SQL to bind `external_id`, `reply_to_external_id`, and `platform`
  - Update `getLastSyncedId` SQL to `SELECT external_id FROM messages …`
  - Update `UNIQUE` constraint DDL comment in `createSchema` to reference `external_id`
  - `getLastSyncedId` returns the `external_id` value of the highest-timestamp message for the given chat
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - _Boundary: src/db.ts_
  - _Depends: 1.2_

- [ ] 2. Update `searchMessages` and `upsertChat` to pass through `platform`
- [ ] 2.1 Extend `searchMessages` with optional `platform` parameter in `src/db.ts`
  - Add `platform?: Platform` parameter to `searchMessages` function signature
  - When `platform` is supplied, append `AND m.platform = ?` to the SQL WHERE clause
  - When `platform` is omitted, query returns results from all platforms
  - Update `SearchResult` interface to include `platform: Platform` selected from the `messages` table join
  - Both overloads (with and without `chatId`) apply the platform filter symmetrically
  - `searchMessages('hello', undefined, 'telegram')` returns only telegram messages; `searchMessages('hello')` returns all
  - _Requirements: 1.1, 2.1, 5.3, 5.4_
  - _Boundary: src/db.ts_
  - _Depends: 1.3_

- [ ] 2.2 Extend `upsertChat` to store `platform` in `src/db.ts`
  - Update `upsertChat` INSERT statement to include the `platform` column
  - Update the `ON CONFLICT DO UPDATE SET` clause to include `platform = excluded.platform`
  - `upsertChat({ id: 1, name: 'Test', type: 'user', username: null, platform: 'telegram' })` results in a row with `platform = 'telegram'`
  - _Requirements: 1.1, 1.3_
  - _Boundary: src/db.ts_
  - _Depends: 1.2_

- [ ] 3. Move Telegram sync to `src/platforms/telegram/sync.ts`
- [ ] 3.1 Create `src/platforms/telegram/sync.ts` with updated field references
  - Create the `src/platforms/telegram/` directory
  - Copy the full contents of `src/sync.ts` to the new path
  - Update `msgToRow` to produce `external_id` (not `telegram_id`), `reply_to_external_id`, and `platform: 'telegram'`
  - Import `Platform` from `../types` and import DB functions with adjusted relative paths
  - Update the `main()` entry point `initDb` path reference if needed
  - Running `node dist/platforms/telegram/sync.js` (after build) starts the daemon with identical behavior to the old `src/sync.ts`
  - _Requirements: 4.1, 4.2, 4.4_
  - _Boundary: src/platforms/telegram/sync.ts_
  - _Depends: 1.3_

- [ ] 3.2 Remove `src/sync.ts` and update all references
  - Delete `src/sync.ts`
  - Update `package.json` `scripts.sync` (or equivalent entry point) to reference `src/platforms/telegram/sync.ts`
  - Confirm no remaining import of `./sync` or `../sync` exists anywhere in `src/`
  - `npm run build` succeeds with no TypeScript errors
  - _Requirements: 4.3, 4.4_
  - _Boundary: src/platforms/telegram/sync.ts_
  - _Depends: 3.1_

- [ ] 4. MCP layer — additive platform filter and response field
- [ ] 4.1 Add `platform?` input parameter to `find_chat_by_name` and `search_messages`
  - Add `platform?: Platform` to `handleFindChatByName(name, platform?)` signature
  - When `platform` is supplied, append `AND c.platform = ?` to the `find_chat_by_name` SQL
  - Add `platform?: Platform` to `handleSearchMessages(query, chatId?, platform?)` signature
  - Delegate platform filter to updated `searchMessages` in `db.ts`
  - Update `find_chat_by_name` and `search_messages` JSON Schema objects to include `platform: { type: 'string' }` as an optional (not required) property
  - `handleFindChatByName('Tony', 'telegram')` returns only Telegram chats; `handleFindChatByName('Tony')` returns chats from all platforms
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.9_
  - _Boundary: src/mcp.ts_
  - _Depends: 2.1, 2.2_

- [ ] 4.2 Add `platform` field to all MCP response types and queries
  - Add `platform: Platform` to `ChatResult`, `MessageResult`, and `SummaryResult` interfaces
  - Update `handleFindChatByName` SQL `SELECT` to include `c.platform`
  - Update `handleListMessages` SQL `SELECT` to include `m.platform`
  - Update `handleGetChatSummary` SQL `SELECT` to include `c.platform`
  - Every object in the array returned by `handleFindChatByName` includes `platform`
  - Every object returned by `handleListMessages`, `handleSearchMessages`, and `handleGetChatSummary` includes `platform`
  - _Requirements: 5.5, 5.6, 5.7, 5.8_
  - _Boundary: src/mcp.ts_
  - _Depends: 4.1_

- [ ] 5. Test updates and new platform coverage
- [ ] 5.1 Update `tests/db.test.ts` — fixture field renames and platform defaults
  - Replace all occurrences of `telegram_id` with `external_id` in test fixtures
  - Replace all occurrences of `reply_to_telegram_id` with `reply_to_external_id` in test fixtures
  - Add `platform: 'telegram'` to `upsertChat` call fixtures
  - Add assertion in `schema` suite that `chats` and `messages` tables have a `platform` column after `initDb`
  - Add assertion that `upsertChat` stores the `platform` value
  - Add assertion that inserted message rows include `platform: 'telegram'`
  - Add assertion that `getLastSyncedId` returns the `external_id` value (not `telegram_id`)
  - `npm test` passes with all existing and new db.test.ts assertions green
  - _Requirements: 6.1, 6.2, 6.3, 6.6_
  - _Boundary: tests/db.test.ts_
  - _Depends: 1.3, 2.2_

- [ ] 5.2 Update `tests/mcp.test.ts` — fixture field renames and platform filter tests
  - Replace all occurrences of `telegram_id` with `external_id` in the `msg()` helper and fixtures
  - Add `platform: 'telegram'` to `upsertChat` calls in the `seed()` helper
  - Add a second chat with `platform: 'imessage'` in `seed()` and insert one message under it for filter tests
  - Add `handleFindChatByName` test: platform filter returns only `'telegram'` chats; omitted platform returns all chats
  - Add `handleSearchMessages` test: platform filter returns only `'telegram'` messages; omitted platform returns all matching messages
  - Add assertion that `handleListMessages` results include a `platform` field
  - Add assertion that `handleGetChatSummary` result includes a `platform` field
  - `npm test` passes with all existing and new mcp.test.ts assertions green
  - _Requirements: 6.1, 6.4, 6.5_
  - _Boundary: tests/mcp.test.ts_
  - _Depends: 4.2, 5.1_

- [ ] 5.3 Final integration validation
  - Run `npm test` and confirm all tests pass (zero failures, zero TypeScript errors)
  - Verify `src/sync.ts` no longer exists in the repository
  - Verify `src/platforms/types.ts` and `src/platforms/telegram/sync.ts` exist and compile without errors
  - `npm test` exits with code 0; `tsc --noEmit` exits with code 0
  - _Requirements: 6.1_
  - _Depends: 5.2_
