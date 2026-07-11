# Gap Analysis: multi-account

_Generated: 2026-07-11_

---

## Analysis Summary

- **Scope**: Wide. All layers are affected: config loading, DB schema/migration, sync orchestration, all three query surfaces (MCP, CLI, Web), and the `PlatformAdapter` contract.
- **Biggest challenge**: The `chats` table uses the platform's external integer as its PRIMARY KEY, so two accounts on the same platform can produce identical chat IDs — a direct collision. Resolving this without breaking the `messages.chat_id` foreign key is the central schema decision for the design phase.
- **`config.ts` is Telegram-only**: The current configuration module is a thin Telegram-specific loader. The new `khipu.config.json` registry is a greenfield addition.
- **Adapters hard-code their own config imports**: Each adapter reads credentials from its own module or env vars. Injecting per-account credentials requires either a new adapter factory pattern or extending the `PlatformAdapter` contract.
- **Query surfaces are close but need systematic extension**: Every `handle*` function, result type, DB function, and tool schema needs an `account` dimension added — repetitive but low-risk once the schema is settled.

**Recommended approach**: Hybrid (new `account-registry` module + surgical extension of existing modules). See Option C below.

---

## Current State Investigation

### Key Files and Their State

| File | Relevant State |
|---|---|
| `src/config.ts` | Telegram-only: reads `TELEGRAM_API_*` env vars. No multi-platform or multi-account concept. 30 lines. |
| `src/db.ts` | `Chat`, `Message`, `SearchResult` interfaces lack `account` field. `chats` table: no `account` column, `id` is external platform ID (non-autoincrement). `sync_state`: keyed by `platform` only. `messages`: no `account` column; `UNIQUE(external_id, chat_id)`. 230 lines (already at limit). |
| `src/platforms/types.ts` | `PlatformAdapter` has `platform` only. Methods receive `db` but no account context. |
| `src/sync-runner.ts` | `runPlatformSync(adapter, db, argv)` calls `getPlatformLastSyncedAt(adapter.platform)` — single account assumed. |
| `src/mcp.ts` | All `handle*` functions: no `account` param. `ChatResult`, `MessageResult`: no `account` field. MCP tool schemas: no `account` property. 302 lines (over limit). |
| `src/cli.ts` | No `--account` option. All handler calls pass no account. |
| `src/web/routes.ts` | No `?account=` query param on any route. |
| `src/vec-db.ts` | `ContactFilters`, `MessageFilters`: no `account` field. `SemanticContactResult`, `SemanticMessageResult`: no `account` field. |
| `tests/` | `db.test.ts`, `mcp.test.ts`, `sync-runner.test.ts` all lack account coverage. |

### Architecture Patterns

- Adapters call `db.ts` exports only — schema changes in `db.ts` propagate everywhere.
- `src/db.ts` is the single schema seam; all migrations run through `runMigrations()`.
- `src/mcp.ts` is the query reference implementation; all three surfaces call its handlers.
- Platform type is a union literal in `src/platforms/types.ts`.
- 200-line file limit; `db.ts` (230 lines) and `mcp.ts` (302 lines) already exceed it.

---

## Requirements Feasibility Analysis

### Requirement 1: Account Configuration Registry

**Technical needs**: A new config loader that reads `khipu.config.json`, resolves `$VAR` env references, validates names, enforces WeChat single-account exclusion, and exposes an account enumeration API. Fallback to legacy env-var credentials as `"default"` account.

**Gaps**:
- `src/config.ts` is Telegram-only and must not be broken; existing adapters import from it directly.
- No config JSON loader exists; no env-var reference resolution pattern exists.
- WeChat exclusion: a new validation rule, no existing analogue.

**Constraints**:
- New config module must be importable by `sync-runner.ts` and all adapters without circular imports.

### Requirement 2: Database Schema and Migration

**Technical needs**:
1. Add `account TEXT NOT NULL DEFAULT 'default'` to `chats`.
2. Re-key `sync_state` from `platform` to `(platform, account)`.
3. Ensure two chats from different accounts on the same platform can coexist without PK collision.

**Critical gap — chats.id collision**:
The current `chats.id` is the platform's external integer ID (e.g. Telegram user ID), set explicitly: `{ id: Number(entity.id), ... }`. For multi-account, two Telegram accounts may both have a contact with the same external ID. The current `INTEGER PRIMARY KEY` would collide.

Options for this collision:
- **Option 2a**: Introduce a surrogate autoincrement PK, rename current `id` to `external_id`, make `(external_id, platform, account)` the unique key, update `messages.chat_id` to reference the surrogate. This is a one-time data migration.
- **Option 2b**: Change the `chats` PK to `(id, platform, account)` — SQLite supports composite PKs but does not support referencing them as FK targets from `messages.chat_id` (single-column FK). Would require making `chat_id` in `messages` a surrogate or dropping FK semantics entirely (SQLite is lenient here).
- **Option 2c**: Use a namespaced external ID `(platform || ':' || account || ':' || external_id)` as a virtual key, keep surrogate PK for FK. Similar to 2a.

Option 2a is cleanest and aligns with the 200-line constraint: it extracts surrogate PK logic once, and all downstream references to `chats.id` continue to work transparently (they just point to surrogate IDs now rather than external IDs).

**Migration path**:
```
ALTER TABLE chats ADD COLUMN account TEXT NOT NULL DEFAULT 'default'
ALTER TABLE chats ADD COLUMN external_id TEXT  -- populated from id, then id becomes surrogate
ALTER TABLE sync_state ADD COLUMN account TEXT NOT NULL DEFAULT 'default'
-- new unique constraint: (external_id, platform, account)
-- existing rows: account = 'default', external_id = cast(id as text)
```

**Unknowns (Research Needed)**:
- Does SQLite's `ALTER TABLE` allow adding a NOT NULL column with a DEFAULT without a full table rewrite in better-sqlite3? (Answer: yes, with a constant DEFAULT.)
- Can we safely rename `chats.id` to a new column while `messages.chat_id` references it? SQLite does not enforce FK column references by name during ALTER — values are preserved.

**`sync_state` migration**:
Current: `platform TEXT NOT NULL PRIMARY KEY`.
New: `(platform, account) PRIMARY KEY`.
SQLite does not support `ALTER TABLE ... DROP CONSTRAINT` or `ADD PRIMARY KEY`. The migration requires `CREATE TABLE sync_state_new ... INSERT ... DROP ... RENAME` — a table rebuild.

### Requirement 3: Platform Adapter Account Awareness

**Technical needs**: Each adapter must receive the account name and its resolved credentials at sync time, then tag all `upsertChat` and `insertMessage` calls with the account.

**Gaps**:
- `PlatformAdapter` interface has no `account` field. Extending it breaks all adapters.
- Adapters currently import their own credential singleton (e.g. Telegram imports `config` from `../../config`). Injecting per-account credentials requires either a factory or passing credentials into `runBackfill`/`syncIncremental`.
- `runPlatformSync` currently takes a single adapter — it would need to iterate adapters (one per account) or accept a credential set.

**Two viable patterns for adapter credential injection**:
- **Pattern A — Adapter factory**: `createTelegramAdapter(credentials): PlatformAdapter` — adapter closes over its credentials. `runPlatformSync` is called once per account with the appropriate adapter instance. Clean, no interface change needed beyond adding `account` to the adapter object.
- **Pattern B — Credential param on sync methods**: `runBackfill(db, credentials)` — breaks the current `PlatformAdapter` interface, requires updating all 7 adapters simultaneously.

Pattern A is less disruptive and fits the existing `PlatformAdapter` shape better.

**sync-runner.ts extension**: `runPlatformSync` reads `getPlatformLastSyncedAt(platform)` — needs `getPlatformAccountLastSyncedAt(platform, account)`. The runner also needs to understand "iterate all accounts for this platform."

### Requirement 4: MCP Query Surface

**Technical needs**: Add `account?: string` to all handler signatures and result types. Add `account` field to `ChatResult`, `MessageResult`, `SearchResult`, `SemanticContactResult`, `SemanticMessageResult`. Add `account` property to all MCP tool input schemas.

**Gaps**: Systematic but straightforward. `mcp.ts` is already over 200 lines — the `account` additions will push it further. Extracting result-type definitions and DB query helpers to a separate `src/query-handlers.ts` should be considered.

**`searchMessages` in `db.ts`**: The SQL already JOIN-chains `messages` to `chats`; adding `AND c.account = ?` is a simple extension. Same pattern for `vec-db.ts` semantic queries.

### Requirement 5: CLI Query Surface

**Technical needs**: Parse `--account <name>` from `process.argv`, pass to handlers, print account name alongside platform in multi-account output.

**Gaps**: Minimal. `cli.ts` already parses `--min-similarity` by index; `--account` follows the same pattern.

### Requirement 6: Web UI Account Disambiguation

**Technical needs**: `/api/chats` needs `?account=` query param. Web UI (plain HTML) needs an account filter control and conditional account label rendering.

**Gaps**: `src/web/routes.ts` passes no account to `handleListChats`. The UI HTML/JS (`src/web/ui.ts`, `src/web/ui-scroll.ts`) needs account-aware rendering — this is new UI logic. No existing filter pattern in the Web UI to follow; the platform filter must be the first example.

---

## Implementation Approach Options

### Option A: Extend Existing Components

Extend `src/config.ts` to add `khipu.config.json` loading alongside Telegram-specific config. Extend `db.ts` in-place with new columns and functions. Extend all adapters in-place with optional account param.

**Trade-offs**:
- Risks bloating already over-limit files (`db.ts`, `mcp.ts`).
- Makes `config.ts` responsible for both Telegram credentials and multi-platform registry — mixed concerns.
- Faster initially; harder to test in isolation.

### Option B: Create New Components

New `src/account-registry.ts`, new `src/account-sync-runner.ts`, new `src/query-handlers.ts` for DB queries. All adapters refactored to factory functions.

**Trade-offs**:
- Cleanest separation; easiest to unit-test registry and query logic independently.
- Larger surface area; more interface design upfront.
- Risk of over-engineering for a brownfield add.

### Option C: Hybrid (Recommended)

New module for config registry; extend existing modules surgically.

- **NEW** `src/account-registry.ts`: `khipu.config.json` loading, env-var resolution, validation, WeChat exclusion, account enumeration. Tested independently.
- **EXTEND** `src/db.ts`: `runMigrations()` handles all new columns/table rebuilds; add `account` param to `upsertChat`, `insertMessage`, `getChats`, `searchMessages`, `getPlatformLastSyncedAt`, `setPlatformLastSyncedAt`. Extract to `src/db-account.ts` if file grows past 200 lines.
- **EXTEND** `src/platforms/types.ts`: Add `account: string` to `PlatformAdapter`; update adapter factory functions (no breaking change to sync-runner interface — adapter carries its account).
- **EXTEND** `src/sync-runner.ts`: `runPlatformSync` stays the same; a new `runAllAccountsSync(platform, registry, db, argv)` iterates accounts, instantiates adapter per account, continues on per-account failure.
- **EXTEND** all adapters: Each adapter becomes a factory `createXAdapter(account, credentials)` returning `PlatformAdapter`. Existing singleton exports stay for backward compat during transition.
- **EXTEND** `src/mcp.ts`: Add `account` param to all handlers and tool schemas; add `account` field to all result types. Extract result types to a shared module if file grows.
- **EXTEND** `src/cli.ts`: Add `--account` parsing; pass to handlers; print account in multi-account results.
- **EXTEND** `src/web/routes.ts` + `src/web/ui.ts`: Add `?account=` query param; conditional account label; filter control.
- **EXTEND** `src/vec-db.ts`: Add `account` to `ContactFilters`, `MessageFilters`, result types, and SQL queries.

**Trade-offs**:
- Balanced: one new module for greenfield config, surgical extension elsewhere.
- Respects existing patterns; adapters remain `PlatformAdapter`-shaped.
- Migration complexity is contained in `db.ts:runMigrations()`.

---

## Implementation Complexity and Risk

| Area | Effort | Risk | Justification |
|---|---|---|---|
| Account registry (`account-registry.ts`) | S | Low | New file, straightforward JSON + env-var logic |
| DB schema + migration | M | Medium | `chats.id` collision requires surrogate PK or composite unique; `sync_state` rebuild; existing data must survive |
| Adapter factory + credential injection | M | Medium | 7 adapters to update; pattern is clear (factory fn) but each adapter touches credential loading differently |
| sync-runner account iteration | S | Low | Add loop over accounts; per-account error handling follows existing error patterns |
| MCP query surface | M | Low | Systematic `account` param additions; SQL changes are additive `AND c.account = ?` clauses |
| CLI `--account` option | S | Low | Arg parsing already established; display change is trivial |
| Web UI account filter + labels | M | Low-Medium | First filter control in the Web UI; plain HTML/JS, no framework |
| Test coverage | M | Low | Existing test setup (`:memory:` SQLite) accommodates new columns directly |

**Overall**: **L** effort, **Medium** risk — driven primarily by the `chats.id` surrogate PK migration decision and the adapter factory refactor across 7 platforms.

---

## Recommendations for Design Phase

### Key Decisions to Resolve

1. **`chats.id` surrogate PK**: Choose Option 2a (surrogate autoincrement, rename external ID to `external_id`, update `messages.chat_id` FK to point to surrogate). Verify migration script on a copy of real data before committing.

2. **Adapter factory pattern**: Define `createXAdapter(account: string, credentials: XCredentials): PlatformAdapter` for all adapters. The existing singleton adapters (e.g. `telegramAdapter`) remain as `createTelegramAdapter('default', legacyConfig)` for backward compat.

3. **`sync_state` table rebuild**: Plan a `CREATE TABLE ... INSERT ... DROP ... RENAME` migration step in `runMigrations()`. This is the one migration step that cannot be done with a simple `ALTER TABLE ADD COLUMN`.

4. **File size discipline**: `db.ts` (230 lines) and `mcp.ts` (302 lines) both exceed the 200-line limit. The multi-account additions will increase both further. Design should plan for extraction: e.g. `src/db-migrations.ts` for migration logic, and `src/query-handlers.ts` for `handle*` functions.

5. **`khipu.config.json` schema**: Define the JSON shape in the design document (platform keys, account list, credential fields). The schema is the contract between operators and the registry loader.

### Research Items to Carry Forward

- **[Research Needed]** Confirm `better-sqlite3` behavior when rebuilding `sync_state` table (CREATE-INSERT-DROP-RENAME) with `WAL` mode active — no data loss risk.
- **[Research Needed]** Verify SQLite allows adding `account TEXT NOT NULL DEFAULT 'default'` column to existing `chats` table in one `ALTER TABLE` step (should be safe with constant default; confirm no edge cases with `better-sqlite3-multiple-ciphers`).
- **[Research Needed]** How do the 7 existing adapters acquire credentials? Confirm which import `config.ts` directly vs. read env vars in their own module — affects factory refactor scope per adapter.

---

_Status: Gap analysis complete. Proceed with `/kiro-spec-design multi-account` to generate the technical design._

---

# Design Phase Research & Decisions

_Appended: 2026-07-11 during `/kiro-spec-design`._

## Summary
- **Discovery Scope**: Extension (brownfield, all layers)
- **Key Findings**:
  1. `chats.id` is **not** a raw external id — adapters compute it deterministically (Telegram `Number(entity.id)`, Slack `hashStr(conv.id)`, etc.) and supply it explicitly. It is referenced by `messages.chat_id` **and** by `vec_chats.rowid` / `vec_messages.rowid` (embeddings are keyed on chat/message ids). Any migration that reassigns chat ids breaks message FKs and chat embeddings.
  2. Adapters compute the chat id independently on the chat side (`upsertChat`) and the message side (`mapMessage(msg, chatId)`). Moving identity ownership into the DB requires `upsertChat` to **return** the resolved surrogate id.
  3. `sync-all.ts` spawns each platform's `sync.ts` as a **separate process**; per-account iteration must live in a shared runner helper invoked from each platform `main()`.
  4. Every adapter reads credentials differently (env vars directly, or the Telegram `config` singleton). Credential injection needs a per-platform factory that accepts a resolved credential record.

## Design Decisions

### Decision: Surrogate PK preserved, identity via `(platform, account, external_id)`
- **Context**: 2.1 requires two accounts on the same platform to hold the same external chat id without collision. Current `chats.id` = adapter-computed external-derived integer, used as PK and as embedding rowid.
- **Alternatives Considered**:
  1. Reassign chat ids to autoincrement surrogate (research Option 2a) — breaks `vec_chats.rowid` for all existing chats and requires remapping every `messages.chat_id`.
  2. Composite PK `(id, platform, account)` (Option 2b) — SQLite cannot use a composite as a single-column FK target for `messages.chat_id`.
  3. Namespaced derived id `hash(account:external)` — changes existing `default` ids, breaking embeddings/FKs, and leaks identity logic into all 7 adapters.
- **Selected Approach**: Keep `id INTEGER PRIMARY KEY` and **preserve all existing id values** (migration sets `external_id = CAST(id AS TEXT)`, `account = 'default'`). Add `external_id TEXT` and `account TEXT NOT NULL DEFAULT 'default'`. Enforce identity with `UNIQUE(platform, account, external_id)`. New chats omit `id` so SQLite assigns a fresh rowid (max+1, no collision with existing large external-derived ids). `upsertChat` resolves via `ON CONFLICT(platform, account, external_id) DO UPDATE ... RETURNING id` and returns the surrogate id; adapters use the returned id for messages.
- **Rationale**: Preserves existing `messages.chat_id` FKs and all existing embeddings with zero data remap. Centralizes identity in the DB instead of in every adapter.
- **Trade-offs**: `upsertChat` contract changes (returns id); every adapter must use the returned id and supply `external_id` + `account` instead of a computed `id`.
- **Follow-up**: Verify `RETURNING` support in `better-sqlite3-multiple-ciphers@11` (better-sqlite3 supports RETURNING since v9). Verify autoincrement rowid assignment does not collide with existing external-derived ids.

### Decision: No `account` column on `messages`
- **Context**: 4.2 requires an `account` field on every message result; 2.2 only mandates the account dimension on chats and sync_state.
- **Selected Approach**: Derive message account from its chat via the existing `messages JOIN chats` used by search/semantic queries; `handleListMessages` adds the same join.
- **Rationale**: Avoids a second NOT-NULL column migration and denormalization. Account is an attribute of the chat, not the message.
- **Trade-offs**: One extra join in `handleListMessages` (previously chat-less).

### Decision: Adapter factory for credential isolation
- **Context**: 3.2 requires per-account credential isolation across up to N accounts per platform.
- **Selected Approach**: Each platform exposes `createXAdapter(account: string, credentials: XCredentials): PlatformAdapter`; the adapter closes over its account+credentials and carries `account` on the object. Existing singleton exports become thin wrappers `createXAdapter('default', legacyEnvCreds)` for backward compatibility. `PlatformAdapter` gains a `readonly account: string`.
- **Rationale**: Least-disruptive pattern (research Pattern A); keeps `runPlatformSync(adapter, ...)` shape intact.
- **Trade-offs**: Touches all multi-account adapters; WeChat retains its single-account entry only.

### Decision: Hand-rolled config loader/validation (no new dependency)
- **Context**: 1.1–1.4 need JSON load, `$VAR` resolution, duplicate/empty-name validation, WeChat exclusion.
- **Alternatives Considered**: `zod` for schema validation.
- **Selected Approach**: Hand-rolled loader in a new `account-registry.ts`, matching the existing minimal `config.ts` style.
- **Rationale**: Project has no schema-validation dependency; the rules are simple and explicit. Avoids adding `zod` for one config file.
- **Trade-offs**: Manual validation code vs. declarative schema.

### Decision: Single account-filter predicate shared by all three surfaces (generalization)
- **Context**: 4.1, 5.1, 6.1 are the same capability (optional account filter) exposed on three surfaces.
- **Selected Approach**: Add `account?: string` to the query layer (`searchMessages`, `handle*` in the extracted `query-handlers.ts`, `ContactFilters`/`MessageFilters` in `vec-db.ts`) as a single `AND c.account = ?` predicate. MCP/CLI/Web only thread the value through.
- **Rationale**: One filter implementation, three thin call sites; guarantees agent-native parity (steering) by construction.

## Risks & Mitigations
- **`sync_state` rebuild under WAL** — Mitigation: perform `CREATE new / INSERT / DROP / RENAME` inside a single transaction in `runMigrations`; guard with idempotent PK-shape check.
- **Adapter id-return refactor regressions** — Mitigation: `upsertChat` returns id; add unit tests asserting two accounts with identical `external_id` get distinct surrogate ids and correctly-scoped messages.
- **Chat embeddings after migration** — Existing chat embeddings remain valid because ids are preserved; only chats newly split across accounts get fresh ids and are picked up by the existing unindexed-chat backfill.

## References
- better-sqlite3 RETURNING support — https://github.com/WiseLibs/better-sqlite3/releases (v9+)
- SQLite ALTER TABLE limitations (no DROP/ADD PRIMARY KEY) — https://www.sqlite.org/lang_altertable.html
