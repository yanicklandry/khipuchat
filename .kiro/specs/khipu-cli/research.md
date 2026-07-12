# Gap Analysis: khipu-cli

## Requirement-to-Asset Map

### Req 1: CLI Binary and Subcommand Router

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| `bin` field in package.json | **EXISTS** | `"khipu": "bin/khipu"` in package.json |
| `khipu` / `khipu --help` shows subcommands | **EXISTS** | `resolveCommand` in `src/khipu.ts` handles empty args → USAGE |
| `khipu <sub> --help` shows subcommand usage | **MISSING** | Router forwards all args; subcommand-scoped help not implemented |
| Unknown subcommand prints error + exits non-zero | **EXISTS** | `resolveCommand` returns `kind: 'error'` with message and `exitCode: 1` |
| Works via `npm link` / tsx, no build step | **EXISTS** | `bin/khipu` spawns `node tsx src/khipu.ts`, no dist/ needed |

**Gap**: Per-subcommand `--help` is not handled. `khipu search --help` would forward `--help` to `cli.ts` where it is not specially handled.

---

### Req 2: Sync Status Listing (`khipu sync` with no args)

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| Show each configured platform, accounts, last sync timestamp | **MISSING** | `khipu sync` (no arg) currently routes to `sync-all.ts` which actually runs all platform syncs |
| Omit platforms with no configured accounts | **MISSING** | No status-listing logic exists |
| Show "never" when account has not been synced | **MISSING** | N/A |

**Available primitives**:
- `loadRegistry()` in `src/account-registry.ts` enumerates configured platforms/accounts
- `getPlatformLastSyncedAt(platform, account)` in `src/db.ts` returns the last sync timestamp
- These two can be composed into a status table - no new DB schema needed

**Gap**: The status display command does not exist. The router sends bare `khipu sync` to `sync-all.ts` which is a destructive operation. The router must distinguish between no-arg (status) and `all` (daemon).

---

### Req 3: Sync Daemon (`khipu sync all`)

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| Continuous daemon iterating all accounts | **MISMATCH** | `khipu sync all` routes to `sync-all.ts` which runs once and exits. The daemon is in `src/watch.ts` but is not wired. |
| `--once` flag performs single pass and exits | **PARTIAL** | `watch.ts` has `--once` mode; `sync-all.ts` does not |
| `--force` threads through | **PARTIAL** | `sync-all.ts` forwards `--force`; `watch.ts` reads `process.argv.includes('--force')` but effect depends on `sync-runner.ts` (out-of-spec) |
| SIGINT/SIGTERM clean exit with code 0 | **EXISTS (wrong target)** | `watch.ts` has graceful shutdown; `sync-all.ts` does not |

**Gap**: Router must point `khipu sync all` to `src/watch.ts`, not `src/sync-all.ts`. `watch.ts` already handles `--once`, SIGINT/SIGTERM, and per-platform intervals.

---

### Req 4: Single-Platform One-Shot Sync (`khipu sync <platform>`)

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| `khipu sync <platform>` runs that platform's sync | **EXISTS** | Router resolves to `src/platforms/<platform>/sync.ts` |
| `khipu sync <platform>@<account>` targets specific account | **MISSING** | `@account` syntax not parsed; `resolveCommand` splits only on space |
| `--force` threads through | **EXISTS** | `args` slice is forwarded to spawned script |
| Unknown platform → error with list | **EXISTS** | `resolveCommand` returns `kind: 'error'` |
| Unknown `@account` → error | **MISSING** | No account validation in router |

**Gap**: `@account` notation must be parsed out of the platform arg in `resolveCommand`. The account can be forwarded as a flag (e.g., `--account <name>`) to the per-platform sync script, or the router must validate it against `loadRegistry()` before spawning.

---

### Req 5: Index Subcommand (`khipu index`)

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| Incremental embeddings build | **EXISTS** | `khipu index` routes to `src/index-embeddings.ts` |
| `--force` for full rebuild | **EXISTS** | Args forwarded; `index-embeddings.ts` exports `rebuildEmbeddings(platform?, force?)` |
| Progress/status output while indexing | **NEEDS VERIFICATION** | Need to confirm `index-embeddings.ts` emits progress |

**Low risk**: Routing is complete; may need a small output tweak if the script is silent.

---

### Req 6: MCP Server (`khipu mcp`)

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| Starts MCP server over stdio | **EXISTS** | Routes to `src/mcp.ts` |
| Clean exit on SIGINT/SIGTERM | **EXISTS** | Node.js process exit; MCP SDK handles transport teardown |

**No gap.**

---

### Req 7: Web UI (`khipu web`)

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| Starts web server + displays URL | **PARTIAL** | Routes to `src/web/server.ts`; need to verify URL is logged at startup |
| Keeps running until interrupted | **EXISTS** | Express server blocks |
| Clean exit on SIGINT/SIGTERM | **EXISTS** | Node.js process exit |

**Low risk**: Likely just a log-line check.

---

### Req 8: Search Subcommand (`khipu search`)

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| `khipu search <query>` returns results | **EXISTS** | `search` is in QUERY_COMMANDS; routes to `cli.ts` `case 'search'` |
| `--platform <p>` filter | **MISSING** | `cli.ts` search case does not parse `--platform` |
| `--account <name>` filter | **EXISTS** | `parseAccountArg` in `cli.ts` |
| `--since <date>` / `--until <date>` | **MISSING** | No ISO date parsing for CLI flags; only natural-language temporal detection in `parseTemporalFilters` |
| `--type <t>` filter | **MISSING** | Not in `handleSearchMessages` or `searchMessages` DB function |
| `--limit <n>` cap | **MISSING** | Not passed from CLI to handler |
| Same results as MCP for same query+filters | **MISSING** | MCP `search_messages` also lacks `--since/--until/--type` → both need updates together |
| Empty results → message + exit 0 | **EXISTS** | `cli.ts` prints "No results found." |
| Missing `<query>` → usage + non-zero exit | **EXISTS** | `cli.ts` handles empty `query` |

**Significant gap**: Four of the six required filter flags are absent from both CLI and MCP. Adding them requires changes to `handleSearchMessages`, the DB query in `searchMessages`, and the MCP tool definition - all in-scope work, but touches shared infrastructure.

---

### Req 9: List Subcommand (`khipu list`)

| Acceptance Criterion | Status | Existing Asset |
|---|---|---|
| `khipu list chats` | **MISSING** | `list-chats` (hyphenated) exists as a QUERY_COMMAND but uses a different CLI shape |
| `khipu list messages` | **MISSING** | `messages` in cli.ts takes a `chat_id`, not filter-based listing across all chats |
| `--platform/--account/--since/--until/--type/--limit` on both | **MISSING** | Same as Req 8 |
| `khipu list` (bare) → usage + non-zero | **MISSING** | No `list` command in router |
| Empty results → message + exit 0 | **EXISTS** | Pattern exists in cli.ts |

**Gap**: `list` needs to be added to the router as a new command that handles two sub-subcommands (`chats` / `messages`). The current `list-chats` and `messages` command shapes (hyphenated, positional chat_id) differ from the requirement's space-separated, filter-flag design.

---

### Req 10: CLI/MCP Filter Parity

| Flag | MCP | CLI | Status |
|---|---|---|---|
| `--platform` | `list_chats`, `search_messages`, `semantic_*` | `list-chats` only (via `handleListChats`) | **PARTIAL** |
| `--account` | All tools | `search`, `list-chats`, `semantic-*` | **EXISTS** |
| `--since` / `--until` | `semantic_find_contacts` (before/after) | `semantic-search` via `parseTemporalFilters` (natural lang only) | **MISSING** (ISO dates) |
| `--type` | Not exposed | Not exposed | **MISSING** on both |
| `--limit` | `list_chats`, `semantic_*` | Not on search/list | **PARTIAL** |

**Gap**: Both MCP and CLI need `--type` and ISO-date `--since/--until` on the query tools. The requirement states MCP is the reference implementation — these gaps must land in MCP first, then CLI mirrors them.

---

## Implementation Approach Options

### Option A: Extend `src/khipu.ts` + `src/cli.ts`

Add `list` routing logic to the router and all new filter-flag parsing directly in `cli.ts`.

- **Extends**: `src/khipu.ts` (routing for `list`, status, `@account`), `src/cli.ts` (filter flags), `src/query-handlers.ts` (new filter params), `src/mcp.ts` (tool schema update)
- ✅ Minimal new files; leverages established patterns
- ❌ `cli.ts` is already 250 lines (past the 200-line guideline); adding 6 filter flags to two list sub-commands would push it well beyond limit
- ❌ `khipu.ts` would need to handle multi-token sub-subcommands (`list chats` vs `list messages`) inline, increasing cognitive load

### Option B: Create New Components (Recommended)

Extract each new CLI surface into its own entry-point script, keeping `khipu.ts` as a thin router.

- `src/khipu-sync-status.ts` — displays sync status table (reads `loadRegistry` + `getPlatformLastSyncedAt`)
- `src/khipu-list.ts` — handles `list chats` and `list messages` with all filter flags
- Update `src/khipu.ts`: reroute `sync all` → `watch.ts`, bare `sync` → `khipu-sync-status.ts`, add `list` route → `khipu-list.ts`, add `@account` parsing
- Update `src/query-handlers.ts`: add `--type`, ISO date `--since/--until` params to `handleListChats`, `handleListMessages`, `handleSearchMessages`
- Update `src/mcp.ts`: expose new filter params in tool schemas (MCP is the reference implementation)
- Update `src/cli.ts`: add `--platform`, `--since`, `--until`, `--type`, `--limit` to `search` case

- ✅ Files stay under 200 lines
- ✅ Clean separation: router stays thin, each script owns its CLI surface
- ✅ Easier to test `khipu-sync-status.ts` and `khipu-list.ts` in isolation
- ❌ Two additional files to navigate

### Option C: Hybrid — Inline Small Changes, New Script for `list`

Same as B but fold `khipu-sync-status.ts` logic directly into `khipu.ts` (it's small: ~20-30 lines) rather than spawning a new child process for a read-only display.

- ✅ Avoids an extra tsx child spawn just to print a table
- ✅ `khipu.ts` does the status display inline, then exits — no subprocess needed
- ❌ `khipu.ts` grows slightly but stays under 200 lines if sync-status is compact

**Recommended**: Option C — inline sync-status into `khipu.ts`, create `src/khipu-list.ts` as a separate entry point for the list sub-subcommand surface.

---

## Effort and Risk

| Area | Effort | Risk | Justification |
|---|---|---|---|
| Router changes (sync all, @account, list, sync status) | S | Low | Existing patterns; `resolveCommand` is pure and well-tested |
| Sync status display (inline) | S | Low | Just reads registry + DB; no new schema |
| Filter flags in `query-handlers.ts` + `mcp.ts` | M | Medium | Touches shared seam used by MCP and CLI; must not break existing MCP consumers |
| `src/khipu-list.ts` | S | Low | New file, no consumers to break |
| `--since/--until` ISO date parsing | S | Low | Small parsing utility; `parseTemporalFilters` pattern exists |
| `--type` filter in DB query | S | Low | Additional WHERE clause; same pattern as `platform` filter |
| Per-subcommand `--help` | S | Low | Extend `resolveCommand` to detect `--help` before routing |

**Overall Effort**: M (3-7 days)
**Overall Risk**: Low-Medium — MCP schema changes are the main risk surface since they affect active Claude Desktop integrations.

---

## Recommendations for Design Phase

**Preferred approach**: Option C (hybrid). Extend `src/khipu.ts` with inline sync-status and `@account` parsing; create `src/khipu-list.ts`; thread new filter flags through `query-handlers.ts` with MCP schema updated first.

**Key design decisions to resolve**:
1. How `--since/--until` ISO date strings should be parsed (e.g., `2025-01-01`) and converted to Unix timestamps — design a small `parseDateArg` utility alongside `parseTemporalFilters`.
2. Whether `--type` should filter at the DB layer (SQL WHERE) or application layer (post-query filter) — DB layer is preferable for performance.
3. How `@account` is forwarded to the per-platform sync script — as a `--account <name>` flag appended to args, or via env var; the per-platform sync scripts' current arg-handling conventions need a quick survey.
4. Whether `khipu sync <platform>@<account>` validates the account name against `loadRegistry` inside the router (eagerly, risks coupling router to DB/config) or passes through and lets the sync script handle it (deferred validation — simpler router).

**Research items to carry forward**:
- Confirm that `src/index-embeddings.ts` emits progress output during execution (Req 5.3).
- Confirm that `src/web/server.ts` logs its URL at startup (Req 7.1).
- Survey each platform's `sync.ts` to confirm it reads `--account <name>` from argv (needed for `@account` forwarding in Req 4.2).
- Verify that `searchMessages` in `src/db.ts` supports a `type` column filter without schema changes.
