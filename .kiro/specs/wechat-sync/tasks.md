# Implementation Plan

- [ ] 1. Foundation — platform registration and test scaffold
- [ ] 1.1 Register 'wechat' as a valid platform and add the sync script
  - Add `'wechat'` to the `Platform` union in `src/platforms/types.ts`
  - Add `"sync:wechat": "tsx src/platforms/wechat/sync.ts"` to the `scripts` block in `package.json`
  - Create the `src/platforms/wechat/` directory
  - `npm test` still passes with no new failures after the type change
  - _Requirements: 2.3, 4.1, 4.4_

- [ ] 1.2 Create the test file with a mock WeChat DB factory
  - Create `tests/wechat.test.ts` (Vitest, mirrors the structure of `tests/imessage.test.ts`)
  - Implement a `makeMockChatDb(contactId, rows)` helper that returns an in-memory `better-sqlite3` Database with a `Chat_<contactId>` table seeded with `WechatMessageRow`-shaped rows
  - Implement a `makeMockContactDb(entries)` helper that returns an in-memory Database with a contacts table seeded with `{ m_nsUsrName, m_nsNickName }` rows
  - The test file imports cleanly with no TypeScript errors
  - _Requirements: 2.1, 2.2_

- [ ] 2. Core — contact resolver and row mappers (parallel)
- [ ] 2.1 (P) Build the WeChat contact resolver
  - Create `src/platforms/wechat/contacts.ts`
  - Implement `buildWechatContactMap(containerPath)`: recursively search for `WCDB_Contact.db` under `containerPath`; query it for `m_nsUsrName → m_nsNickName` mappings; return a `ReadonlyMap<string, string>`
  - On any failure (file not found, query error, unreadable): log a warning to stderr and return an empty map
  - `buildWechatContactMap` called with a path containing a mock WCDB_Contact.db returns correct name mappings
  - _Requirements: 3.1, 3.2_
  - _Boundary: Contact Resolver (contacts.ts)_

- [ ] 2.2 (P) Implement row mappers and shared helpers
  - Create `src/platforms/wechat/sync.ts` with the `WechatMessageRow` interface (`MesSvrID`, `CreateTime`, `Message`, `Des`)
  - Implement `hashStr(s)`: FNV-1a 32-bit hash — same algorithm as iMessage's `hashGuid`, applied to a string
  - Implement `extractContactId(filePath)`: strips the path prefix and `.db` suffix to return the bare contact ID (e.g. `wxid_abc123` or `roomid@chatroom`)
  - Implement `mapChat(contactId, contactMap)`: `type = 'group'` when contactId ends with `@chatroom`, else `'private'`; name from contactMap with fallback to raw contactId; `platform = 'wechat'`
  - Implement `mapMessage(row, chatId, contactId, contactMap)`: `is_sender = 1` when `Des === 0`; `type = 'other'` when `Message` is null; `timestamp = CreateTime` (no epoch offset); `external_id = MesSvrID.toString()`
  - All five pure functions pass their unit tests
  - _Requirements: 2.2, 2.4, 2.5, 3.3_
  - _Boundary: Row Mappers (sync.ts)_

- [ ] 3. Filesystem layer — DB discovery and opener
- [ ] 3.1 Implement the WeChat DB discoverer
  - Add `discoverChatDbs(containerPath)` to `src/platforms/wechat/sync.ts`
  - Recursively traverse `containerPath` collecting all files matching `Chat_*.db`
  - On `ENOENT` at the container level: throw with a message stating WeChat for Mac must be installed
  - On `EACCES` or `EPERM` at the container level: throw with a message instructing the user to grant Full Disk Access to Terminal in System Settings → Privacy & Security
  - Returns an empty array (not an error) when the container exists but contains no Chat_*.db files
  - `discoverChatDbs` called with a non-existent path throws with the install guidance message
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 3.2 Implement the DB opener with encryption error handling
  - Add `openWechatDb(filePath)` to `src/platforms/wechat/sync.ts`
  - Opens using `new Database(filePath, { readonly: true })`; never passes a cipher key (Req 5.3)
  - On error where `message` includes `'file is not a database'`: logs a stderr warning naming the file and explaining likely SQLCipher encryption; returns `null`
  - On any other open error: logs a stderr warning with file path and error message; returns `null`
  - Caller receives `null` and continues to the next file without throwing
  - `openWechatDb` called with a path to a non-SQLite file returns `null` and does not throw
  - _Requirements: 1.4, 5.1, 5.2, 5.3_

- [ ] 4. Orchestration — sync core and adapter
- [ ] 4.1 Implement the WeChat sync core (runBackfillImpl)
  - Add exported `runBackfillImpl(chatDbPaths, contactMap)` to `src/platforms/wechat/sync.ts`
  - For each path: call `openWechatDb`; skip on `null`; derive `contactId` and `chatId`; call `upsertChat(mapChat(...))`; read all rows from `Chat_<contactId>` table; call `insertMessage(mapMessage(...))` for each row
  - Log a completion summary to stdout: number of DB files processed and total messages imported
  - Running `runBackfillImpl` twice with the same mock DBs produces identical records in the archive (idempotency guaranteed by `INSERT OR IGNORE`)
  - _Requirements: 2.1, 2.4, 4.2, 4.3_

- [ ] 4.2 Implement the WeChat adapter and main entry point
  - Add `wechatAdapter: PlatformAdapter` to `sync.ts` with `platform: 'wechat'`, `runBackfill` (resolves container path, calls `discoverChatDbs`, `buildWechatContactMap`, `runBackfillImpl`), and a no-op `startListener`
  - Add `main()` and the `require.main === module` guard following the iMessage pattern
  - `npm run sync:wechat` executes without crashing on a machine with WeChat installed and FDA granted
  - _Requirements: 4.1, 4.4_

- [ ] 5. Test coverage
- [ ] 5.1 Unit tests for pure functions
  - `hashStr`: stable output for known inputs; never returns 0
  - `extractContactId`: correctly strips path prefix and `.db` suffix for both private and `@chatroom` IDs
  - `mapChat`: group type for `@chatroom` contactIds; private type otherwise; name from contactMap; raw contactId when not in map
  - `mapMessage`: `is_sender` derived correctly from `Des`; `type = 'other'` when `Message` is null; `timestamp` matches `CreateTime` directly; `external_id` is `MesSvrID.toString()`
  - All unit tests pass with `npm test`
  - _Requirements: 2.2, 2.4, 2.5_

- [ ] 5.2 Integration tests for the sync core
  - `runBackfillImpl` with 2 mock Chat_*.db files (one private contactId, one `@chatroom`) → correct chat and message records stored in an in-memory archive DB
  - Re-running `runBackfillImpl` with the same inputs produces no duplicate records (idempotency)
  - Re-running with additional rows appended to mock DBs adds only the new messages, leaving previously stored records unchanged
  - `buildWechatContactMap` with a mock WCDB_Contact.db returns correct name entries; with no DB returns an empty map without throwing
  - All integration tests pass with `npm test`
  - _Requirements: 2.1, 3.1, 3.2, 4.2, 4.3_

- [ ] 5.3 Error path tests
  - `discoverChatDbs` with a non-existent path throws with a message referencing WeChat installation
  - `openWechatDb` given a file that opens but triggers `SQLITE_NOTADB` returns `null` (does not throw)
  - `buildWechatContactMap` with an inaccessible container path returns an empty map without throwing
  - All error-path tests pass with `npm test`
  - _Requirements: 1.2, 1.3, 1.4, 5.2_
