# Implementation Plan

- [x] 1. Add sync script and test scaffold
  - Add the `sync:discord` entry to the scripts section in `package.json`
  - Create the `src/platforms/discord/` directory
  - Create a test file skeleton with a mock client factory returning fixture channel and message data
  - `npm test` passes with no new failures
  - _Requirements: 5.1_

- [x] 2. Core - Discord REST client and data mappers
- [x] 2.1 (P) Implement the Discord REST client
  - Wrap `globalThis.fetch` with Discord API v10 base URL and `Authorization: Bot` header
  - Support listing guilds, listing guild channels, listing DM channels, and fetching messages with optional before/after snowflake cursors and a 100-message page limit
  - On a 429 response: wait the duration from the `Retry-After` header, then retry once; throw on a second 429 or any other non-2xx response
  - The client is injectable via a factory function so tests can substitute a mock
  - _Requirements: 1.1, 2.1, 2.2, 4.1, 4.2_
  - _Boundary: Discord Client_

- [x] 2.2 (P) Implement data mappers, hash helper, and snowflake converter
  - Add a hash helper that produces a stable non-zero numeric identifier from a string (FNV-1a algorithm)
  - Add a chat mapper: derives a human-readable name from channel name, first recipient username, or channel id; marks group-DM and guild-text channels as group type and single DMs as private; sets platform to 'discord'
  - Add a message mapper: converts snowflake id to external_id; converts ISO timestamp to Unix seconds; sets text to null when content is empty; assigns type 'other' for embed-only messages; records reply reference when present; sets is_sender to 0
  - Add a date-to-snowflake converter: converts a JS Date to a Discord snowflake string using the Discord epoch and a 22-bit left shift
  - Mapper functions pass unit tests with fixture data
  - _Requirements: 2.3, 3.2, 3.3, 3.4, 3.5_
  - _Boundary: Row Mappers and Helpers_

- [x] 3. Sync runners
- [x] 3.1 Implement the paginated backfill runner
  - Discover channels: combine DM channels with all text channels from every guild the bot has joined; skip announcement, voice, forum, and other non-text channel types
  - For each discovered channel: create or update a chat record, then page backward through messages until a page returns fewer than 100 results, storing each message without modifying any previously stored records
  - After processing each channel: trigger embedding updates for messages and chats when the corresponding index exists
  - Running the same sync twice with the same fixture produces identical records (INSERT OR IGNORE idempotency)
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.4, 5.2_

- [x] 3.2 Implement the paginated incremental runner
  - Channel discovery is identical to the backfill runner
  - Seed a forward cursor from the `since` timestamp converted to a Discord snowflake; page forward advancing the cursor to the last returned message id, stopping when a page returns fewer than 100 results
  - Apply the same per-message storage and per-channel embedding calls as the backfill runner
  - Running with a `since` date only inserts messages newer than that point; older rows remain unmodified
  - _Requirements: 3.1, 5.3_
  - _Depends: 3.1_

- [x] 4. Integration: adapter factory and entry point
- [x] 4.1 Wire the adapter factory and CLI entry point
  - Create an adapter factory that accepts an account name and credentials and returns a platform adapter for 'discord'
  - The backfill method reads the bot token from credentials; if absent, writes an actionable error to stderr and exits with code 1
  - The incremental-sync method applies the same token check and delegates to the incremental runner
  - The listener method is a no-op (REST-only scope)
  - Export a default-account adapter instance that reads the bot token from the environment
  - Add a CLI entry point that initialises the database then delegates to the shared sync runner (which selects backfill vs incremental based on stored state); guard it so it only runs when the module is the direct entry point
  - `npm run sync:discord` with no token set exits with code 1 and prints an actionable message
  - _Requirements: 1.1, 1.2, 5.1_
  - _Boundary: Adapter Factory, Entry Point (integration across client and runners)_
  - _Depends: 3.1, 3.2_

- [x] 5. Tests
- [x] 5.1 Unit tests for helpers and mappers
  - Hash helper: FNV-1a produces a stable result; result is never zero
  - Snowflake converter: output matches the expected value for a known date (Discord epoch and 22-bit shift math)
  - Chat mapper: name fallback chain (channel name => first recipient username => id); type derivation for all three allowed channel types
  - Message mapper: ISO-to-Unix-seconds conversion; type 'other' for empty content; reply reference extracted when present
  - All unit tests pass with `npm test`
  - _Requirements: 2.3, 3.2, 3.5_
  - _Depends: 4.1_

- [x] 5.2 Integration tests for runners and rate-limit handling
  - Backfill runner with a mock client fixture: correct chat and message rows appear in an in-memory DB
  - Idempotency: running the backfill twice with the same fixture produces identical records
  - Incremental runner with a `since` date: only messages newer than the cursor are inserted; older rows are untouched
  - Channel-type filtering: announcement, voice, and forum channels in the fixture are excluded from results
  - Rate-limit handling: a mock returning 429 with a `Retry-After` header on the first call and succeeding on the second triggers exactly one retry and a successful insert (note: proactive 50 req/s throttle from req 4.2 is intentionally omitted per design - rate limiting is reactive only)
  - Missing token in the adapter: the process exits with code 1 and stderr contains an actionable message
  - All integration tests pass with `npm test`
  - _Requirements: 1.2, 2.3, 3.1, 4.1, 5.2, 5.3_
  - _Depends: 5.1_
