# Research & Design Decisions: khipu-cli

## Summary
- **Feature**: `khipu-cli`
- **Discovery Scope**: Extension (existing TypeScript/tsx codebase; light discovery + code verification)
- **Key Findings**:
  - The parity requirement (Req 10) is satisfiable structurally: `src/query-handlers.ts` is already the single shared seam behind both `src/mcp.ts` and `src/cli.ts`. Making both surfaces translate into one canonical `QueryFilters` object and call the same handlers guarantees parity by construction rather than by convention.
  - Several requirements are already met by existing assets: `bin` is registered (`package.json` → `bin/khipu`), `index-embeddings.ts` emits a progress bar (Req 5.3), `web/server.ts` logs its URL at startup (Req 7.1), and both `MessageType` and chat `type` columns exist (Req 10 `--type` needs no schema change).
  - Every per-platform `sync.ts` entrypoint constructs a single hard-coded adapter with `account = 'default'` and calls `runPlatformSync`; none read `--account` or iterate configured accounts. Honoring `@account` inside sync scripts is therefore genuinely out of this spec's boundary (owned by `multi-account`). This spec's testable responsibility is limited to parsing, validating, and forwarding the account.

## Research Log

### Router topology and the `sync` reroute
- **Context**: Req 2 (bare `sync` = status) and Req 3 (`sync all` = daemon) both currently resolve incorrectly.
- **Sources Consulted**: `src/khipu.ts` (`resolveCommand`), `src/sync-all.ts` (`runAllPlatforms`), `src/watch.ts` (daemon).
- **Findings**:
  - Bare `khipu sync` currently routes to `sync-all.ts` (a destructive one-shot sync), not a status display.
  - `khipu sync all` also routes to `sync-all.ts`, but the continuous daemon with `--once`, SIGINT/SIGTERM drain, and per-platform intervals lives in `src/watch.ts`, which is not wired to the CLI.
  - `watch.ts` already satisfies Req 3.1/3.2/3.4 (daemon loop, `--once` single pass with exit 0, graceful shutdown). `--force` handling in the daemon path depends on `incremental-sync`/`sync-watcher` and is out of boundary.
- **Implications**: The router must reroute `sync all` → `watch.ts` and bare `sync` → a new status entry. `sync-all.ts`'s `runAllPlatforms` becomes unreferenced by the CLI but is retained (it exports `PLATFORMS`, consumed by `khipu.ts` and `watch.ts`); its removal is out of scope.

### Query filter parity seam
- **Context**: Req 8/9/10 require `--platform/--account/--since/--until/--type/--limit` on `search`, `list chats`, `list messages`, with identical results to MCP.
- **Sources Consulted**: `src/query-handlers.ts`, `src/db.ts` (`searchMessages`), `src/mcp.ts` (tool `inputSchema` definitions + `CallToolRequest` dispatch), `src/cli.ts`.
- **Findings**:
  - `handleSearchMessages` / `searchMessages` support only `chatId/platform/account` today; `since/until/type/limit` are absent from both CLI and MCP.
  - `handleListChats` supports `platform/account/limit` but not `since/until/type`.
  - MCP `list_messages` requires `chat_id` (per-chat), whereas CLI `list messages` must list across the whole archive with filters — these are different operations.
  - `--type` is polysemous: for `list chats` it means chat type (`user`/`group`); for `search`/`list messages` it means `MessageType` (`text`/`voice`/…).
- **Implications**: Introduce a canonical `QueryFilters` contract in `query-handlers.ts`. Extend the three handlers plus the underlying DB queries to honor it. Make MCP `list_messages.chat_id` optional so an omitted `chat_id` triggers cross-chat filtered listing, mirroring the CLI. MCP schemas are updated first (reference implementation), then CLI mirrors.

### `@account` parsing, validation, and forwarding
- **Context**: Req 4.2/4.5 require `khipu sync <platform>@<account>` targeting and a non-zero error for an unconfigured account.
- **Sources Consulted**: All `src/platforms/*/sync.ts` entrypoints, `src/sync-runner.ts` (`runPlatformSync`, `runAllAccountsSync`), `src/account-registry.ts` (`loadRegistry`).
- **Findings**:
  - Entry scripts call `runPlatformSync(singletonAdapter, db, process.argv)` with `account='default'`; they ignore `--account`.
  - `runAllAccountsSync` exists but is not wired into the entrypoints (that wiring is `multi-account`'s responsibility).
  - `loadRegistry().listAccounts(platform)` already enumerates configured accounts and is an allowed, already-built dependency.
- **Implications**: The router parses `<platform>@<account>`, validates the account against `loadRegistry().listAccounts(platform)`, and forwards `--account <name>` to the platform child. Whether the child honors `--account` is out of boundary. To keep `resolveCommand` pure and testable, the configured-account lookup is injected as a dependency (default backed by `loadRegistry`).

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: Inline everything in `khipu.ts` + `cli.ts` | Add list routing, sync-status, and all filter parsing directly into the two existing files | Fewest new files | Pushes `cli.ts` (250 lines) and the pure router well past the 200-line guideline; mixes DB access into the pure resolver | Rejected |
| B: Dedicated entry scripts + shared filter parser | New `khipu-sync-status.ts`, `khipu-list.ts`, `cli-filters.ts`; router stays a pure spawner | Files stay small; router stays pure and testable; parity parser shared by CLI surfaces | Two extra child-process entrypoints to navigate | **Selected** |
| C: Hybrid (inline sync-status into router) | Same as B but sync-status printed directly inside `khipu.ts` | Avoids one child spawn | Forces DB + registry imports into the currently pure resolver, breaking its testability and spawn-only design | Rejected: purity of the router outweighs one saved spawn |

## Design Decisions

### Decision: Canonical `QueryFilters` seam guarantees CLI/MCP parity
- **Context**: Req 10.4 forbids capability drift in either direction.
- **Alternatives Considered**:
  1. Duplicate filter logic in each surface and rely on tests to catch drift.
  2. Route both surfaces through one shared handler layer with a single filter type.
- **Selected Approach**: Define `QueryFilters { platform?, account?, since?, until?, type?, limit? }` in `query-handlers.ts`. `mcp.ts` and the CLI parsers both build this object and call the same `handleSearchMessages` / `handleListChats` / `handleListArchiveMessages`. Parity becomes a structural property.
- **Rationale**: The shared seam already exists; formalizing the filter contract removes the drift surface entirely.
- **Trade-offs**: Both surfaces must be updated together; slightly larger handler signatures.
- **Follow-up**: Add a parity integration test asserting identical results for equivalent CLI and MCP invocations.

### Decision: Make MCP `list_messages.chat_id` optional for cross-chat parity
- **Context**: CLI `list messages` lists across the archive; MCP `list_messages` is per-chat.
- **Selected Approach**: When `chat_id` is supplied, preserve existing per-chat behavior. When omitted, dispatch to `handleListArchiveMessages(filters)` (new cross-chat handler). This is additive and backward compatible.
- **Rationale**: Satisfies parity without adding a second MCP tool name.
- **Trade-offs**: `list_messages` now has two modes; documented in the tool description.
- **Follow-up**: Confirm existing Claude Desktop callers (which always pass `chat_id`) are unaffected.

### Decision: `--since/--until` accept ISO dates on the CLI, unix seconds at the seam
- **Context**: Req 8.4 requires date-range filtering.
- **Selected Approach**: A `parseDateArg` helper converts CLI `--since 2025-01-01` to unix seconds; MCP receives unix seconds directly (agents compute timestamps). Both converge on unix seconds in `QueryFilters`, so results match.
- **Rationale**: Terminal users type dates; agents pass timestamps. Converging at the handler preserves "same results".
- **Trade-offs**: Two input formats, one internal representation.
- **Follow-up**: Invalid date strings must error with a non-zero exit (Req 10.3).

### Decision: Eager `@account` validation in the router via injected lookup
- **Context**: Req 4.5 needs a non-zero error for an unconfigured account, and no sync child validates accounts today.
- **Selected Approach**: `resolveCommand(argv, deps)` receives an injected `listAccounts(platform)` (default backed by `loadRegistry`). The router validates the parsed account and returns `kind: 'error'` when it is not configured.
- **Rationale**: Places the required validation where it can actually run, using an allowed existing dependency, while keeping `resolveCommand` pure for tests.
- **Trade-offs**: The router gains an injected dependency; still pure given the injection.
- **Follow-up**: Forwarding `--account` is honored by sync children only after `multi-account` wires `runAllAccountsSync` — a documented revalidation trigger.

## Risks & Mitigations
- MCP `inputSchema` changes touch a live Claude Desktop integration — keep all additions optional and backward compatible; cover with a parity test.
- Rerouting bare `sync` away from the destructive `sync-all.ts` changes existing muscle memory — surface the new status behavior in help text and the subcommand `--help`.
- `--force` on `sync all` is forwarded but not honored by the daemon within this spec — document as an adjacent dependency on `incremental-sync`/`sync-watcher` to avoid a false parity claim.

## References
- `src/khipu.ts`, `src/cli.ts`, `src/query-handlers.ts`, `src/db.ts`, `src/mcp.ts`, `src/watch.ts`, `src/sync-runner.ts`, `src/account-registry.ts`, `src/platforms/*/sync.ts` — verified in-repo during discovery.

---

# Implementation Gap Validation: khipu-cli (2026-07-13)

## Analysis Summary

- **Scope**: Post-implementation verification against all 10 requirements
- **Approach**: Direct code inspection of all modified and new source files + test inventory
- **Finding**: All in-boundary requirements are implemented. No gaps remain within spec scope.
- **Residual adjacencies**: 4 out-of-scope stubs confirmed absent by design (sync-watcher, incremental-sync, multi-account, semantic-search)

## Per-Requirement Coverage

| Req | Summary | File(s) | Status |
|-----|---------|---------|--------|
| 1.1 | bin registration | `package.json` (`bin: { khipu: bin/khipu }`), `bin/khipu` shim | Implemented |
| 1.2 | Root --help / subcommand list | `khipu.ts` `resolveCommand`, `USAGE` constant | Implemented |
| 1.3 | Per-subcommand --help | `khipu.ts` `isHelpFlag` detection + `SUBCOMMAND_USAGE` map | Implemented |
| 1.4 | Unknown subcommand error + non-zero exit | `khipu.ts` default error branch | Implemented |
| 1.5 | npm link + tsx, no build step | `bin/khipu` spawns `tsx src/khipu.ts` via `process.execPath` | Implemented |
| 2.1 | Sync status: list platform/account/timestamp | `khipu-sync-status.ts` `printSyncStatus()` | Implemented |
| 2.2 | Omit platforms with no accounts | `khipu-sync-status.ts` `accounts.length === 0` guard | Implemented |
| 2.3 | "never" for unsynced accounts | `khipu-sync-status.ts` `formatTimestamp(null)` | Implemented |
| 3.1 | sync all daemon | `khipu.ts` routes `sync all` → `watch.ts` | Implemented |
| 3.2 | sync all --once exits after one pass | forwarded to `watch.ts` argv | Implemented (behavior in watch.ts) |
| 3.3 | --force forwarded via argv pass-through | argv.slice(2) forwarded | Implemented (effect in adjacent specs) |
| 3.4 | SIGINT/SIGTERM clean exit | inherited from `watch.ts` | Implemented |
| 4.1 | khipu sync <platform> one-shot | `khipu.ts` platform routing | Implemented |
| 4.2 | khipu sync <platform>@<account> | `khipu.ts` `@` split + forward `--account` | Implemented |
| 4.3 | --force forwarded | argv rest forwarded | Implemented |
| 4.4 | Unknown platform error | `!PLATFORM_SET.has(platform)` → error listing PLATFORMS | Implemented |
| 4.5 | Unconfigured account error | `!configuredAccounts.includes(account)` via injected `listAccounts` | Implemented |
| 5.1 | khipu index incremental | routes to `index-embeddings.ts` | Implemented |
| 5.2 | khipu index --force full rebuild | argv pass-through with `--force` | Implemented |
| 5.3 | Index progress output | already emitted by `index-embeddings.ts` | Implemented |
| 6.1 | khipu mcp starts MCP server | routes to `mcp.ts` | Implemented |
| 6.2 | MCP SIGINT/SIGTERM clean exit | inherited from `mcp.ts` | Implemented |
| 7.1 | khipu web starts web server + prints URL | routes to `web/server.ts` | Implemented |
| 7.2-7.3 | Web server keeps running + clean SIGTERM | inherited from `web/server.ts` | Implemented |
| 8.1 | khipu search <query> displays results | `cli.ts` `search` case | Implemented |
| 8.2-8.6 | All 6 filter flags on search | `cli-filters.ts` `parseQueryFilters` | Implemented |
| 8.7 | Parity with MCP for same query+filters | shared `handleSearchMessages(query, QueryFilters)` seam | Implemented |
| 8.8 | Empty results: message + exit 0 | `cli.ts` "No results found." branch | Implemented |
| 8.9 | Missing query: usage + non-zero exit | `cli.ts` usage guard | Implemented |
| 9.1 | khipu list chats | `khipu-list.ts` `chats` dispatch | Implemented |
| 9.2 | khipu list messages | `khipu-list.ts` `messages` dispatch | Implemented |
| 9.3 | All 6 filters on list chats/messages | `cli-filters.ts` + `handleListChats`/`handleListArchiveMessages` | Implemented |
| 9.4 | Parity with MCP for same filters | shared `QueryFilters` seam in `query-handlers.ts` | Implemented |
| 9.5 | Bare list: usage + non-zero exit | `khipu-list.ts` guard on missing sub-subcommand | Implemented |
| 9.6 | Empty results: message + exit 0 | `khipu-list.ts` "No chats/messages found." | Implemented |
| 10.1 | All 6 flags on every query subcommand | `cli-filters.ts` shared by `cli.ts` and `khipu-list.ts` | Implemented |
| 10.2 | Same platform values as MCP | `PLATFORMS` from `sync-all.ts` used everywhere | Implemented |
| 10.3 | Invalid filter value: error + non-zero | `parseQueryFilters` `{ ok: false, error }` propagated | Implemented |
| 10.4 | No unilateral capability drift | `QueryFilters` in `query-handlers.ts`; MCP extended to match; parity test in `tests/query-parity.test.ts` | Implemented |

## Out-of-Boundary Stubs (Confirmed Absent by Design)

| Stub | Owned By | CLI Responsibility |
|------|----------|-------------------|
| Daemon polling loop / per-platform intervals | `sync-watcher` | Router forwards argv to `watch.ts`; behavior lives in that file |
| `--force` deep re-read effect inside daemon | `incremental-sync` | Flag forwarded; no implementation in this spec |
| `--account` honored inside per-platform sync scripts | `multi-account` | Router validates + forwards `--account`; sync scripts hardcode `account='default'` |
| Embedding computation inside `khipu index` | `semantic-search` | Router calls `index-embeddings.ts`; implementation lives there |

## Test Inventory

| Test File | Coverage |
|-----------|----------|
| `tests/khipu.test.ts` | `resolveCommand` unit tests: all routing branches, @account validation, --help detection |
| `tests/cli-filters.test.ts` | `parseQueryFilters` and `parseDateArg` unit tests |
| `tests/khipu-sync-status.test.ts` | `printSyncStatus` unit tests |
| `tests/khipu-list.test.ts` | `runList` unit tests including empty results, usage error |
| `tests/query-parity.test.ts` | Integration parity: CLI filter path vs MCP arg coercion |
| `tests/khipu-e2e.test.ts` | E2E smoke: --help, sync status, search, list commands |

## Conclusion

The implementation is complete within this spec's boundary. All 10 requirements are satisfied by the existing code. The spec is ready for `/kiro-validate-impl` or implementation handoff to adjacent specs (`sync-watcher`, `incremental-sync`, `multi-account`, `semantic-search`) whose stubs are forwarded correctly.

---

# Gap Analysis: khipu-cli (2026-07-14)

## Analysis Summary

- **Approach**: Re-verification against requirements after prior implementation; direct code inspection of all relevant source files
- **Finding**: Implementation is fully complete. Zero gaps remain within this spec's boundary.
- **Effort**: S (already implemented)
- **Risk**: Low — all requirements satisfied structurally, parity guaranteed by shared `QueryFilters` seam

## Requirement-to-Asset Map

| Requirement | Asset | Gap |
|---|---|---|
| 1.1 bin registration | `package.json` `bin.khipu` + `bin/khipu` shim | None |
| 1.2 Root --help output | `src/khipu.ts` `USAGE` + `resolveCommand` | None |
| 1.3 Per-subcommand --help | `src/khipu.ts` `SUBCOMMAND_USAGE` map | None |
| 1.4 Unknown subcommand error + exit 1 | `src/khipu.ts` default error branch | None |
| 1.5 npm link + tsx, no build step | `bin/khipu` spawns `tsx src/khipu.ts` | None |
| 2.1-2.3 Sync status listing | `src/khipu-sync-status.ts` `printSyncStatus()` | None |
| 3.1-3.4 Daemon, --once, --force, SIGINT | `src/watch.ts` wired via `khipu.ts` router | None (--force/SIGINT behavior inherited) |
| 4.1-4.5 Per-platform one-shot + @account | `src/khipu.ts` `@`-split + `listAccounts` validation | None |
| 5.1-5.3 Index subcommand + progress | Routes to `src/index-embeddings.ts` | None |
| 6.1-6.2 MCP subcommand + SIGTERM | Routes to `src/mcp.ts` | None |
| 7.1-7.3 Web subcommand + URL + SIGTERM | Routes to `src/web/server.ts` | None |
| 8.1-8.9 search + 6 filters + parity | `src/cli.ts` + `src/cli-filters.ts` + shared `handleSearchMessages` | None |
| 9.1-9.6 list chats/messages + 6 filters | `src/khipu-list.ts` + `src/cli-filters.ts` | None |
| 10.1-10.4 Filter parity contract | `QueryFilters` in `src/query-handlers.ts`; shared by MCP and CLI; parity test in `tests/query-parity.test.ts` | None |

## Implementation Approach: Retrospective

**Option B (Dedicated entry scripts + shared filter parser)** was selected and fully executed:
- `src/khipu.ts` — pure command router (spawns child scripts, never touches DB)
- `src/khipu-list.ts` — `list chats | messages` entry point
- `src/khipu-sync-status.ts` — `sync` (bare) entry point
- `src/cli-filters.ts` — shared `--platform/--account/--since/--until/--type/--limit` parser
- `src/query-handlers.ts` — extended with `QueryFilters` contract; parity seam for MCP and CLI

All files stay under the 200-line limit. Router remains pure and unit-testable via `resolveCommand(argv, deps)`.

## Out-of-Boundary Stubs (Confirmed Absent by Design)

| Stub | Owned By |
|------|----------|
| Daemon polling loop / per-platform intervals | `sync-watcher` spec |
| `--force` deep re-read effect inside daemon | `incremental-sync` spec |
| `--account` honored inside per-platform sync scripts | `multi-account` spec |
| Embedding computation inside `khipu index` | `semantic-search` spec |

## Recommendations for Design Phase

None required: design and tasks are already approved. Implementation is complete. Next step is `/kiro-validate-impl khipu-cli` for final cross-task consistency and full test-suite verification.

