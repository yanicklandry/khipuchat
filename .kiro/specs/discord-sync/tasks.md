# Implementation Plan

- [ ] 1. Foundation — script and test scaffold
- [ ] 1.1 Add npm script and create module directory
  - Add `"sync:discord": "tsx src/platforms/discord/sync.ts"` to `package.json`
  - Create `src/platforms/discord/` directory
  - Create `tests/discord.test.ts` skeleton with a mock `DiscordClient` factory returning fixture channels and messages
  - `npm test` passes with no new failures
  - _Requirements: 5.1_

- [ ] 2. Core — client wrapper and mappers (parallel)
- [ ] 2.1 (P) Implement the Discord REST client wrapper
  - Create `src/platforms/discord/client.ts` with `DiscordChannel`, `DiscordMessage`, `DiscordClient` interfaces
  - Implement `createDiscordClient(token)`: wraps `globalThis.fetch` with `Authorization: Bot {token}` header
  - Implement `getGuilds`, `getGuildChannels`, `getDirectMessageChannels`, `getMessages` methods
  - On 429: read `Retry-After` header, `await` the delay, retry the request once
  - On other non-2xx: throw a typed error with status and URL
  - `getMessages` accepts optional `before` snowflake parameter for cursor pagination
  - _Requirements: 1.1, 2.1, 2.2, 4.1, 4.2_
  - _Boundary: Discord Client (client.ts)_

- [ ] 2.2 (P) Implement row mappers and hash helper
  - Create `src/platforms/discord/sync.ts` with `hashStr` (FNV-1a, same algorithm as wechat-sync)
  - Implement `mapChat(channel)`: derives stable numeric `id` via `hashStr(channel.id)`; name from `channel.name` or first recipient username; type `'group'` for multi-recipient DMs and guild text, `'private'` for single DMs
  - Implement `mapMessage(msg, chatId)`: `external_id = msg.id`; `timestamp = Math.floor(Date.parse(msg.timestamp) / 1000)`; `text = msg.content || null`; `type = 'other'` when content is empty; `is_sender = 0` (bot token cannot identify current user); `reply_to_external_id` from `message_reference.message_id`
  - Mappers pass unit tests with fixture data
  - _Requirements: 2.3, 3.2, 3.3, 3.4, 3.5_
  - _Boundary: Row Mappers (sync.ts)_

- [ ] 3. Backfill runner and adapter
- [ ] 3.1 Implement the paginated backfill runner
  - Add `runBackfillImpl(client: DiscordClient)` to `sync.ts`
  - Discover channels: call `getDirectMessageChannels()` + `getGuilds()` → `getGuildChannels(id)` for each; filter to channel types 0, 1, 3 only
  - For each channel: call `upsertChat(mapChat(channel))`; paginate `getMessages` with `before` cursor until response length < 100; call `insertMessage(mapMessage(...))` for each message
  - Running with same mock client twice produces no duplicate DB records
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 5.2, 5.3_

- [ ] 3.2 Implement the adapter, token check, and main entry point
  - Add `discordAdapter: PlatformAdapter` with `platform: 'discord'`, `runBackfill` (reads `DISCORD_TOKEN`, calls `createDiscordClient`, calls `runBackfillImpl`), no-op `startListener`
  - If `DISCORD_TOKEN` is missing: write error to stderr and call `process.exit(1)`
  - Add `main()` and `require.main === module` guard
  - `npm run sync:discord` with `DISCORD_TOKEN` unset exits non-zero and prints an actionable message
  - _Requirements: 1.1, 1.2, 5.1_

- [ ] 4. Tests
- [ ] 4.1 Unit and integration tests
  - `mapChat`: correct name fallback chain; group/private type derivation
  - `mapMessage`: timestamp conversion; `type='other'` for empty content; `reply_to_external_id` populated
  - `runBackfillImpl` with mock client → correct chats and messages in in-memory archive DB
  - Idempotency: running `runBackfillImpl` twice with same fixture yields identical records
  - Missing `DISCORD_TOKEN` → process exits with code 1
  - All tests pass with `npm test`
  - _Requirements: 1.2, 2.3, 3.2, 3.5, 5.2_
