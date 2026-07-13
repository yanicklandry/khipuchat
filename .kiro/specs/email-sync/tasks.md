# Implementation Plan

- [ ] 1. Foundation: project setup and type registration
- [ ] 1.1 (P) Register imapflow dependency and sync:email npm script
  - Add `imapflow ^1.3.3` to `dependencies` in `package.json`
  - Add `"sync:email": "tsx src/platforms/email/sync.ts"` to `scripts` in `package.json`
  - Verified: `npm run sync:email --help` resolves without "script not found" error
  - _Requirements: 5.1_
  - _Boundary: package.json_

- [ ] 1.2 (P) Extend Platform union and account-registry for email
  - Add `'email'` literal to the `Platform` union in `src/platforms/types.ts`
  - Add `email` entry to `LEGACY_ENV_VARS` in `src/account-registry.ts` with value `['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS']`
  - Verified: TypeScript compiler accepts `platform: 'email'` without type error; `credentialsFor('email', 'default')` resolves the three env vars via the legacy path
  - _Requirements: 3.5_
  - _Boundary: src/platforms/types.ts, src/account-registry.ts_

- [ ] 2. IMAP client layer
- [ ] 2.1 Define EmailClient interface and message types
  - Create `src/platforms/email/client.ts` with the `RawEmailMessage` interface (messageId, inReplyTo, from, subject, date, text fields)
  - Add `EmailSearchCriteria` interface with optional `since: Date`
  - Add `EmailClient` interface with `fetchFolder(folder, criteria?)` returning `AsyncGenerator<RawEmailMessage>` and `listSpecialFolder(use: '\\Sent')` returning `Promise<string | null>`
  - Declare `createEmailClient(host, user, pass): EmailClient` export
  - Verified: file compiles cleanly under TypeScript strict mode with no `any`; a test fixture can implement `EmailClient` without type errors
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 5.3_

- [ ] 2.2 Implement imapflow-backed EmailClient
  - Implement `createEmailClient`: connect to IMAP port 993 (TLS); always `logout` in `finally`
  - `fetchFolder(folder, criteria?)`: open folder read-only; if `criteria.since` provided, run IMAP `SEARCH since` and fetch matching UIDs in slices of 200; otherwise fetch all messages in sequence ranges of 200; strip angle brackets from `Message-ID` and `In-Reply-To`; extract first plain-text body part (trimmed; `null` when absent or empty); drop messages whose `Message-ID` is absent
  - `listSpecialFolder('\\Sent')`: list mailboxes, find one with `\Sent` special-use attribute; fall back to names `Sent`, `Sent Items`, `Sent Messages`; return `null` when none match
  - Verified: a mock fixture implementing `EmailClient` and a real `createEmailClient` call both yield `RawEmailMessage` values with expected field shapes
  - _Requirements: 2.1, 2.2, 2.3, 5.3_

- [ ] 3. Sync orchestration
- [ ] 3.1 Implement pure domain helpers: hashStr, thread resolver, message mapper
  - Implement `hashStr(s: string): number` using FNV-1a (reuse pattern from sibling adapters)
  - Implement `parseSenderName(from: string): string`: extract display name before `<`, fall back to raw `from` value
  - Implement `resolveThreadExternalId(messageId, inReplyTo, threadMap)`: if `inReplyTo` is a key in `threadMap`, inherit its thread id and record `messageId` under the same id; otherwise record and return `messageId` as a new thread root
  - Implement `mapMessage(raw, chatId, userEmail): Message`: populate all fields per the data model (external_id, sender_name, text, type, timestamp as epoch seconds, is_sender via case-insensitive From match, reply_to_external_id, platform: 'email')
  - Verified: each function passes all scenarios from the Testing Strategy section without any DB or network dependency
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2_

- [ ] 3.2 Implement runBackfillImpl: folder iteration, thread resolution, persistence
  - Implement `runBackfillImpl(client, userEmail, criteria?, account?)` in `src/platforms/email/sync.ts`
  - Call `client.listSpecialFolder('\\Sent')` to discover the Sent folder; warn on stderr and skip if `null`
  - For each `RawEmailMessage` from INBOX then Sent: skip with stderr warning if no `messageId`; call `resolveThreadExternalId` to get thread root; call `upsertChat` once per unique thread root (guarded by `seenChats` map) with `name: raw.subject || raw.messageId`; call `mapMessage`; skip if `raw.text` is `null`; otherwise call `insertMessage`
  - After both folders complete, call `embedNewMessages` and `embedNewChats` on changed rows
  - Verified: running against INBOX + Sent fixtures inserts the expected thread and message counts with correct field values; a second run against the same fixtures produces zero additional rows
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 5.2_

- [ ] 3.3 Implement adapter wiring and main() entry point
  - Implement `createEmailAdapter(account, credentials): PlatformAdapter`: read `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASS` from `credentials.fields`; if any are missing, write the missing names to stderr and call `process.exit(1)`; return a `PlatformAdapter` with `platform: 'email'`, `account`, `runBackfill` (calls `runBackfillImpl`), `syncIncremental(db, since)` (calls `runBackfillImpl` with `{ since }`), and `startListener` as a no-op
  - Export `emailAdapter` bound to the `default` account from `process.env`
  - Implement `main()` calling `runPlatformSync(emailAdapter, initDb(), process.argv)`; catch errors, log to stderr, and exit 1
  - Verified: `main()` with all three env vars set routes through `runPlatformSync` without error; omitting any env var exits 1 with a message listing the missing names
  - _Requirements: 1.1, 1.2, 5.1, 5.3_

- [ ] 4. Tests
- [ ] 4.1 Unit tests for pure domain functions
  - Test `resolveThreadExternalId`: root detection (no inReplyTo), reply inherits parent thread id, unknown-parent reply becomes a new root (out-of-order tolerance)
  - Test `mapMessage`: `is_sender` set by case-insensitive From match against userEmail; `type: 'other'` and `text: null` when no body; `timestamp` in epoch seconds; `reply_to_external_id` populated from inReplyTo
  - Test `parseSenderName`: display name extracted from `Name <addr>`, falls back to raw From
  - Verified: all unit cases pass under `npm test` with no network or DB access
  - _Requirements: 3.2, 3.4, 3.6, 4.1, 4.2_

- [ ] 4.2 Integration tests with mock EmailClient and in-memory DB
  - Test `runBackfillImpl` with INBOX + Sent fixtures: correct thread grouping, one chat per root, chat name derived from subject
  - Test idempotency: running twice against the same fixtures yields no additional chat or message rows
  - Test skip on no plain-text: a message with `text: null` inserts no message row; thread chat may still exist if other messages in the thread carry text
  - Test missing Sent folder: `listSpecialFolder` returns `null` => INBOX-only sync completes without error
  - Test message without Message-ID: message is skipped, not inserted
  - Test `createEmailAdapter` credential guard: missing any of the three env vars causes the guard to identify the missing names (tested against the guard logic directly, not a live process)
  - Verified: all integration cases pass under `npm test` using `:memory:` SQLite
  - _Requirements: 1.2, 2.1, 2.2, 3.1, 3.3, 4.1, 4.2, 4.3, 5.2_
