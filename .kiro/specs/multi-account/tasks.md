# Implementation Plan

- [ ] 1. Database schema migrations
- [ ] 1.1 Extract migration logic and add account dimension to chats
  - Create `src/db-migrations.ts` and move the `runMigrations()` body out of `db.ts`; `db.ts` calls into it
  - Add `account TEXT NOT NULL DEFAULT 'default'` and `external_id TEXT` columns to `chats` guarded by column-existence checks
  - Backfill `external_id = CAST(id AS TEXT)` and `account = 'default'` for all existing rows
  - Create `UNIQUE INDEX IF NOT EXISTS ux_chats_identity ON chats(platform, account, external_id)`
  - Running migrations on an existing DB leaves all `chats.id` values unchanged so `messages.chat_id` and `vec_*.rowid` remain valid
  - _Requirements: 2.1_
  - _Boundary: db-migrations_

- [ ] 1.2 Rebuild sync_state to composite (platform, account) primary key
  - Guard with a PK-shape check so the step is skipped when already applied
  - Inside one transaction: create `sync_state_new` with PK `(platform, account)`, copy existing rows with `account = 'default'`, drop old table, rename new
  - After migration `sync_state` contains one row per `(platform, account)` with all pre-existing rows preserved
  - _Requirements: 2.2_
  - _Boundary: db-migrations_

- [ ] 2. (P) Account configuration registry
- [ ] 2.1 Load accounts and enumerate by platform
  - Create `src/account-registry.ts`; parse `khipu.config.json` when present
  - When absent or empty, synthesize one `'default'` account per platform from legacy env vars, reproducing today's credential behavior exactly
  - Expose `listAccounts(platform)` returning account names in config-declared order
  - Expose `credentialsFor(platform, account)` returning resolved credential fields
  - `loadRegistry()` returns an `AccountRegistry`; this module must not import `db.ts`
  - On a legacy install, `listAccounts('telegram')` returns `['default']` with credentials from env vars
  - _Requirements: 1.1, 1.5_
  - _Boundary: account-registry_

- [ ] 2.2 Validate registry entries and resolve secrets
  - Resolve credential values prefixed with `$` from `process.env`; if a variable is unset, throw a `missing_env` RegistryError that names the variable and the owning account (fail fast before any sync starts)
  - Reject duplicate account names on the same platform with a `duplicate_name` error identifying platform and name
  - Reject empty account names with an `empty_name` error
  - Reject a WeChat account list containing more than one entry with a `wechat_multi_account` error
  - All name comparisons are case-sensitive
  - `loadRegistry()` throws a descriptive error on any violation; no partial registry is returned
  - _Requirements: 1.2, 1.3, 1.4_
  - _Boundary: account-registry_

- [ ] 3. Account-aware database persistence layer
- [ ] 3.1 Update Chat type and upsertChat to return surrogate id
  - Add `external_id: string` and `account: string` (default `'default'`) to the `Chat` interface in `db.ts`
  - Update `upsertChat` to resolve by `(platform, account, external_id)` using `INSERT … ON CONFLICT … DO UPDATE … RETURNING id`
  - `upsertChat` returns the surrogate `id` (number) on both insert and update paths; adapters use this id for message/sync-state calls
  - Existing `chats.id` values are never reassigned; `messages.chat_id` and vec rowids remain valid
  - _Requirements: 2.1_
  - _Boundary: db_

- [ ] 3.2 Update sync_state accessors to (platform, account) key
  - Change signatures: `getPlatformLastSyncedAt(platform, account)` and `setPlatformLastSyncedAt(platform, account, ts)`
  - SQL reads and writes by `(platform, account)` tuple
  - `getPlatformLastSyncedAt` returns `null` for a first-time account (no row present)
  - _Requirements: 2.2_
  - _Boundary: db_

- [ ] 3.3 Add optional account filter to searchMessages
  - Add `account?: string` parameter to `searchMessages`; when provided, append `AND c.account = ?` to the existing join
  - When `account` is omitted, results span all accounts (unchanged behaviour)
  - Add `account: string` to `SearchResult`; derive it from the join — no `account` column on `messages`
  - _Requirements: 4.1, 4.2_
  - _Boundary: db_

- [ ] 4. Extracted account-aware query handlers
- [ ] 4.1 Extract query handlers from mcp.ts into query-handlers.ts
  - Create `src/query-handlers.ts`; move `handleListChats`, `handleFindChatByName`, `handleListMessages`, `handleSearchMessages`, `handleGetChatSummary`, `handleSemanticFindContacts`, `handleSemanticSearchMessages` and their result types out of `mcp.ts`
  - `mcp.ts` re-exports from `query-handlers.ts` so existing test imports continue to resolve
  - `mcp.ts` line count drops below 200 lines after extraction; note that `mcp.ts` is also modified in task 7.1 — do not leave conflicting stubs
  - _Requirements: 4.1, 4.2_
  - _Boundary: query-handlers_

- [ ] 4.2 Thread account filter through all query handlers
  - Add `account?: string` to each handler's signature; pass it through to the underlying `db`/`vec-db` call
  - Omitting `account` returns results spanning all accounts
  - Add `account: string` to `ChatResult` and `MessageResult`; update `handleListMessages` with a `JOIN chats` to expose and optionally filter account
  - Every handler result contains an `account` field populated from the data layer
  - _Requirements: 4.1, 4.2_
  - _Boundary: query-handlers_

- [ ] 4.3 Add listArchiveAccounts helper to query layer
  - Implement `listArchiveAccounts(): { platform: string; account: string }[]` in `query-handlers.ts` via `SELECT DISTINCT platform, account FROM chats ORDER BY platform, account`
  - Tasks 8.1 (CLI) and 9.2 (Web UI) depend on this helper to determine when to show account labels
  - Calling `listArchiveAccounts()` on a single-account install returns one entry per platform with `account = 'default'`
  - _Requirements: 5.1, 6.1_
  - _Boundary: query-handlers_

- [ ] 5. (P) Vec-db account filter and result field
  - Add `account?: string` to `ContactFilters` and `MessageFilters`; when set, the post-filter loop applies an equality check on `c.account`
  - Select `c.account` in the enrichment join query
  - Add `account: string` to `SemanticContactResult` and `SemanticMessageResult`
  - Vec table rowids and the embedding index are unchanged; omitting the filter returns semantic results across all accounts with `account` populated on each row
  - _Requirements: 4.1, 4.2_
  - _Boundary: vec-db_
  - _Depends: 3.1_

- [ ] 6. Platform adapter factories and per-account sync runner
- [ ] 6.1 Update PlatformAdapter interface and add AdapterFactory type
  - Add `readonly account: string` to the `PlatformAdapter` interface in `src/platforms/types.ts`
  - Define `AdapterFactory = (account: string, credentials: AccountCredentials) => PlatformAdapter`
  - TypeScript strict-mode compilation passes with the updated interface; all existing adapter implementations must satisfy the new shape
  - _Requirements: 3.1, 3.2_
  - _Boundary: platforms/types_

- [ ] 6.2 Update sync-runner to iterate configured accounts with error isolation
  - Implement `runAllAccountsSync(platform, factory, db, argv)` in `sync-runner.ts`
  - Enumerate `registry.listAccounts(platform)`, resolve credentials, build an adapter per account via the factory, and run `runPlatformSync` for each in sequence
  - Catch per-account errors, record them in `AccountSyncOutcome`, and continue to remaining accounts
  - `runPlatformSync` reads `getPlatformLastSyncedAt(platform, account)` to choose incremental vs. backfill; on success writes `(platform, account)` timestamp
  - Running two accounts where account 1 throws still produces a complete outcome array with account 2's sync completed
  - _Requirements: 3.1, 3.3_
  - _Boundary: sync-runner_

- [ ] 6.3 (P) Update platform adapters to factory pattern
  - For each multi-account platform (telegram, imessage, discord, slack, whatsapp, email): expose `createXAdapter(account, credentials): PlatformAdapter`
  - Each adapter's `mapChat` sets `external_id` (platform-native id as string) and `account`; uses the id returned by `upsertChat` for subsequent message and sync-state calls
  - Keep legacy singleton export as `createXAdapter('default', legacyEnvCreds)` so existing callers are unaffected
  - WeChat `sync.ts` is unchanged (single-account; not driven by `runAllAccountsSync`)
  - Running `createSlackAdapter('work', workCreds)` writes chats with `account = 'work'`; integration testing of 6.2 requires 6.3 factory signatures to be in place
  - _Requirements: 3.1, 3.2_
  - _Boundary: platforms/adapters_
  - _Depends: 6.1_

- [ ] 7. MCP surface: thin wiring and account parameter in tool schemas
  - _Depends: 4.1, 4.2_
- [ ] 7.1 Import from query-handlers and add account to tool schemas
  - `mcp.ts` imports all handlers and result types from `query-handlers.ts` (4.1 must be complete before this task; coordinate with that file boundary)
  - Add optional `account` string property to input schemas of `list_chats`, `find_chat_by_name`, `list_messages`, `search_messages`, `semantic_find_contacts`, `semantic_search_messages`
  - `CallTool` handler extracts `account` from input and passes it to the corresponding handler
  - MCP tool descriptions mention the `account` parameter so agents can discover it
  - `mcp.ts` stays under 200 lines
  - _Requirements: 4.1, 4.2_
  - _Boundary: mcp_

- [ ] 8. (P) CLI surface: --account filter and output labeling
  - _Depends: 4.2, 4.3_
- [ ] 8.1 Add --account flag and conditional account column to CLI output
  - Parse `--account <name>` (index-based, consistent with existing `--min-similarity`); pass to `handleListChats`, `handleSearchMessages`, and other relevant handlers
  - When output rows come from more than one account (detected via `listArchiveAccounts()`), print the account name beside the platform for each row
  - When `--account` is omitted, CLI returns results spanning all accounts
  - Running with `--account work` on a single-account install where `account = 'default'` returns the same set as running without the flag (empty filter result is acceptable)
  - _Requirements: 5.1_
  - _Boundary: cli_

- [ ] 9. (P) Web surface: account filter and conditional label
  - _Depends: 4.2, 4.3_
- [ ] 9.1 Add ?account= query parameter to web API routes
  - `/api/chats` and `/api/search` accept optional `?account=` query param; pass to handlers
  - Each response object includes `account` from the handler result
  - An unknown account name returns an empty array — not an error
  - _Requirements: 6.1_
  - _Boundary: web/routes_

- [ ] 9.2 Add account filter control and conditional label to web UI
  - Populate a filter dropdown from `listArchiveAccounts()` that lets the user narrow to one account
  - Show account label beside the platform indicator only when `listArchiveAccounts()` reveals more than one account for that platform
  - On a single-account install the chat list renders with no visible change
  - _Requirements: 6.1_
  - _Boundary: web/ui_

- [ ] 10. Unit tests
- [ ] 10.1 (P) account-registry unit tests
  - Legacy fallback: absent config yields one `'default'` account per env-configured platform
  - `$VAR` resolution: set var ⇒ resolved value; unset var ⇒ `missing_env` error naming variable and account
  - Validation: duplicate name same platform, empty name, WeChat multi-account rejection
  - Case-sensitivity: `'Work'` and `'work'` are treated as distinct names
  - `listAccounts` preserves config-declared order
  - All 5 registry behaviours (1.1–1.5) covered by passing tests
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Boundary: account-registry_

- [ ] 10.2 (P) Database migration and persistence unit tests
  - Migrating a pre-account DB: row count on `chats` unchanged; all rows have `account = 'default'` and `external_id` set
  - `sync_state` rebuild: existing platform rows preserved under composite `(platform, account)` key
  - `upsertChat`: two accounts sharing the same `external_id` on the same platform produce distinct surrogate ids
  - `upsertChat` is idempotent: repeat insert with same identity returns same id
  - All tests use `:memory:` SQLite; no mocks
  - _Requirements: 2.1, 2.2_
  - _Boundary: db, db-migrations_
  - _Depends: 3.1, 3.2_

- [ ] 11. Integration and E2E tests
- [ ] 11.1 Sync-runner integration tests
  - Two accounts synced in sequence; `AccountSyncOutcome` array contains one entry per account
  - Error isolation: account 1 throws, account 2 completes; outcome has `ok: false` for account 1 and `ok: true` for account 2
  - First-run account (no sync state) triggers full backfill; second run uses per-account timestamp for incremental sync
  - _Requirements: 3.1, 3.3_
  - _Boundary: sync-runner_

- [ ] 11.2 (P) Adapter factory and credential isolation tests
  - `createSlackAdapter('work', workCreds)` writes chats with `account = 'work'`; messages resolve to that chat's surrogate id
  - Legacy singleton `createSlackAdapter('default', legacyEnvCreds)` writes chats with `account = 'default'`
  - Credentials from one account are never visible to a factory instance of another account
  - _Requirements: 3.2_
  - _Boundary: platforms/adapters_

- [ ] 11.3 Surface E2E tests
  - MCP `list_chats` with `account = 'work'` returns only work chats; omitting `account` returns all; every result carries `account`
  - MCP `search_messages` and semantic search tools behave identically: scoped when `account` provided, all-account when omitted
  - CLI `--account work` filters results; output displays account name beside platform when more than one account is present in the archive
  - Web `GET /api/chats?account=work` returns filtered results with `account`; `GET /api/chats` returns all with `account` on each object
  - Web UI shows account label only for platforms with more than one account in the archive
  - _Requirements: 4.1, 4.2, 5.1, 6.1_
