# Implementation Plan

- [ ] 1. Foundation: project scaffold and test infrastructure
- [ ] 1.1 Add sync script and create platform directory structure
  - Add `sync:discord` entry to the scripts section in `package.json`
  - Create `src/platforms/discord/` directory with empty `client.ts` and `sync.ts` stubs
  - Create `tests/discord.test.ts` skeleton with a mock client factory returning fixture channel and message data
  - Observable: `npm test` passes with no new failures; the `sync:discord` script name resolves
  - _Requirements: 5.1_

- [ ] 2. Core: Discord REST client and row mappers
- [ ] 2.1 (P) Implement the Discord REST client
  - Wrap `globalThis.fetch` with Discord API v10 base URL and `Authorization: Bot {token}` header
  - Implement `getGuilds`, `getGuildChannels`, `getDirectMessageChannels`, and `getMessages` with optional `before`/`after` snowflake cursors and `limit=100` per page
  - On 429: read `Retry-After` header (default 1 s if absent), wait that duration, retry once; throw a descriptive error on a second 429 or any other non-2xx response
  - Export a `createDiscordClient(token)` factory so tests can inject a mock instead of the live client
  - Observable: calling `getMessages` against a mocked 429-then-200 sequence waits exactly once and returns the message list; a non-2xx mock throws a descriptive error
  - _Requirements: 1.1, 2.1, 2.2, 4.1, 4.2_
  - _Boundary: Discord Client (`client.ts`)_

- [ ] 2.2 (P) Implement row mappers, hash helper, and snowflake converter
  - `hashStr(s)`: FNV-1a over the string, never returns 0; exported for testing
  - `mapChat(channel, account)`: derives name from `channel.name`, first recipient `username`, or `channel.id`; sets `type` to `'group'` for types 0 and 3, `'private'` for type 1; sets `platform: 'discord'` and stores `account` on every row
  - `mapMessage(msg, chatId)`: sets `external_id` from snowflake, `sender_id`/`sender_name` from author, `text: null` for empty content, `type: 'other'` for embed-only messages, `timestamp` as Unix seconds, `is_sender: 0`, `reply_to_external_id` from `message_reference?.message_id`, `platform: 'discord'`
  - `dateToDiscordSnowflake(date)`: converts a JS Date to a Discord snowflake string via the Discord epoch (1420070400000) and a 22-bit left shift
  - Observable: mapper unit tests with fixture data confirm all field assignments including the name fallback chain, the empty-content type branch, and the reply reference extraction
  - _Requirements: 2.4, 3.2, 3.3, 3.4, 3.6, 6.2_
  - _Boundary: Row Mappers and Helpers (`sync.ts` pure functions)_

- [ ] 3. Sync runners: backfill and incremental
- [ ] 3.1 Implement the paginated backfill runner
  - Discover channels by combining `getDirectMessageChannels()` with all guild channels from each guild in `getGuilds()` + `getGuildChannels(guild.id)`; keep only types 0 (GuildText), 1 (DM), 3 (GroupDM); skip all others
  - For each channel: call `upsertChat(mapChat(channel, account))` to create or update a single chat record, then page backward using the `before` cursor (set to the last message id after each page); stop when a page returns fewer than 100 messages
  - Store each message with `insertMessage(mapMessage(msg, chatId))`; INSERT OR IGNORE ensures no duplicate rows
  - After each channel: call `embedNewMessages([chatId])` when `isIndexed('messages')` is true; call `embedNewChats([chatId])` when `isIndexed('chats')` is true
  - Observable: integration test with a mock client produces expected chat and message rows in an in-memory DB; running the same sync twice yields identical rows
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.4, 3.5, 5.2_
  - _Depends: 2.1, 2.2_

- [ ] 3.2 Implement the paginated incremental runner
  - Channel discovery is identical to the backfill runner
  - Seed an `after` cursor from `dateToDiscordSnowflake(since)`; page forward advancing the cursor to the last returned message id; stop on an empty or short page
  - Apply the same per-message storage and per-channel embedding trigger as the backfill runner
  - Observable: running with a `since` date inserts only messages newer than the cursor; existing rows older than `since` remain unmodified
  - _Requirements: 3.1, 5.3_
  - _Depends: 3.1_

- [ ] 4. Integration: adapter factory and CLI entry point
- [ ] 4.1 Wire the adapter factory, CLI entry point, and multi-account registration
  - Implement `createDiscordAdapter(account, credentials)` returning a `PlatformAdapter` for `'discord'`
  - `runBackfill(db)`: reads `credentials.fields['DISCORD_TOKEN']`; if absent, writes an actionable message to stderr and calls `process.exit(1)`; otherwise delegates to `runBackfillImpl(createDiscordClient(token), account)`
  - `syncIncremental(db, since)`: applies the same token guard and delegates to `runIncrementalImpl`
  - `startListener(db)`: no-op (REST-only scope)
  - Export `discordAdapter` as the default-account adapter instance reading `process.env.DISCORD_TOKEN`
  - Add `main()`: calls `initDb`, then `runPlatformSync(discordAdapter, db, process.argv)`; `--force` is passed through `parseSyncArgs` to trigger backfill mode regardless of stored last-synced state; guard so `main()` only runs when the module is the direct entry point
  - Register `createDiscordAdapter` in the `ADAPTER_FACTORIES` map in `watch.ts` so the shared `runAllAccountsSync` loop builds per-account Discord adapters with their own `(platform, account)` last-synced keys and per-account `try/catch` isolation
  - Observable: `npm run sync:discord` with no `DISCORD_TOKEN` set exits with code 1 and prints an actionable message to stderr; `--force` triggers a backfill run regardless of prior sync state
  - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.4, 6.1, 6.2, 6.3_
  - _Boundary: Adapter Factory and Entry Point_
  - _Depends: 3.1, 3.2_

- [ ] 5. Testing
- [ ] 5.1 Unit tests for helpers and mappers
  - `hashStr`: produces a stable result for a known input; result is never zero
  - `dateToDiscordSnowflake`: output matches the expected snowflake for a known date (Discord epoch and 22-bit shift math verified)
  - `mapChat`: name falls back from channel name to first recipient username to channel id; `type` is `'group'` for types 0 and 3, `'private'` for type 1; `account` appears on the row
  - `mapMessage`: ISO-to-Unix-seconds conversion; `type: 'other'` when content is empty; reply reference is set when `message_reference` is present; `is_sender` is 0; `platform` is `'discord'`
  - Observable: all unit tests pass with `npm test`
  - _Requirements: 2.4, 3.2, 3.3, 3.6, 6.2_
  - _Depends: 4.1_

- [ ] 5.2 Integration tests for runners and adapter
  - Backfill runner with a mock client fixture: expected chat and message rows appear in an in-memory DB with correct field values
  - Idempotency: running the backfill twice with the same fixture produces identical records with no new rows on the second run
  - Incremental runner with a `since` date: only messages newer than the derived snowflake cursor are inserted; older rows are untouched
  - Channel-type filtering: fixture channels with types 2, 4, 5, and 10 are excluded from all results; only types 0, 1, and 3 appear
  - Rate-limit handling: a mock returning 429 with a `Retry-After` header on the first call and 200 on the second triggers exactly one retry and results in a successful insert
  - Missing token in the adapter: `runBackfill` exits with code 1 and stderr contains an actionable message
  - Observable: all integration tests pass with `npm test`
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 2.4, 3.1, 3.5, 4.1, 5.2, 5.3_
  - _Depends: 5.1_
