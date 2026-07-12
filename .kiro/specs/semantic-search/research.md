# Research Log: semantic-search

## Discovery Scope
Full discovery — new feature introducing embedding inference and vector storage not previously present in the codebase.

## Key Investigations

### Embedding Library Selection
- `@xenova/transformers` (v2) is deprecated — migrated to `@huggingface/transformers` at v3 (2024)
- `fastembed-js` archived January 2026 — rejected
- **Adopted**: `@huggingface/transformers` ^3.x with `Xenova/all-MiniLM-L6-v2` (384-dim, Apache-2.0, M4 ONNX native binaries)
- CVE-2026-26960 in `onnxruntime-node@1.21.0` (v2/old v3) — fixed in transformers.js v3+ which pulls `onnxruntime-node` ≥1.24.1

### Vector Store Selection
- `sqlite-vss` (Faiss-based) — abandoned; author redirected users to `sqlite-vec`
- **Adopted**: `sqlite-vec` ^0.1.x (Apache-2.0, darwin-arm64 prebuilts, `sqliteVec.load(db)` helper)
- `sqlite-vec` uses vec0 virtual tables with built-in HNSW indexing; cosine distance declared per-column

### better-sqlite3-multiple-ciphers Compatibility
- The project uses `better-sqlite3-multiple-ciphers` (fork for SQLCipher support) rather than upstream `better-sqlite3`
- `sqliteVec.load(db)` internally calls `db.loadExtension(path)` — this API is preserved in the fork
- **Risk**: Not explicitly tested with the fork. Integration test (`vec-db.test.ts`) must verify `loadExtension` works before design is considered validated
- Mitigation: If the fork's `loadExtension` fails, fallback is to call `getDb().loadExtension(sqliteVec.getLoadablePath())` directly

### API Contracts Verified
```typescript
// Model loading
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32', device: 'cpu' })
const output = await extractor(texts, { pooling: 'mean', normalize: true })
// output.data → Float32Array, output.dims → [N, 384]

// sqlite-vec INSERT
stmt.run(BigInt(rowId), new Float32Array(embeddingArray))

// sqlite-vec KNN query
db.prepare('SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = 10 ORDER BY distance').all(new Float32Array(queryVector))
// rowid comes back as BigInt
```

## Design Decisions

### Generalization
- Both MCP tools (`semantic_find_contacts`, `semantic_search_messages`) share the pattern: embed query → kNN → JOIN metadata → filter → return. Designed `semanticFindContacts()` and `semanticSearchMessages()` as separate functions in `vec-db.ts` (not one generic function) to keep SQL filters readable and avoid over-abstraction for two call sites.

### Build vs. Adopt
- Embedding runtime: **adopt** `@huggingface/transformers` — battle-tested, no custom model loader needed
- Vector store: **adopt** `sqlite-vec` — avoids separate vector DB process, reuses existing DB connection
- CLI indexer: **build** — thin orchestration layer, no existing tool fits

### Simplification
- No service class / dependency injection — follows existing flat-function pattern in `db.ts` and `mcp.ts`
- Model as module-level singleton (loaded once per process) — simpler than a factory
- `index-embeddings.ts` is a thin script, not a reusable library — appropriate since it has one call site
- `vec-db.ts` and `embeddings.ts` do not import each other — keeps inference and storage independently testable

### Disk Budget Calculation
- 384 dimensions × 4 bytes (float32) = 1,536 bytes per vector
- 1,000,000 messages × 1,536 bytes = 1.47 GB
- Plus HNSW index overhead (~20%): ~1.77 GB
- Within the 2 GB / 1M messages requirement (5.2) ✅

### Chat Embedding Input
- Input text for chat-level embedding: `<chat name>. <snippet1>. <snippet2>. ... <snippet5>` (last 5 message texts, newest first)
- Rationale: gives the model both identity signal (name) and topic signal (recent content) in one pass
- Capped at 5 snippets to stay well within the 512-token model input limit

### Similarity Threshold
- Default distance threshold: 0.7 (cosine distance, where 0 = identical, 1 = orthogonal)
- Results with `distance > 0.7` are filtered out to avoid low-relevance noise
- Not exposed as a user parameter (YAGNI) — can be added to a future spec if needed

---

# Gap Analysis: semantic-search

**Date**: 2026-07-12
**Spec phase**: requirements-approved

---

## Analysis Summary

- The codebase is remarkably far along: all core semantic search logic (embeddings, vector schema, kNN queries, MCP tools, CLI query commands) is already implemented and tested.
- Primary gaps are narrow: (1) the `khipu index` CLI subcommand is missing from `cli.ts` — indexing is only reachable via `npm run index:embeddings` (a separate script); (2) `rebuildEmbeddings()` has no force-wipe mode, so `khipu index --force` cannot yet fully rebuild from scratch.
- Secondary gap: when `npm run sync --force` runs, `sync-runner.ts` calls the incremental `rebuildEmbeddings()`, not a forced per-platform rebuild, so Req 2 AC3 is partially unmet.
- Minor gap: model re-download detection and logging (Req 5 AC5) are not explicitly handled.
- Effort is small (S): all foundational plumbing exists; the missing pieces are additive with low integration risk.

---

## 1. Current State Investigation

### Key files and their roles

| File | Role | Status |
|------|------|--------|
| `src/embeddings.ts` | ONNX pipeline, batch embed, local model cache | Complete |
| `src/vec-db.ts` | sqlite-vec schema, kNN queries, index-state tracking | Complete |
| `src/index-embeddings.ts` | Incremental rebuild (`rebuildEmbeddings`), sync helpers (`embedNewMessages`, `embedNewChats`), progress bar, standalone CLI entry | Complete except --force mode |
| `src/query-handlers.ts` | `handleSemanticFindContacts`, `handleSemanticSearchMessages`, temporal filter parsing | Complete |
| `src/mcp.ts` | `semantic_find_contacts`, `semantic_search_messages` MCP tools with all filter params | Complete |
| `src/cli.ts` | Query CLI (`semantic-search`, `semantic-contacts`) | Complete; missing `index` subcommand |
| `src/sync-runner.ts` | Calls `rebuildEmbeddings(platform)` on `--force` sync | Partial (incremental only, not forced) |
| `src/db.ts` | WAL mode, `loadVecExtension`, `createVecSchema` wired into `initDb` | Complete |

### Architecture patterns relevant to this feature

- All DB calls are synchronous (better-sqlite3). Embedding inference is async, wrapped in async functions with a synchronous-first DB shell.
- `cli.ts` is a tool-dispatch script (switch on the first positional arg); adding `index` requires a new case and imports from `index-embeddings.ts`.
- `index-embeddings.ts` has its own `main()` entry point used by `npm run index:embeddings`. If `cli.ts` also dispatches to the same logic, the two entry points share `rebuildEmbeddings()` without duplication.
- `vec0` virtual tables require DELETE + INSERT for upsert; this is already handled.
- The `embedding_meta` table tracks "has ever been indexed" per table name. `isIndexed()` gates the MCP tools — callers get a descriptive error until at least one full index run completes.

---

## 2. Requirements Feasibility Analysis

### Requirement 1: Initial Embedding Indexing (`khipu index`)

| AC | Status | Gap |
|----|--------|-----|
| 1. Embed all messages on `khipu index` | Exists (`rebuildEmbeddings()` incremental; on a fresh DB it indexes everything) | None on fresh DB |
| 2. Embed all chats on `khipu index` | Exists | None |
| 3. Report count on completion | Exists (stdout: "Done. Indexed X messages, Y chats") | Minor: counts newly-indexed rows this run, not total in DB |
| 4. Incremental by default (skip already-indexed) | Exists | None |
| 5. `khipu index --force` re-embeds from scratch | **Missing**: no force-wipe mode; `rebuildEmbeddings()` always skips already-indexed rows | Need: delete all vec rows then sweep |
| 6. No network transmission | Exists (`allowRemoteModels = false` after model load) | None |
| 7. Log progress at least every 1,000 messages | Exists (progress bar updates every 100-msg batch) | Satisfies requirement |

**CLI surface gap**: `khipu index` and `khipu index --force` are not wired into `src/cli.ts`. The equivalent functionality is only available via `npm run index:embeddings` which does not support `--force`.

### Requirement 2: Incremental and Automated Embedding

| AC | Status | Gap |
|----|--------|-----|
| 1. Embed new messages after each sync | Exists (`sync-runner.ts` calls `rebuildEmbeddings(platform)` on force, adapters call `embedNewMessages` directly in incremental path) | Needs verification per adapter |
| 2. Update chat embedding after sync | Exists (`embedNewChats(chatIds)`) | Same |
| 3. `--force` sync rebuilds affected message embeddings | **Partial**: `sync-runner.ts` calls incremental `rebuildEmbeddings(platform)`; already-indexed messages are skipped even in `--force` mode | Need a force path scoped to the platform |
| 4. Programmatic API callable without spawning CLI | Exists (`rebuildEmbeddings()` exported) | None |
| 5. Per-message failure isolation | Exists (try/catch per message, log + continue) | None |

### Requirement 3: `semantic_find_contacts` MCP tool

| AC | Status | Gap |
|----|--------|-----|
| 1-6. Ranked results with all filter params (limit, before, after, platform) | Exists | None |
| 7. Error when index not built | Exists (`isIndexed('chats')` + descriptive message) | None |
| 8. Empty list below similarity threshold | Exists (`CONTACT_DISTANCE_THRESHOLD = 0.7`) | None |

### Requirement 4: `semantic_search_messages` MCP tool

| AC | Status | Gap |
|----|--------|-----|
| 1-7. Ranked results with all filter params (chat_id, platform, before/after timestamps, limit) | Exists | None |
| 8. Error when index not built | Exists (`isIndexed('messages')` check) | None |

### Requirement 5: Performance and Resource Constraints

| AC | Status | Gap |
|----|--------|-----|
| 1. 2-second query ceiling | Likely met (sqlite-vec kNN is in-process); no benchmark test exists | Flag: needs validation |
| 2. 2 GB / 1M messages storage | 384 dims x 4 bytes x 1M = ~1.5 GB; within limit | None |
| 3. Concurrent operation during indexing | WAL mode is on; indexing runs in a separate process | None |
| 4. Model downloaded once, cached | Exists (`env.cacheDir = ~/.cache/khipuchat/models`, `allowRemoteModels = false` after first load) | None |
| 5. Re-download on absent/corrupt cache + log | **Partial**: HuggingFace transformers retries on null pipeline; no explicit log of "downloading model" | Minor: add log line before `pipeline()` |

---

## 3. Implementation Approach Options

### Option A: Extend `src/cli.ts` and extend `rebuildEmbeddings()` (Recommended)

Add an `index` case to the `cli.ts` switch, import `rebuildEmbeddings` from `index-embeddings.ts`, and add a `force: boolean` parameter to `rebuildEmbeddings()` that deletes all vec rows before the sweep.

- **Files to change**: `src/cli.ts` (new case), `src/index-embeddings.ts` (force param + vec delete logic), `src/sync-runner.ts` (pass force flag), `src/embeddings.ts` (download log)
- + Minimal new files; follows existing patterns exactly
- + Single source of truth for rebuild logic
- + `cli.ts` stays as the unified query+admin surface
- - `cli.ts` mixes query and admin tools; manageable given the 200-line limit is not at risk

### Option B: New `src/cli-index.ts` entry point

Create a dedicated `src/cli-index.ts` and add a `khipu:index` npm script.

- + Clear separation between query CLI and admin CLI
- - Another entry point for users to track; inconsistent with how `cli.ts` handles sync-adjacent tasks

### Option C: Extend only `index-embeddings.ts` main() (skip `cli.ts`)

Support `--force` in the existing `npm run index:embeddings` standalone script without adding a `cli.ts` case.

- + Smallest change surface
- - Does not satisfy the requirement that the command is `khipu index` / `khipu index --force`; spec requires a named CLI subcommand

---

## 4. Recommendations for Design Phase

**Preferred approach**: Option A.

Concrete tasks:

1. **`rebuildEmbeddings(platform?, force?)`**: When `force` is true, execute `DELETE FROM vec_messages WHERE rowid IN (SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.platform = ?)` (platform-scoped) or `DELETE FROM vec_messages` / `DELETE FROM vec_chats` (global) before the incremental sweep.

2. **`cli.ts` `index` case**: Parse `--force` from argv. Call `rebuildEmbeddings(undefined, force)`. The `initDb` call already runs at module top; no extra setup needed.

3. **`sync-runner.ts`**: Pass `force` through to `rebuildEmbeddings(adapter.platform, force)` for Req 2 AC3.

4. **`embeddings.ts` download log**: Add a log line before `pipeline()` if the model cache directory does not contain the model files. Satisfies Req 5 AC5 without adding a net dependency.

5. **Test**: Add a Vitest test for the force-rebuild path (upsert vectors, call rebuild with force=true, verify count restored from scratch).

**Research items to carry forward:**

- Benchmark query latency on a large DB to confirm the 2-second ceiling.
- Verify `DELETE FROM vec0_table WHERE rowid IN (SELECT ...)` syntax works on sqlite-vec virtual tables (may need to test vs `DELETE FROM vec_messages` + re-insert approach).
- Confirm whether `isIndexed` should be updated to check vec table row count instead of `embedding_meta` (relevant if users sync but never run `khipu index`).

---

## 5. Complexity and Risk

| Dimension | Rating | Justification |
|-----------|--------|---------------|
| Effort | **S** (1-3 days) | All foundational plumbing exists. Gaps are additive and isolated: one new CLI case, one new parameter, one conditional DELETE |
| Risk | **Low** | No new external dependencies, no schema changes, no architectural shifts. Force-delete path is the only net-new operation; sqlite-vec DELETE is standard SQL |

---

# Design-Phase Synthesis (2026-07-12)

## Current-State Re-Verification (design phase)

Re-read of the actual source at design time refines the gap analysis:

- `rebuildEmbeddings(platform?)` already exists **with** the platform parameter (`index-embeddings.ts:138`); it still has **no `force` parameter**. Force-wipe is the one net-new behavior.
- `sync-runner.ts:63` already calls `rebuildEmbeddings(adapter.platform)` on `--force`, but passes no force flag downstream — already-indexed rows are skipped, so Req 2.3 (rebuild *affected* embeddings) is unmet.
- `cli.ts` dispatches query tools only (`semantic-search`, `semantic-contacts`, `search`, `list-chats`, …). No `index` case. Req 1 CLI surface unmet.
- `embeddings.ts` flips `env.allowRemoteModels = true → false` after first load; there is no explicit "downloading model" log tied to cache absence/corruption. `index-embeddings.ts:154` logs a download notice, but only gated on `!isIndexed('messages')`, not on actual cache state. Req 5.5 partially unmet.
- `INDEX_NOT_BUILT_MSG` (`query-handlers.ts:194`) and both MCP tool descriptions (`mcp.ts:46-47`) still instruct `npm run index:embeddings`. Req 3.7 / 4.8 require the operator be pointed at `khipu index`.
- `Done. Indexed X messages, Y chats` reports rows embedded **this run**, not DB totals. Req 1.3 asks for the total successfully indexed.
- An `account` column already exists on results and filters (multi-account plumbing is partly present). This spec does **not** add account-scoped indexing; it stays single-account per the boundary. The existing `account` passthrough filter is left untouched.

## Build-vs-Adopt / Simplification (unchanged, reaffirmed)

- Extend `rebuildEmbeddings` with `force?: boolean` rather than adding a parallel `forceRebuild()` — single source of truth (Option A from gap analysis).
- Add the `index` case to `cli.ts` rather than a new entry point (Option A) — keeps one unified admin+query surface, consistent with how `cli.ts` already hosts multiple tools.
- Force-wipe uses the same DELETE-then-INSERT idiom `upsertMessageVector`/`upsertChatVector` already rely on, so no new sqlite-vec interaction pattern is introduced.

## Force-Delete Approach & Residual Risk

- Global force: `DELETE FROM vec_messages` / `DELETE FROM vec_chats`.
- Platform-scoped force (sync `--force`): delete only rows whose chat is on that platform.
- **Risk**: `DELETE FROM vec0_table WHERE rowid IN (SELECT ...)` against a vec0 virtual table is not yet verified. **Mitigation**: collect the target rowids with a plain SQL SELECT over `messages`/`chats`, then delete per-rowid (the proven `upsert` idiom) in a loop. The design specifies the per-rowid fallback as the primary implementation to avoid depending on unverified subquery-DELETE support.

## Carried-Forward Validation Items

- Benchmark query latency on a ~1M-row DB to confirm the 2s ceiling (Req 5.1) — no automated benchmark exists; treat as a manual validation checkpoint, not a blocking unit test.
- Confirm the force-rebuild path restores identical row counts from scratch (new Vitest test).
