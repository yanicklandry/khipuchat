# Implementation Plan

- [ ] 1. Foundation: shared filter contract and data layer
- [x] 1.1 Extend db.ts to support filter parameters on message and chat queries, and add cross-archive message listing
  - Verify `getPlatformLastSyncedAt(platform, account): number | null` exists in db.ts; add it if absent
  - Add `since`, `until`, `type`, `limit` params to `searchMessages`
  - Add `since`, `until`, `type`, `limit` params to the existing chats query used by `handleListChats`
  - Add `listArchiveMessages(filters)` function for cross-chat message listing, defaulting `type` to `'text'` when omitted
  - `searchMessages({ query: 'test', since: 1735689600 })` returns only messages after that timestamp
  - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 9.3_
  - _Boundary: db.ts_

- [x] 1.2 Define `QueryFilters` in query-handlers.ts and extend handler signatures
  - Export the `QueryFilters` interface: `{ platform?, account?, since?, until?, type?, limit? }`
  - Extend `handleSearchMessages(query, filters?)` to accept `QueryFilters` and pass all fields to `searchMessages`
  - Extend `handleListChats(filters?)` signature; keep backward compatibility with existing call sites
  - Add `handleListArchiveMessages(filters?)` delegating to `listArchiveMessages` with the `type='text'` default
  - `handleListChats({ platform: 'telegram' })` returns only telegram chats
  - _Requirements: 8.1, 8.2, 8.7, 9.1, 9.2, 9.4, 10.1, 10.4_
  - _Boundary: query-handlers.ts_

- [x] 1.3 Create cli-filters.ts: shared CLI flag parser
  - `parseQueryFilters(argv)` parses `--platform`, `--account`, `--since`, `--until`, `--type`, `--limit` and returns `{ ok: true, filters, rest }` or `{ ok: false, error }`
  - `parseDateArg` converts ISO date strings (`YYYY-MM-DD` and full ISO) to unix seconds; rejects ambiguous formats
  - Invalid platform name, non-numeric/zero/negative `--limit`, or unparseable date returns `{ ok: false, error }`
  - `parseQueryFilters(['--platform', 'telegram', '--limit', '5', 'myquery'])` returns `{ ok: true, filters: { platform: 'telegram', limit: 5 }, rest: ['myquery'] }`
  - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.9, 9.3, 10.1, 10.3_
  - _Boundary: cli-filters.ts_

- [ ] 2. Core: surface adapter implementations
- [x] 2.1 (P) Update MCP server as the reference implementation
  - Add `since`, `until`, `type`, `limit` to `search_messages`, `list_chats`, and `list_messages` inputSchemas
  - Make `list_messages.chat_id` optional; when omitted, route to `handleListArchiveMessages` instead of the per-chat handler
  - Wire all new args into the shared handlers by building `QueryFilters` from MCP tool arguments
  - `list_messages` invoked via MCP without `chat_id` returns archive-wide messages filtered by provided criteria
  - _Requirements: 8.7, 9.4, 10.1, 10.4_
  - _Boundary: mcp.ts_
  - _Depends: 1.2_

- [x] 2.2 (P) Update CLI search to use the shared filter parser
  - Replace ad-hoc argument parsing in the `search` case of `cli.ts` with `parseQueryFilters`
  - Pass the resulting `QueryFilters` to `handleSearchMessages`
  - If `parseQueryFilters` returns `{ ok: false }`, print the error and exit non-zero
  - Missing `<query>` positional arg prints search usage and exits non-zero
  - `parseQueryFilters(['--platform', 'telegram', '--limit', '5', 'foo'])` produces a `QueryFilters` that `handleSearchMessages` accepts and returns the same rows as an equivalent MCP call
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_
  - _Boundary: cli.ts_
  - _Depends: 1.2, 1.3_

- [x] 2.3 (P) Create khipu-sync-status.ts entrypoint
  - For each platform in PLATFORMS, read configured accounts from the account registry and last successful sync timestamp from `getPlatformLastSyncedAt`
  - Omit platforms with no configured accounts from output
  - Show `never` for accounts that have never been synced
  - When invoked directly (`tsx src/khipu-sync-status.ts`), the script prints the status table to stdout and exits 0
  - _Requirements: 2.1, 2.2, 2.3_
  - _Boundary: khipu-sync-status.ts_

- [x] 2.4 (P) Create khipu-list.ts entrypoint
  - Dispatch on first positional arg: `chats` calls `handleListChats`; `messages` calls `handleListArchiveMessages`
  - Invocation with no sub-subcommand (bare `list`) prints list usage and exits non-zero
  - Parse all 6 filter flags via `parseQueryFilters`; propagate parse errors as an error message + non-zero exit
  - Empty result set prints an empty-results message and exits 0
  - When invoked directly as `tsx src/khipu-list.ts messages --type text --limit 10`, displays up to 10 text messages or the empty-results message and exits 0
  - _Requirements: 9.1, 9.2, 9.3, 9.5, 9.6_
  - _Boundary: khipu-list.ts_
  - _Depends: 1.2, 1.3_

- [ ] 3. Router: extend resolveCommand with new routing and validation
- [x] 3.1 Fix sync routing, add ResolveDeps injection, and add the `list` route
  - Add `ResolveDeps` interface with `listAccounts(platform): readonly string[]` and make `resolveCommand` accept `deps?: ResolveDeps`
  - Route bare `sync` (no args) to `khipu-sync-status.ts`
  - Route `sync all` to `watch.ts` (replacing current `sync-all.ts`), forwarding `--once` and `--force` via argv pass-through
  - Add `list` route pointing to `khipu-list.ts`
  - Verify (no new wiring needed) that existing `index` route already forwards all args including `--force` to `index-embeddings.ts` via `argv.slice(1)`
  - `khipu sync` (bare) spawns `khipu-sync-status.ts`; `khipu sync all --once` spawns `watch.ts` with `['--once']`; `khipu list chats` spawns `khipu-list.ts` with `['chats']`
  - _Requirements: 1.1, 1.5, 2.1, 3.1, 3.2, 5.1, 5.2, 5.3, 6.1, 6.2, 7.1, 7.2, 7.3, 9.1_

- [x] 3.2 Add `<platform>@<account>` parsing and validation to resolveCommand
  - For `sync <token>` where `<token>` contains `@`, split on the first `@` to extract platform and account
  - Validate the platform against `PLATFORMS`; validate the account against `deps.listAccounts(platform)`
  - Forward `['--account', account, ...rest]` as explicit args to the platform sync script
  - Unknown account for a valid platform returns `{ kind: 'error', message: ... , exitCode: 1 }`
  - `resolveCommand(['sync', 'telegram@myaccount'], { listAccounts: () => ['myaccount'] })` produces a `run` resolution with args `['--account', 'myaccount']`; invalid account produces an `error` resolution
  - _Requirements: 3.3, 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 3.3 Add per-subcommand `--help` detection and update USAGE text
  - Detect `--help` or `-h` immediately following a known subcommand and return `{ kind: 'help', message: <subcommand-usage>, exitCode: 0 }`
  - Add per-subcommand usage strings for `search`, `list`, and `sync`
  - Update root USAGE constant to include `list` and `sync <platform>[@account]`
  - `resolveCommand(['search', '--help'])` returns `{ kind: 'help', exitCode: 0 }` with search-specific usage; `resolveCommand(['unknowncmd'])` returns `{ kind: 'error', exitCode: 1 }` with root usage
  - _Requirements: 1.2, 1.3, 1.4_

- [ ] 4. Validation: tests
- [x] 4.1 (P) Unit tests for resolveCommand
  - Test: bare `sync` resolves to `khipu-sync-status.ts`; `sync all` resolves to `watch.ts`; `sync all --once` forwards `--once`; `sync all --force` forwards `--force`
  - Test: `list` resolves to `khipu-list.ts`; unknown subcommand returns `{ kind: 'error', exitCode: 1 }`
  - Test: `sync telegram@myaccount` with injected `listAccounts` returning `['myaccount']` produces `run` with args including `--account myaccount`; injected `listAccounts` returning `[]` produces `error` exit
  - Test: `sync unknownplatform` returns `error` listing valid platform names with exit 1
  - Test: `search --help` returns `{ kind: 'help', exitCode: 0 }`
  - `vitest run` passes all new tests
  - _Requirements: 1.2, 1.3, 1.4, 2.1, 3.1, 3.2, 4.1, 4.2, 4.4, 4.5, 9.5_
  - _Boundary: tests/khipu.test.ts_

- [x] 4.2 (P) Unit tests for parseQueryFilters and parseDateArg
  - Test each of the 6 flags is parsed into the correct field and stripped from `rest`
  - Test invalid platform → `{ ok: false }`; non-numeric `--limit` → `{ ok: false }`; zero/negative `--limit` → `{ ok: false }`
  - Test `parseDateArg('2025-01-01')` returns unix seconds 1735689600; invalid format returns `undefined`
  - `vitest run` passes all new tests
  - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.9, 10.3_
  - _Boundary: tests/cli-filters.test.ts_

- [x] 4.3 Integration parity tests
  - For a fixed test dataset, `handleSearchMessages(query, filters)` returns identical rows whether `QueryFilters` is built from `parseQueryFilters` (CLI path) or constructed directly as MCP arg coercion would
  - Verify `--type`, `--since/--until`, and `--limit` each measurably narrow results for `search` and `list messages`
  - Verify `list_messages` with `chat_id` preserves per-chat behavior; without `chat_id` lists archive-wide
  - Repeat parity assertion for `handleListChats` and `handleListArchiveMessages`
  - `vitest run` passes all new parity tests
  - _Requirements: 8.7, 9.4, 10.4_
  - _Depends: 2.1, 2.2_
  - _Boundary: tests/query-parity.test.ts_

- [x] 4.4 E2E smoke tests
  - `khipu --help` exits 0 and output includes `list` and `sync <platform>[@account]`
  - `khipu sync` exits 0 and prints the status table; an unsynced account shows `never`; a platform with no accounts is absent
  - `khipu search "term" --platform telegram --since 2025-01-01 --limit 5` exits 0 and prints matching rows or the empty-results message
  - `khipu list messages --type text --limit 10` exits 0; `khipu list` (bare) exits non-zero and prints list usage
  - `vitest run` passes all new E2E tests
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 8.1, 8.8, 9.2, 9.5_
  - _Depends: 3.1, 3.2, 3.3_
  - _Boundary: tests/khipu-e2e.test.ts_
