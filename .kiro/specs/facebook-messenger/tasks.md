# Implementation Plan

- [x] 0. Verify Beeper's network identifier for Facebook Messenger (safety net for R2.2)
  - On a machine with a Facebook Messenger account connected in Beeper Desktop, enumerate `beeper.accounts.list()` via `@beeper/desktop-api` (or the `get_accounts` MCP tool) and inspect the `network` field of the Messenger account
  - Record the observed raw `network` string and confirm it against the candidate set `['facebook', 'facebookgo', 'meta']`
  - Pin `FACEBOOK_NETWORK` in `src/platforms/facebook/client.ts` to the confirmed value (leading candidate: `facebookgo`, matching the `<network>go` cloud-bridge convention seen for `discordgo`/`slackgo`)
  - Observable done: the exact Messenger `network` string is written into `FACEBOOK_NETWORK` and noted in `research.md`; if no Messenger account can be connected, document that the candidate-set fallback remains in effect and the constant stays at the default
  - _Requirements: 2.2_
  - _Boundary: BeeperFacebookClient (client.ts FACEBOOK_NETWORK constant)_

- [x] 1. Register `facebook` across every platform-enumeration point
- [x] 1.1 Add `facebook` to the Platform union and PLATFORMS array (P)
  - Add `| 'facebook'` to the `Platform` union in `src/platforms/types.ts`
  - Add `'facebook'` to the `PLATFORMS` array in `src/sync-all.ts`
  - Observable done: `khipu sync facebook` and `khipu sync facebook@<account>` are valid dispatch targets (PLATFORM_SET includes `facebook`) and `khipu sync` (all-platform) includes Facebook in its loop
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 7.2_
  - _Boundary: Platform union (types.ts), PLATFORMS array (sync-all.ts)_

- [x] 1.2 Register the daemon factory and required env vars in watch.ts
  - Import `createFacebookAdapter` and add `facebook: createFacebookAdapter` to `ADAPTER_FACTORIES` in `src/watch.ts` (the total `Record<Platform, AdapterFactory>` makes this compile-required once the union grows)
  - Add `facebook: ['BEEPER_ACCESS_TOKEN']` to `REQUIRED_ENV_VARS` in `src/watch.ts`
  - Observable done: `tsc --noEmit` passes (no missing-key error on `ADAPTER_FACTORIES`); the daemon polls Facebook when `BEEPER_ACCESS_TOKEN` is set and logs a skip when it is absent
  - _Requirements: 1.5_
  - _Boundary: watch.ts ADAPTER_FACTORIES + REQUIRED_ENV_VARS_
  - _Depends: 1.1, 3.4_

- [x] 1.3 Add the Messenger web icon and the sync:facebook npm script (P)
  - Import `siMessenger` in `src/web/icons.ts` and add `facebook: siMessenger` to the `KNOWN` map
  - Add `"sync:facebook": "tsx src/platforms/facebook/sync.ts"` to `scripts` in `package.json`
  - Observable done: the built platform-icon map includes a `facebook` SVG entry; `npm run sync:facebook` resolves to the facebook sync script
  - _Requirements: 1.6_
  - _Boundary: web/icons.ts KNOWN map, package.json scripts_

- [x] 1.4 Add the Beeper platforms to the legacy env-var registry (P)
  - Add `signal: ['BEEPER_ACCESS_TOKEN']` and `facebook: ['BEEPER_ACCESS_TOKEN']` to `LEGACY_ENV_VARS` in `src/account-registry.ts`
  - Observable done: with no `khipu.config.json` and `BEEPER_ACCESS_TOKEN` set, `loadRegistry().listAccounts('facebook')` and `listAccounts('signal')` each return `['default']`; without the token, both return `[]`
  - _Requirements: 8.1, 8.2, 8.3_
  - _Boundary: account-registry.ts LEGACY_ENV_VARS_

- [x] 2. Implement BeeperFacebookClient in `src/platforms/facebook/client.ts`
  - Create the `src/platforms/facebook/` directory and `client.ts`, mirroring `src/platforms/signal/client.ts`
  - Export `FACEBOOK_NETWORK` and `FACEBOOK_NETWORK_CANDIDATES`; re-export the `Account`/`BeeperChat`/`BeeperMessage` types from `@beeper/desktop-api`
  - Implement `createBeeperFacebookClient(accessToken)` constructing `new BeeperDesktop({ accessToken, baseURL: 'http://localhost:23373' })`
  - `facebookAccountIds()` calls `accounts.list()`, filters to accounts whose `network` (lowercased) matches `FACEBOOK_NETWORK` or a candidate, and memoizes the resolved IDs
  - `listChats()` yields all Messenger chats via `chats.search({ accountIDs })`; `listChatMessages(chatId)` yields all messages newest-to-oldest via `messages.search({ chatIDs:[chatId], accountIDs, direction:'before' })`; `listNewChatMessages(chatId, since)` yields only messages after `since` via `messages.search({ ..., dateAfter: since.toISOString() })`
  - Every query includes the Messenger `accountIDs` filter; an empty account list makes every generator yield nothing (clean no-op)
  - Empty/missing `accessToken` throws before any network call; `APIConnectionError`/`AuthenticationError` are wrapped with a message naming Beeper Desktop
  - Observable done: `import { createBeeperFacebookClient, FACEBOOK_NETWORK } from './client'` compiles and is callable from `sync.ts`; the file is under 200 lines
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - _Depends: 0_

- [x] 3. Implement FacebookAdapter in `src/platforms/facebook/sync.ts`
- [x] 3.1 Implement mapChat and mapMessage pure mapping functions
  - Create `src/platforms/facebook/sync.ts` exporting `mapChat` and `mapMessage`, mirroring `signal/sync.ts`
  - `mapChat(c, account)` maps `id→external_id`, `title→name`, `single→'private'` else `'group'`, `username=null`, `platform:'facebook'`
  - `mapMessage(m, chatId)` maps `senderName`, `timestamp` (ISO ms to unix seconds), `isSender→is_sender` (0/1), `linkedMessageID→reply_to_external_id`, `text`; `type = 'image'` for `IMAGE`, `'text'` for non-empty `TEXT`, else `'other'`; `platform:'facebook'`
  - All `media_*` and `ocr_text` fields are explicitly `null` at insert time
  - Both functions are pure (no I/O, no imports from `client.ts`); deleted/hidden messages are skipped by the caller
  - Observable done: unit tests can import and assert on `mapChat`/`mapMessage` outputs without any Beeper or DB dependency
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 3.2 Implement the backfill sync loop with image collection
  - Add `runBackfillImpl(client, account, fetcher?)` iterating all chats from `client.listChats()`
  - For each chat: `upsertChat(mapChat(...))`, stream all messages via `client.listChatMessages()`, skip `isDeleted`/`isHidden`, `insertMessage(mapMessage(...))`, and collect `IMAGE` messages
  - Wrap each chat's fetch-and-insert block in a per-chat try/catch that logs and continues to the next chat
  - After messages: when a `fetcher` is present, call `processFacebookImageMessages(fetcher, chatId, imageMsgs)` and accumulate stored/failed counts
  - After each chat: `embedNewMessages([chatId])` and `embedNewChats([chatId])` guarded by `isIndexed`
  - Log `[facebook] Sync complete: N chats, M messages, images: S stored, F failed`
  - Observable done: a second backfill against the same mock data inserts zero new rows (idempotent); an image message yields a stored media row
  - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4_
  - _Depends: 3.1, 4_

- [x] 3.3 Implement the incremental sync loop
  - Add `runIncrementalImpl(client, since, account, fetcher?)` iterating all chats from `client.listChats()`
  - For each chat: upsert the chat, then branch on `getLastSyncedId(chatId)` — `null` fetches full history via `listChatMessages()`, otherwise fetches only messages after `since` via `listNewChatMessages(chatId, since)`
  - Apply the same deleted/hidden skip, per-chat try/catch, image collection + `processFacebookImageMessages`, and embedding hooks as backfill
  - Observable done: for a returning chat only post-`since` messages are fetched; for a first-time chat (`getLastSyncedId` null) full history is fetched; the runner persists the sync point after completion
  - _Requirements: 2.5, 4.1, 4.2, 4.3, 4.4_
  - _Depends: 3.1, 4_

- [x] 3.4 Wire adapter factory, credential guard, and CLI entrypoint
  - Implement `createFacebookAdapter(account, credentials)` reading `credentials.fields['BEEPER_ACCESS_TOKEN']`; empty token writes a human-readable error naming the credential + Beeper Desktop to stderr and calls `process.exit(1)`
  - `runBackfill`/`syncIncremental` build the client + `createFacebookAttachmentFetcher(token)` and call the impl functions; `startListener` is a no-op
  - Export a default `facebookAdapter` using `process.env['BEEPER_ACCESS_TOKEN']` as fallback credential; add `main()` calling `initDb` + `runPlatformSync(facebookAdapter, db, process.argv)` guarded by `require.main === module`
  - Observable done: `khipu sync facebook` runs end-to-end (resolves Messenger accounts, syncs, exits 0); a Beeper-unreachable error propagates to a non-zero exit for the explicit command and is caught-and-continued for `khipu sync`; the file is under 200 lines
  - _Requirements: 1.2, 2.4, 7.1, 7.3, 7.4_
  - _Depends: 3.1, 3.2, 3.3_

- [x] 4. Implement image sync in `src/platforms/facebook/image-sync.ts`
  - Create `image-sync.ts` mirroring `signal/image-sync.ts`
  - `createFacebookAttachmentFetcher(accessToken)` builds a `BeeperDesktop` and returns `fetchAttachmentBuffer(url)` using `assets.serve({ url })`, returning `null` on empty/error
  - `pickImageAttachment` selects the first `img` attachment with a `srcURL`/`id`; `extFromMime` maps mime to extension; `fetchFacebookAttachment` falls back to a `file://` local read
  - `processFacebookImageMessages(fetcher, chatId, imageMsgs)` resolves each row via `getMessageIdByExternalId`, skips rows already having `media_file_path`, fetches the buffer, `storeMedia({ platform:'facebook', ... })`, OCRs via `extractText`, and `updateMessageMedia`; per-message try/catch counts stored/failed and never throws
  - Observable done: a stored image message has `media_file_path`, dimensions, and `ocr_text` persisted; a fetch failure increments `failed` without throwing; the file is under 200 lines
  - _Requirements: 5.6, 5.7, 5.8_
  - _Boundary: processFacebookImageMessages (image-sync.ts)_

- [x] 5. Tests for the Facebook adapter
- [x] 5.1 Unit tests for mapChat, mapMessage, and the network filter
  - In `tests/facebook.test.ts`, assert `mapMessage` maps `sender_name`, `timestamp` (ms-to-unix-s), `is_sender` (0/1), `reply_to_external_id`, `text`; `type` is `image` for `IMAGE`, `text` for non-empty `TEXT`, `other` otherwise; all `media_*`/`ocr_text` are `null`
  - Assert `mapChat` maps a 1:1 chat to `private`, a group to `group`, uses `title` as `name`, and sets `platform='facebook'`
  - Assert the account-network filter matches `FACEBOOK_NETWORK` and each candidate case-insensitively and excludes a non-Messenger network
  - Observable done: all assertions pass in `tests/facebook.test.ts`
  - _Requirements: 2.2, 5.1, 5.2, 5.4, 5.5_
  - _Depends: 2, 3.1_

- [x] 5.2 Integration tests for adapter behavior against a mock client
  - In `tests/facebook.test.ts`, stub `BeeperFacebookClient` with controlled chats/messages
  - `runBackfillImpl` upserts all chats and inserts all messages; a second run produces zero additional rows
  - `runIncrementalImpl` fetches only post-`since` messages for a chat with a prior sync point and full history where `getLastSyncedId` returns `null`
  - A mock that throws on one chat's message fetch still processes the remaining chats; a mock with empty `facebookAccountIds()` completes with no rows and no error
  - `createFacebookAdapter` with empty `BEEPER_ACCESS_TOKEN` calls `process.exit(1)` and writes a Beeper-naming stderr message (mock `process.exit`)
  - Observable done: all integration cases pass in `tests/facebook.test.ts`
  - _Requirements: 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 7.1, 7.3_
  - _Depends: 3.2, 3.3, 3.4_

- [x] 5.3 Tests for image sync
  - In `tests/facebook-image-sync.test.ts`, stub the attachment fetcher and drive `processFacebookImageMessages`
  - An image message stores media (`media_file_path`, width/height) and OCR text via a stubbed `extractText`; an already-stored message is skipped; a fetch returning `null` increments `failed` without throwing
  - Observable done: all image-sync assertions pass
  - _Requirements: 5.6, 5.7, 5.8_
  - _Depends: 4_

- [x]* 5.4 Query-parity verification via existing MCP, CLI, and Web paths
  - In `tests/facebook.test.ts`, run a mocked Messenger sync into an in-memory DB, then exercise existing handlers: `handleListChats` returns the Messenger chat; `find_chat_by_name` resolves it; `handleListMessages`/`handleSearchMessages` return Messenger messages; `rebuildFtsIndex` + search includes Messenger text and image OCR text
  - Add a registry test: no `khipu.config.json` + `BEEPER_ACCESS_TOKEN` set ⇒ `loadRegistry` lists a `default` account for both `facebook` and `signal`
  - No changes to MCP tools, CLI commands, or Web UI query logic are required for any assertion
  - Observable done: all parity + registry assertions pass
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 8.1, 8.2_
  - _Depends: 1.4, 5.2_

## Implementation Notes

- All 18 sub-tasks implemented in one pass (2026-08-17), mirroring `src/platforms/signal/*` closely per design.md. `FACEBOOK_NETWORK` stays at its default `'facebookgo'` — no live Messenger-connected Beeper Desktop was available to confirm the exact value (see research.md Task 0 outcome); the case-insensitive candidate-set fallback (`facebook`/`facebookgo`/`meta`) covers the unverified cases.
- Fixing `tests/sync-all.test.ts` (hardcoded "7 platforms"/"signal last" assertions → 8/"facebook last") was necessary fallout of registering `facebook` in `PLATFORMS`, not scope creep — otherwise the pre-existing suite regresses.
- Full suite: 966/966 passing (up from 868 baseline + 85 new facebook tests + adjusted sync-all tests), `tsc --noEmit` clean, under Node 24 (native `better-sqlite3-multiple-ciphers` ABI lock — see project memory).
- Per user's global git policy, no `git add`/`git commit` was run for this feature; all changes are left uncommitted in the working tree for manual review and commit.
