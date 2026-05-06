# Implementation Plan

- [ ] 1. Foundation — script and test scaffold
- [ ] 1.1 Add npm script and create module
  - Add `"sync:slack": "tsx src/platforms/slack/sync.ts"` to `package.json`
  - Create `src/platforms/slack/` directory and `tests/slack.test.ts` skeleton with mock `SlackClient`
  - `npm test` passes
  - _Requirements: 5.1_

- [ ] 2. Core — client and mappers (parallel)
- [ ] 2.1 (P) Implement the Slack REST client wrapper
  - Create `src/platforms/slack/client.ts` with `SlackConversation`, `SlackMessage`, `SlackClient` interfaces
  - `listConversations()`: async generator over `conversations.list` cursor pagination, skipping archived
  - `fetchHistory(channelId)`: async generator over `conversations.history` cursor pagination
  - `getUserName(userId)`: `users.info` call with in-memory cache; returns user ID on failure
  - On 429: `Retry-After` header wait + retry; between requests: 1200ms pacing
  - _Requirements: 1.1, 2.1, 2.2, 2.3, 4.1, 4.2_
  - _Boundary: Slack Client (client.ts)_

- [ ] 2.2 (P) Implement mappers and hash helper
  - Create `src/platforms/slack/sync.ts` with `hashStr` (FNV-1a)
  - `mapChat(conv)`: id from `hashStr(conv.id)`; type private/group/user based on is_im/is_mpim
  - `mapMessage(msg, chatId, senderName)`: `external_id = msg.ts`; `timestamp = Math.floor(parseFloat(msg.ts))`; `type = 'other'` when subtype present or text empty
  - Mappers pass unit tests
  - _Requirements: 2.3, 3.1, 3.2, 3.3, 3.5, 3.6_
  - _Boundary: Row Mappers (sync.ts)_

- [ ] 3. Backfill runner and adapter
- [ ] 3.1 Implement runBackfillImpl and adapter
  - Add `runBackfillImpl(client)`: iterates conversations; skips archived; upserts chat; paginates history; resolves sender name via `getUserName`; inserts messages
  - Add `slackAdapter: PlatformAdapter` and `main()` with `SLACK_USER_TOKEN` validation (exit 1 if missing)
  - Running twice with same mock produces no duplicate records
  - _Requirements: 1.2, 2.1, 3.4, 5.2, 5.3_

- [ ] 4. Tests
- [ ] 4.1 Unit and integration tests
  - `mapChat`: correct type for DM, group DM, channel
  - `mapMessage`: timestamp from ts float; type=other for subtype
  - `runBackfillImpl` with mock client → correct records + idempotency
  - Missing `SLACK_USER_TOKEN` → exit 1
  - All tests pass with `npm test`
  - _Requirements: 1.2, 3.3, 3.5, 5.2_
