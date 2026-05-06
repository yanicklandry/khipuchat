# Research & Design Decisions

---
**Purpose**: Capture discovery findings, architectural investigations, and rationale that inform the technical design.

---

## Summary

- **Feature**: `platform-abstraction`
- **Discovery Scope**: Extension (existing system — all four Phase 1 files touched)
- **Key Findings**:
  - `better-sqlite3` is fully synchronous; schema migration via `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE IF NOT EXISTS` (SQLite 3.37+) is safe and idempotent
  - The UNIQUE constraint in `messages` is currently `UNIQUE(telegram_id, chat_id)` — renaming to `external_id` requires rebuilding the table (SQLite does not support `ALTER COLUMN RENAME` before 3.25; the project targets Node 20 which bundles SQLite ≥ 3.39 via `better-sqlite3`, so `ALTER TABLE RENAME COLUMN` is available)
  - Telegram sync logic in `sync.ts` is self-contained — moving it to `src/platforms/telegram/sync.ts` requires only updating import paths and the `main()` entry point reference
  - MCP tools currently have no `platform` field in responses and no filter parameter; adding both is purely additive and backward-compatible with existing Claude Desktop configs

## Research Log

### SQLite ALTER TABLE RENAME COLUMN availability

- **Context**: `messages.telegram_id` must be renamed to `external_id`; `reply_to_telegram_id` → `reply_to_external_id`
- **Findings**:
  - `ALTER TABLE … RENAME COLUMN` was added in SQLite 3.25.0 (2018)
  - `better-sqlite3` v9+ bundles SQLite ≥ 3.39.2
  - Node 20 ships with `better-sqlite3` at a version that bundles SQLite 3.39+
  - Therefore `ALTER TABLE messages RENAME COLUMN telegram_id TO external_id` is safe in the project's runtime
- **Implications**: No table rebuild required; both RENAME COLUMN statements can be executed as idempotent migrations inside `createSchema`

### SQLite ADD COLUMN with DEFAULT

- **Context**: Adding `platform TEXT NOT NULL DEFAULT 'telegram'` to both `chats` and `messages`
- **Findings**:
  - SQLite allows `ALTER TABLE … ADD COLUMN` for columns with `NOT NULL DEFAULT <literal>` — the default is applied to all existing rows
  - The operation is idempotent when wrapped in a try/catch or guarded with a `pragma table_info` check; using a guard via `PRAGMA table_info` is cleaner than try/catch in synchronous DB code
- **Implications**: Use a helper `columnExists(db, table, column)` inside `createSchema` to gate each `ADD COLUMN` and each `RENAME COLUMN` so re-running `initDb` on an existing database is safe

### FTS5 trigger and renamed column

- **Context**: FTS5 trigger `messages_fts_insert` references `new.text` — not affected by the `external_id` or `platform` column changes
- **Findings**: FTS triggers are column-name specific; renaming `telegram_id`/`reply_to_telegram_id` and adding `platform` do not touch the `text` column the trigger indexes
- **Implications**: No FTS trigger changes needed

### MCP additive changes — Claude Desktop config stability

- **Context**: Existing Claude Desktop configs reference tool names directly
- **Findings**: MCP tool names are the only externally stable identifiers; parameters and response shapes can be extended without breaking configs
- **Implications**: `platform` parameter must be `optional` in JSON Schema (`required` array must NOT include `platform`); existing callers receive responses with a new `platform` field that they can safely ignore

### Platform type union design

- **Context**: Deciding between a string literal union, an enum, or a const object for `Platform`
- **Findings**: TypeScript string literal union (`'telegram' | 'imessage' | ...`) provides compile-time exhaustiveness without runtime overhead and serializes naturally to SQLite `TEXT`
- **Implications**: `Platform` is exported as a `type` alias from `src/platforms/types.ts`; the `PlatformAdapter` interface uses it as the `platform` property type

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Decision |
|--------|-------------|-----------|---------------------|----------|
| `platform` on both tables | Self-describing rows; filter in any query without JOIN | Simple queries, no cross-table JOIN for platform filter | Slight redundancy between chat.platform and message.platform | **Selected** — aligns with roadmap Approach B |
| `platform` on chats only | Messages inherit platform via JOIN | Less redundancy | Every platform-filtered message query requires JOIN | Rejected — more complex queries |
| Separate sync-state tables per platform | Isolated per-platform state tracking | Isolation | More tables, JOIN complexity, contradicts existing `last_synced_at` | Rejected — unnecessary complexity |

## Design Decisions

### Decision: Migration strategy for existing schema — in-place ALTER TABLE

- **Context**: `initDb` is called on every startup; existing databases must not be corrupted or lose data
- **Alternatives Considered**:
  1. Drop and recreate tables — simple but destroys existing data
  2. Versioned migration runner — correct but over-engineered for two ALTER statements
  3. Idempotent `ALTER TABLE` with column-existence guard — safe, minimal, no external dependency
- **Selected Approach**: `columnExists(db, table, column)` helper using `PRAGMA table_info`; gates each `ADD COLUMN` and each `RENAME COLUMN`; runs inside `createSchema` before any DML
- **Rationale**: Keeps `db.ts` self-contained; aligns with project rule "all DB operations synchronous"; avoids a migration runner dependency
- **Trade-offs**: No migration version tracking; acceptable for a self-hosted single-user tool
- **Follow-up**: Verify behavior when schema is initialized from empty (`:memory:`) vs. existing file DB

### Decision: `PlatformAdapter` interface scope — minimal contract only

- **Context**: The interface must be implementable by Telegram sync immediately and by iMessage sync in the next spec
- **Alternatives Considered**:
  1. Rich adapter with `connect`, `backfill`, `startListener`, `disconnect` methods
  2. Minimal marker interface — just `readonly platform: Platform`
  3. Functional interface with `runBackfill(client, db)` and `startListener(client, db)` signatures
- **Selected Approach**: Option 3 — `PlatformAdapter` declares `readonly platform: Platform` plus `runBackfill` and `startListener` method signatures; clients and DB handles are passed as parameters
- **Rationale**: Satisfies `imessage-sync` dependency without over-specifying runtime lifecycle management; keeps the interface narrow and testable
- **Trade-offs**: Does not enforce connection management; acceptable because each platform module owns its own client lifecycle

### Decision: File move — `src/sync.ts` → `src/platforms/telegram/sync.ts`

- **Context**: Move, not rewrite; no behavior change
- **Selected Approach**: Copy file to new path, update internal imports and `package.json` `scripts.sync` entry point reference; delete old path
- **Rationale**: Minimizes risk of regression; all existing function signatures remain unchanged

## Risks & Mitigations

- **Risk**: Tests reference `telegram_id` field by name — those references will break after rename
  - **Mitigation**: Update all test fixtures and assertions that use `telegram_id` or `reply_to_telegram_id`; scan with grep before committing
- **Risk**: `RENAME COLUMN` on a table with indexes drops and recreates those indexes automatically (SQLite behavior) — performance no-op on startup but could surprise
  - **Mitigation**: Confirm index re-creation with `PRAGMA index_list` in tests
- **Risk**: `ADD COLUMN … NOT NULL DEFAULT` on a non-empty database could fail if the default is not a literal
  - **Mitigation**: `DEFAULT 'telegram'` is a string literal — safe; confirmed via SQLite documentation
- **Risk**: MCP response shape change breaks existing Claude Desktop tool calls that destructure specific fields
  - **Mitigation**: Adding a new `platform` field is purely additive; no existing field is removed or renamed in MCP responses

## References

- [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html) — covers RENAME COLUMN (3.25+) and ADD COLUMN constraints
- [better-sqlite3 changelog](https://github.com/WiseLibs/better-sqlite3/blob/master/CHANGELOG.md) — version history and bundled SQLite versions
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — tool schema definition patterns
