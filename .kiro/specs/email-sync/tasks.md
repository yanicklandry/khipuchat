# Implementation Plan

- [ ] 1. Foundation — types, dependency, script, test scaffold
- [ ] 1.1 Register 'email' platform and add imapflow
  - Add `'email'` to the `Platform` union in `src/platforms/types.ts`
  - Add `"imapflow": "^4.0.0"` to `dependencies` in `package.json`
  - Add `"sync:email": "tsx src/platforms/email/sync.ts"` to scripts
  - Create `src/platforms/email/` directory
  - `npm test` passes with no new failures
  - _Requirements: 3.5, 5.1_

- [ ] 1.2 Create test file with mock IMAP client
  - Create `tests/email.test.ts` with a `makeMockEmailClient(inboxMessages, sentMessages)` factory returning an `AsyncGenerator`-based mock
  - Confirm the test file compiles cleanly
  - _Requirements: 2.1, 2.2_

- [ ] 2. Core — IMAP client and mappers (parallel)
- [ ] 2.1 (P) Implement the imapflow-based email client
  - Create `src/platforms/email/client.ts` with `RawEmailMessage`, `EmailClient` interfaces
  - Implement `createEmailClient(host, user, pass)` using `imapflow`: connect, lock mailbox, fetch messages in UID batches of 200, yield `RawEmailMessage` objects
  - Implement `listSpecialFolder('\\Sent')`: list mailboxes and find one with `\Sent` special-use flag; fall back to trying `Sent`, `Sent Items`, `Sent Messages`; return `null` if not found
  - Parse `Message-ID`, `In-Reply-To`, `From`, `Subject`, `Date` headers and plain-text body part
  - `createEmailClient` yields correct `RawEmailMessage` objects for a test IMAP server fixture
  - _Requirements: 1.1, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3_
  - _Boundary: Email Client (client.ts)_

- [ ] 2.2 (P) Implement thread resolver and message mapper
  - Create `src/platforms/email/sync.ts` with `hashStr` (FNV-1a)
  - Implement `resolveThreadChatId(messageId, inReplyTo, threadMap)`: returns existing chatId from threadMap if inReplyTo matches; otherwise creates new root chatId via `hashStr(messageId)` and inserts it into the map
  - Implement `mapMessage(raw, chatId, userEmail)`: `is_sender` derived from `raw.from.includes(userEmail)`; `type='other'` when `raw.text` is null; timestamp in Unix seconds
  - Thread resolver correctly groups replies under their root chatId even when inReplyTo points to an already-seen message
  - _Requirements: 3.1, 3.2, 3.4, 3.6, 4.1, 4.2_
  - _Boundary: Thread Resolver + Row Mappers (sync.ts)_

- [ ] 3. Backfill runner and adapter
- [ ] 3.1 Implement runBackfillImpl
  - Add `runBackfillImpl(client, userEmail)` to `sync.ts`
  - Fetch INBOX then Sent (using `listSpecialFolder`; skip with warning if null); for each message: skip if no `Message-ID` (log warning); resolve chatId; `upsertChat` on first encounter of root; `insertMessage`
  - Running twice with the same mock client produces no duplicate records
  - _Requirements: 2.1, 2.2, 3.3, 4.1, 4.3, 5.2, 5.3_

- [ ] 3.2 Implement adapter and main entry point
  - Add `emailAdapter: PlatformAdapter` and `main()` with credential validation (exit 1 listing missing vars if any of `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASS` is unset)
  - Add `require.main === module` guard
  - Running with missing credentials exits non-zero with an actionable message
  - _Requirements: 1.1, 1.2, 5.1_

- [ ] 4. Tests
- [ ] 4.1 Unit and integration tests
  - `resolveThreadChatId`: root message creates new chatId; reply inherits parent chatId; unknown parent creates new root
  - `mapMessage`: correct `is_sender` from email address matching; `type='other'` for null text; timestamp conversion
  - `runBackfillImpl` with mock client: INBOX + Sent messages correctly stored and threaded; idempotency
  - Missing env vars exits with code 1 listing missing names
  - All tests pass with `npm test`
  - _Requirements: 1.2, 3.1, 3.6, 4.2, 5.2_
