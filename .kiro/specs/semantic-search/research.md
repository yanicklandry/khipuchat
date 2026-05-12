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
