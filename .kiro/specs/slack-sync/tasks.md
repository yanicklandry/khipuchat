# Implementation Plan

- [x] 1. Foundation — verify script entry and create test skeleton
  - Confirm `"sync:slack": "tsx src/platforms/slack/sync.ts"` is present in `package.json`; add if missing
  - Create `tests/slack.test.ts` with mock `SlackClient` stub (list/fetch/getName no-ops)
  - `npm test` passes with no errors from the skeleton
  - _Requirements: 5.1_

- [x] 2. Core — transport client and data mappers
- [x] 2.1 (P) Implement Slack transport client
  - Create `src/platforms/slack/client.ts` with `SlackConversation`, `SlackMessage`, `SlackClient` interfaces and `createSlackClient` factory
  - `listConversations()`: async generator calling `conversations.list` with `types=public_channel,private_channel,im,mpim&exclude_archived=true`; cursor-paginated via `next_cursor`; throws on `ok: false`
  - `fetchHistory(channelId, oldest?)`: async generator over `conversations.history`; passes `oldest` param when provided
  - `getUserName(userId)`: calls `users.info`, caches result; returns raw `userId` on any error (never throws)
  - `slackFetch`: applies 1200ms pre-request delay; on 429 reads `Retry-After` header and retries once
  - `createSlackClient(token)` compiles cleanly; client integration verified by calling `listConversations()` against a stubbed `globalThis.fetch`
  - _Requirements: 1.1, 2.1, 2.2, 2.3, 3.1, 4.1, 4.2_
  - _Boundary: SlackClient (client.ts)_

- [x] 2.2 (P) Implement chat and message mappers
  - Add `mapChat(conv, account)` to `src/platforms/slack/sync.ts`: `platform='slack'`; `type='private'` for `is_im`, `'group'` for `is_mpim`, `'user'` for channels; `name` = `conv.name ?? conv.user ?? conv.id`
  - Add `mapMessage(msg, chatId, senderName)`: `external_id = msg.ts`; `timestamp = Math.floor(parseFloat(msg.ts))`; `sender_id = msg.user ?? null`; `sender_name` populated from the injected `senderName` argument (resolved by the caller via `getUserName`); `type = 'other'` when `msg.subtype` is set or `msg.text` is empty; `platform = 'slack'`
  - Mapper unit tests verify all type branches, the timestamp conversion, and that `sender_name` equals the passed argument
  - _Requirements: 2.3, 3.2, 3.3, 3.4, 3.5, 3.6_
  - _Boundary: mapChat / mapMessage (sync.ts)_

- [x] 3. Sync runners, adapter factory, and entry point
- [x] 3.1 Implement backfill runner
  - Add `runBackfillImpl(client, account?)`: iterates `listConversations()`; skips archived conversations (defense-in-depth); calls `upsertChat(mapChat(...))` per conversation
  - Paginates full history via `fetchHistory(conv.id)`; resolves each message's sender display name via `getUserName`; calls `insertMessage(mapMessage(...))`
  - After each conversation: calls `embedNewMessages` / `embedNewChats` only when `isIndexed()` returns true for the respective index
  - Running `runBackfillImpl` twice with the same mock produces zero duplicate message records
  - _Requirements: 2.3, 3.1, 3.4, 3.6, 5.2_

- [x] 3.2 Implement incremental runner
  - Add `runIncrementalImpl(client, since, account?)`: converts `since` to a Unix seconds string for `oldest`; same conversation loop as backfill but passes `oldest` to `fetchHistory`
  - Only messages with `ts` after `since` are fetched from the API; idempotency via INSERT-OR-IGNORE ensures overlap windows are safe
  - Integration test asserts `oldest` param passed to `fetchHistory` matches expected Unix-seconds string
  - _Requirements: 5.3_
  - _Depends: 3.1_

- [x] 3.3 Implement adapter factory and main entry
  - Add `createSlackAdapter(account, credentials)`: reads `credentials.fields['SLACK_USER_TOKEN']`; writes error to stderr and calls `process.exit(1)` if empty
  - Returns `PlatformAdapter` with `runBackfill`, `syncIncremental`, and a no-op `startListener`; `platform = 'slack'`
  - Add `slackAdapter` default export using `process.env.SLACK_USER_TOKEN`
  - Add `main()` calling `runPlatformSync(slackAdapter, db)` and exiting 0 on success or 1 on error
  - `npm run sync:slack` exits 1 with a clear error message when `SLACK_USER_TOKEN` is not set
  - _Requirements: 1.1, 1.2, 5.1_
  - _Depends: 3.1, 3.2_

- [x] 4. Tests — unit and integration coverage
- [x] 4.1 Unit tests for mappers and client error handling
  - `mapChat`: type=private for DM (`is_im=true`), type=group for group DM (`is_mpim=true`), type=user for channel; name fallback chain; `platform='slack'`
  - `mapMessage`: `ts` float string converts to integer Unix seconds; `external_id = ts`; `sender_name` equals the passed `senderName` arg; `subtype` present → `type='other'`; empty text → `type='other'`
  - `SlackClient` 429 path: stub `globalThis.fetch` with a 429 then 200 sequence; assert retry fires after `Retry-After` delay
  - All unit tests pass with `npm test`
  - _Requirements: 3.2, 3.3, 3.4, 3.5, 4.1_

- [x] 4.2 Integration tests for runners and token guard
  - `runBackfillImpl` with mock `SlackClient`: correct `Chat` and `Message` records written to in-memory DB; archived conversations produce no records
  - Idempotency: calling `runBackfillImpl` twice with the same mock data produces no duplicate rows
  - `runIncrementalImpl`: `oldest` param passed to `fetchHistory` matches expected Unix-seconds string
  - `createSlackAdapter` with missing token: `process.exit(1)` called and error written to stderr
  - All integration tests pass with `npm test`
  - _Requirements: 1.2, 2.3, 5.2, 5.3_
