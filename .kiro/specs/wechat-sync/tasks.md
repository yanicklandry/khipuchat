# Implementation Plan

- [ ] 1. Platform registration and project configuration
- [ ] 1.1 Register 'wechat' in the Platform union and project scripts
  - Add the `'wechat'` literal to the `Platform` union in `src/platforms/types.ts`
  - Add `"sync:wechat"` and `"setup:wechat"` entries to `package.json` scripts, each invoking the correct entry point via `tsx`
  - Add `'wechat'` to the serial platform list in `src/sync-all.ts`
  - Running `npm run sync:wechat` resolves without an "unknown script" error; `'wechat'` is accepted as a valid `Platform` value by the TypeScript compiler
  - _Requirements: 2.3, 4.1, 4.4_

- [ ] 2. Test file scaffolding and in-memory DB utilities
- [ ] 2.1 Create test file stubs with shared in-memory helpers
  - Create `tests/wechat.test.ts` and `tests/wechat-image.test.ts` with import stubs and top-level `describe` blocks
  - Add a helper that initialises a fresh `initDb(':memory:')` archive database for each test
  - Add helpers to create mock WeChat V3 and V4 message databases in memory (schema-only, no data yet)
  - `npm test` runs and the wechat test suites are discovered with zero failures (all tests pending or skipped at this stage)
  - _Requirements: 1.4, 2.1, 2.2, 4.2_

- [ ] 3. Container validation and DB discovery
- [ ] 3.1 Implement container path resolution and validation
  - Implement `resolveXwechatRoot()` returning the default WeChat container path, overridable via the `WECHAT_CONTAINER` environment variable (used by tests)
  - Implement `validateContainer(containerRoot)` calling `fs.accessSync`; throw a "WeChat for Mac is not installed" message on `ENOENT` and a Full Disk Access guidance message on any other access error
  - `validateContainer` called with a non-existent path throws the install-guidance message (observable in test via `expect(...).toThrow(...)`)
  - _Requirements: 1.2, 1.3_

- [ ] 3.2 Implement user directory discovery and message DB enumeration
  - Implement `findUserDir(xwechatRoot)` returning the first `wxid_*` directory found under `xwechat_files`, or `null` if none exists
  - Implement `discoverMessageDbs(userDir)` returning the subset of `db_storage/message/message_N.db` paths (N = 0..11) that actually exist on disk, without opening any file
  - When a valid user directory is present with message DBs, `discoverMessageDbs` returns a non-empty array containing only paths confirmed to exist
  - _Requirements: 1.1_

- [ ] 4. Key resolver and DB opener
- [ ] 4.1 Implement key map loading and per-DB hex-key resolution
  - Implement `loadWechatKeyMap()` reading `.wechat-keys.json` from the process CWD and returning a `Map<string, string>` (salt → hexKey); return an empty map with a stderr warning if the file is missing or unparseable
  - Implement `resolveHexKey(filePath, keyMap)` reading the first 16 bytes of a DB file as the salt and returning the matching hex key, or `''` if no match (open as plaintext)
  - Key material never appears in any log output; `loadWechatKeyMap` returns an empty map rather than throwing when `.wechat-keys.json` is absent
  - _Requirements: 5.1_

- [ ] 4.2 Implement the read-only DB opener with graceful error degradation
  - Implement `openWechatDb(filePath, hexKey)` opening with `{ readonly: true }`; when `hexKey` is non-empty, apply SQLCipher PRAGMAs (`cipher='sqlcipher'`, `legacy=4`, raw key `"x'<hex>'"`) before probing with `PRAGMA user_version`
  - On `SQLITE_NOTADB` with no key: log "encrypted — run `npm run setup:wechat`"; on `SQLITE_NOTADB` with a key tried: log "wrong key or not a SQLCipher database"; on any other error: log file path + message; return `null` in all failure cases without throwing
  - Implement `listChatTables(db)` querying `sqlite_master` for `Chat_%` or `Msg_%` table names; return `[]` on query failure
  - `openWechatDb` given a file that triggers `SQLITE_NOTADB` returns `null` without throwing (observable in test via `expect(result).toBeNull()`)
  - _Requirements: 1.4, 5.1, 5.2, 5.3_

- [ ] 5. Contact resolver
- [ ] 5.1 Implement buildWechatContactMap supporting both V3 and V4 contact schemas
  - Create `src/platforms/wechat/contacts.ts`; import `resolveHexKey` from `./sync` to decrypt contact DBs with the same key-map logic
  - Probe the contact directory for `contact.db` (V4) first, then recursively for `WCDB_Contact.db` (legacy plaintext)
  - Try tables in priority order: `contact`, `WCContact`, `Contact`, `Friend`; resolve V4 `username`/`nick_name` (prefer `remark` when non-empty) or legacy `m_nsUsrName`/`m_nsNickName` (prefer `m_nsRemark`)
  - Return an empty `ContactMap` on any failure (missing file, wrong key, unknown schema, query error) after logging a warning to stderr; callers are never thrown at
  - `buildWechatContactMap` called with a non-existent contact directory returns an empty map without throwing (observable in test)
  - _Requirements: 3.1, 3.2, 3.3_
  - _Depends: 4.1_

- [ ] 6. (P) Key-extraction setup script
- [ ] 6.1 Write the opt-in local key-extraction helper
  - Create `scripts/setup-wechat.sh` that performs Frida-based in-process key extraction from the running WeChat Mac application and writes a salt→hexKey map to `.wechat-keys.json` in the project root
  - The script must be macOS-only, read-only relative to WeChat internals, and must never transmit any data off the machine
  - Running `npm run setup:wechat` executes the script without a "command not found" error; when WeChat is running and Frida is available, `.wechat-keys.json` is produced in the project root
  - _Requirements: 5.1_
  - _Boundary: scripts/setup-wechat.sh_

- [ ] 7. Schema detection and V4 lookup maps
- [ ] 7.1 Implement schema detection for V3 and V4 WeChat DB layouts
  - Implement `buildSchemaInfo(db, tableName)` reading `PRAGMA table_info`; when both `create_time` and `server_id` columns are present return V4 SELECT (`server_id, create_time, message_content, WCDB_CT_message_content, real_sender_id, local_type`) with `timeCol = 'create_time'`; otherwise return legacy aliases (`msgSvrID, CreateTime, Message, Des, Type`) with `timeCol = 'CreateTime'`
  - Both V4 and V3 SELECT shapes produce row objects compatible with `WechatMessageRow` when run against in-memory mock tables of each schema
  - _Requirements: 2.2_

- [ ] 7.2 Implement V4 identity lookup maps from Name2Id
  - Implement `buildTableNameMap(db)` querying `Name2Id WHERE is_session = 1` and returning a map of `Msg_<md5(user_name)>` → `user_name`; return an empty map when `Name2Id` is absent
  - Implement `buildSenderIdMap(db)` mapping `Name2Id.rowid → user_name` for V4 `real_sender_id` resolution; return an empty map when absent
  - Both functions return empty maps (not errors) when `Name2Id` does not exist, allowing V3 DBs to pass through without special-casing
  - _Requirements: 2.2, 2.4_

- [ ] 8. Row mappers
- [ ] 8.1 Implement chat mapper and helper utilities
  - Implement `hashStr(s)` as FNV-1a 32-bit, always returning a positive non-zero integer
  - Implement `tableNameToChatId(tableName)` as `hashStr(tableName)`
  - Implement `extractSelfWxid(userDir)` stripping the trailing `_<4hex>` suffix from the wxid directory name
  - Implement `mapChat(tableName, displayName, userName?)` producing a `Chat` with `platform = 'wechat'`, `external_id = tableName`, `account = 'default'`, and `type = 'group'` when the identifier contains `@chatroom`, else `type = 'private'`
  - `mapChat` with a `@chatroom` table name returns `type = 'group'`; all other inputs return `type = 'private'` (observable in unit test)
  - _Requirements: 2.3, 2.4_

- [ ] 8.2 Implement message mapper with full V3/V4 and sender_name support
  - Implement `extractWechat4Text(content)` stripping the `sender_wxid:\n` group-chat prefix from string content; returning `null` for `Buffer` (zstd compressed) content
  - Implement `mapMessage(row, chatId, opts?)` covering: `external_id` from `server_id` (V4) or `MesSvrID`/`msgSvrID` (V3); `is_sender` via `senderIdMap.get(real_sender_id) === selfWxid` (V4, default `0` when opts absent) or `Des === 0 || isSend === 1` (V3); image detection for type codes 4, 43, 49; `type = 'other'` when text is null; `sender_name = opts.senderName` for received messages, `null` for sent messages
  - `mapMessage` with a V3 received row (`Des = 1`) and a resolved `senderName` opt returns `sender_name` equal to that name (Req 3.3); a sent row (`Des = 0`) returns `sender_name = null`
  - `mapMessage` with a null `Message` field returns `type = 'other'`, not `'text'` (Req 2.5)
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 3.3_

- [ ] 9. Sync core: backfill and incremental implementations
- [ ] 9.1 Implement runBackfillImpl iterating all discovered DBs and tables
  - Implement `runBackfillImpl(messageDbs, contactMap, keyMap, userDir?)` iterating each DB path: resolve hex key, open (skip on `null`), build `tableNameMap` + `senderIdMap`, call `listChatTables`
  - Per table: resolve display name via the fallback chain (`contactMap.get(userName) ?? userName ?? contactMap.get(tableName) ?? tableName`), `upsertChat(mapChat(...))`, read all rows via `buildSchemaInfo` SELECT, `insertMessage(mapMessage(...))` per row, `setLastSyncedAt(chatId, now)` after the table, then `embedNewMessages`/`embedNewChats` when the vector index is present
  - Running `runBackfillImpl` twice over identical in-memory mock DBs produces no duplicate rows in the archive (row count is identical after both runs)
  - _Requirements: 2.1, 3.3, 4.2, 4.3_

- [ ] 9.2 Implement runIncrementalImpl with per-chat timestamp filtering
  - Implement `runIncrementalImpl(messageDbs, contactMap, keyMap, since, userDir?)` with the same per-DB and per-table structure as backfill but adding `WHERE <timeCol> > <since>` to each table SELECT
  - Per-table read errors are caught and logged; the loop continues to the next table so a single bad table never aborts the full run (Req 1.4)
  - After a partial incremental run, only rows with timestamps after `since` appear as new in the archive while previously stored rows are unchanged (observable via row count assertions in integration test)
  - _Requirements: 1.4, 2.1, 4.2, 4.3_

- [ ] 10. WeChat adapter and entry point
- [ ] 10.1 Implement wechatAdapter and main() wired through runPlatformSync
  - Implement `wechatAdapter` satisfying `PlatformAdapter`: `platform = 'wechat'`, `account = 'default'`; `runBackfill` calls `validateContainer → findUserDir → discoverMessageDbs → loadWechatKeyMap → buildWechatContactMap → runBackfillImpl`; `syncIncremental` mirrors this with `runIncrementalImpl`; `startListener` is a no-op
  - Implement `main()` calling `initDb('./khipuchat.db')` and `runPlatformSync(wechatAdapter, db, process.argv)`, guarded by `require.main === module`; exit 0 on success, exit 1 on unhandled rejection
  - Container-level failures (missing container, no wxid user dir) exit non-zero and print actionable human-readable messages to stderr
  - Running `npm run sync:wechat` against a WeChat installation with plaintext DBs exits 0 and prints a summary of chats and messages processed to stdout
  - _Requirements: 1.1, 1.2, 1.3, 4.1, 4.4_
  - _Depends: 9.1, 9.2_

- [ ] 11. Unit tests for pure functions
- [ ] 11.1 Write unit tests for chat and message mappers
  - Test `hashStr`: always positive, never 0, deterministic; distinct inputs produce distinct outputs
  - Test `mapChat`: `platform = 'wechat'`; `@chatroom` identifier → `type = 'group'`; others → `type = 'private'`; `external_id = tableName`; `account = 'default'`
  - Test `mapMessage` V3 branch: `external_id` from `msgSvrID`/`MesSvrID`; `is_sender` from `Des`/`isSend`; `type = 'other'` when `Message` is null; `timestamp = CreateTime`; `reply_to_external_id = null`
  - Test `mapMessage` V4 branch: `is_sender` via `senderIdMap` + `selfWxid` (default 0 when opts absent); `external_id` from `server_id`; text extracted via `extractWechat4Text`
  - Test Req 3.3 contract: received messages carry the resolved `sender_name` from opts; sent messages keep `sender_name = null`
  - All unit tests in this group pass
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 3.3_

- [ ] 11.2 Write unit tests for schema detection and contact resolver
  - Test `buildSchemaInfo` against an in-memory V4 table (has `create_time`, `server_id`): returns `timeCol = 'create_time'` and V4 column list
  - Test `buildSchemaInfo` against an in-memory V3 table: returns `timeCol = 'CreateTime'` and legacy alias column list
  - Test `buildWechatContactMap` with a V4 in-memory `contact` table: returns display names for known usernames; `remark` is preferred when non-empty
  - Test `buildWechatContactMap` with a legacy `WCContact` schema: returns names from `m_nsNickName` / `m_nsRemark`
  - Test `buildWechatContactMap` with no contact DB present: returns an empty map without throwing
  - All schema detector and contact resolver tests pass
  - _Requirements: 3.1, 3.2_

- [ ] 12. Integration tests and error-path coverage
- [ ] 12.1 Write integration tests for the sync core
  - Test `runBackfillImpl` over ≥2 in-memory mock DBs (one private-contact table, one `@chatroom` table): correct chat and message rows appear in the archive DB with `platform = 'wechat'`
  - Test idempotency: call `runBackfillImpl` twice with identical mock inputs and assert the archive row count is the same after both runs (Req 4.2)
  - Test additive sync: append new rows to a mock DB and re-run; assert only the new rows were added and previously stored rows are unchanged (Req 4.3)
  - All sync core integration tests pass
  - _Requirements: 2.1, 4.2, 4.3_

- [ ] 12.2 Write error-path and image-message tests
  - Test `validateContainer` throws the install-guidance string when given a non-existent path (Req 1.2)
  - Test `openWechatDb` returns `null` without throwing when given a file whose header triggers `SQLITE_NOTADB` (Req 5.2)
  - Test `buildWechatContactMap` returns an empty map without throwing when no contact DB is present (Req 3.2)
  - In `tests/wechat-image.test.ts`: test that rows with WeChat image type codes (4, 43, 49) are stored as `type = 'image'` with empty text, not omitted (Req 2.5)
  - All error-path and image-message tests pass
  - _Requirements: 1.2, 1.4, 2.5, 3.2, 5.2_
