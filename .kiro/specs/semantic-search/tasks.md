# Implementation Plan

- [x] 1. Foundation: dependencies, test harness, and npm script
- [x] 1.1 Install embedding and vector-store packages; verify extension compatibility
  - Add `@huggingface/transformers` and `sqlite-vec` to package.json dependencies
  - Write a synchronous smoke test (in any test file) that calls `sqliteVec.load(db)` on an in-memory `better-sqlite3-multiple-ciphers` instance and confirms no error is thrown — this validates the critical risk of extension compatibility with the fork
  - Note: `initDb()` already sets `journal_mode = WAL`, satisfying the concurrent-process requirement (5.3) without additional work
  - `npm install` succeeds; darwin-arm64 prebuilts resolve for both packages without compilation errors
  - The smoke test passes: `SELECT vec_version()` returns a version string
  - _Requirements: 1.5, 5.3_

- [x] 1.2 Add the index:embeddings npm script
  - Add `"index:embeddings": "tsx src/index-embeddings.ts"` to the scripts section of package.json
  - `npm run index:embeddings -- --help 2>&1 || true` exits without a "script not found" error (script entry point registered)
  - _Requirements: 1.1_

- [x] 2. (P) Embedding inference module
- [x] 2.1 Implement local ONNX embedding with model caching and offline mode
  - Create `src/embeddings.ts` with a module-level lazy pipeline singleton
  - On first call, set `env.cacheDir = path.join(os.homedir(), '.cache', 'khipuchat', 'models')` and `env.allowRemoteModels = true`; after the model loads successfully, flip `env.allowRemoteModels = false` so subsequent runs are fully offline
  - Implement `embed(texts: string[]): Promise<Float32Array[]>` using `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32', device: 'cpu' })` with `{ pooling: 'mean', normalize: true }`; return one `Float32Array` per input
  - Implement `embedOne(text: string): Promise<Float32Array>` as a convenience one-liner wrapper
  - Calling `embedOne('hello world')` returns a `Float32Array` of exactly 384 elements; calling it twice with the same input returns identical bytes (deterministic ONNX model)
  - _Requirements: 1.5, 5.4, 5.5_
  - _Boundary: embeddings.ts_

- [x] 3. (P) Vector storage functions
- [x] 3.1 Create vec-db.ts, define vector schema, and wire extension into DB init
  - Create `src/vec-db.ts`; export `loadVecExtension(db: Database.Database): void` wrapping `sqliteVec.load(db)`
  - Export `createVecSchema(): void` that creates `vec_chats` (vec0 virtual, cosine), `vec_messages` (vec0 virtual, cosine), and `embedding_meta` (regular) tables using `IF NOT EXISTS`
  - In `src/db.ts`, import `loadVecExtension` and `createVecSchema` from `./vec-db`; call `loadVecExtension(_db)` then `createVecSchema()` inside `initDb()` after the existing pragma calls
  - Export `isIndexed(table: 'chats' | 'messages'): boolean`, `upsertEmbeddingMeta(table: string, ts: number): void`
  - Export `getUnindexedMessages(limit: number): Array<{ id: number; text: string }>`, `getUnindexedChats(): Array<{ id: number; name: string }>`, `getChatSnippets(chatId: number, n?: number): string[]`
  - Export `upsertMessageVector(id: number, vector: Float32Array): void` and `upsertChatVector(id: number, vector: Float32Array): void` passing `BigInt(id)` and the `Float32Array` directly to a prepared statement
  - `initDb(':memory:')` succeeds in existing tests with no regression; `SELECT * FROM embedding_meta` returns an empty result; after `upsertMessageVector(42, vec)`, `SELECT rowid FROM vec_messages WHERE rowid = 42` returns one row
  - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.2_
  - _Boundary: vec-db.ts, db.ts (initDb wiring only)_

- [x] 3.2 Implement semantic contact discovery with filters and similarity threshold
  - Export `semanticFindContacts(queryVector: Float32Array, filters: ContactFilters): SemanticContactResult[]`
  - Issue a kNN `WHERE embedding MATCH ? AND k = ?` query on `vec_chats`; join `chats` for name, platform, message count, and last message date; fetch one recent snippet per result via `getChatSnippets`
  - Apply `before`, `after` (unix-timestamp filters on last message date), and `platform` filters; clamp limit to 1–50 (default 10); exclude results where `distance > 0.7`
  - `semanticFindContacts(vec, {})` returns results sorted by ascending distance; results with distance > 0.7 are absent; an empty array is returned when no chat qualifies
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8_
  - _Boundary: vec-db.ts_

- [x] 3.3 Implement semantic message search with filters
  - Export `semanticSearchMessages(queryVector: Float32Array, filters: MessageFilters): SemanticMessageResult[]`
  - Issue a kNN query on `vec_messages`; join `messages` and `chats`; return `chat_name`, `sender_name`, `text`, `timestamp`, `platform`, `distance`
  - Apply `chat_id`, `platform`, `before_timestamp`, and `after_timestamp` filters; clamp limit to 1–100 (default 20)
  - `semanticSearchMessages(vec, { platform: 'telegram' })` on a seeded DB excludes non-telegram messages; results are sorted by ascending distance
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - _Boundary: vec-db.ts_

- [x] 4. (P) Indexing CLI and sync-integration exports
- [x] 4.1 Implement batch message indexing with progress logging and summary
  - Create `src/index-embeddings.ts`; call `initDb(dbPath)` then iterate `getUnindexedMessages(100)` in a loop until no rows remain
  - For each batch: call `embed(texts)`, then `upsertMessageVector` for each result; catch per-message errors with `console.error` and continue
  - Log `Indexed N/total messages...` to stdout every 1,000 messages; log `Downloading embedding model (~90 MB)...` before the first `embed()` call on a fresh index
  - On completion print `Done. Indexed X messages, Y chats.`; exit code 0
  - _Requirements: 1.1, 1.3, 1.5, 1.6, 2.3, 5.3_
  - _Boundary: index-embeddings.ts_
  - _Depends: 2.1, 3.1_

- [x] 4.2 Add chat indexing, incremental skip, and named sync-integration exports
  - After message indexing, iterate `getUnindexedChats()`; for each chat build input text as `<name>. <snippet1>. ... <snippet5>` via `getChatSnippets`; call `embedOne` + `upsertChatVector`
  - Call `upsertEmbeddingMeta('messages', Date.now())` and `upsertEmbeddingMeta('chats', Date.now())` after all indexing completes
  - Export `embedNewMessages(chatIds: number[]): Promise<void>` and `embedNewChats(chatIds: number[]): Promise<void>` as named exports from `index-embeddings.ts`; each function runs `getUnindexedMessages`/`getUnindexedChats` filtered to the given IDs, calls `embed`/`embedOne`, and upserts vectors — wrapping each individual call in try/catch with `console.error` on failure
  - Running `npm run index:embeddings` a second time on the same DB skips already-indexed records and prints `Done. Indexed 0 messages, 0 chats.`
  - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 2.3_
  - _Boundary: index-embeddings.ts_

- [x] 5. (P) MCP tool handlers
- [x] 5.1 Add semantic_find_contacts MCP tool handler and registration
  - Export `async function handleSemanticFindContacts(query: string, filters: ContactFilters): Promise<SemanticContactResult[] | { error: string }>` in `src/mcp.ts`
  - Check `isIndexed('chats')`; return `{ error: 'Embedding index not built. Run: npm run index:embeddings' }` if false; otherwise call `embedOne(query)` then `semanticFindContacts(vector, filters)`
  - Register `semantic_find_contacts` in `ListToolsRequestSchema` handler with `query` (required string), `limit`, `before`, `after`, `platform` in inputSchema; dispatch inside the existing auth-gated block in `CallToolRequestSchema`
  - Calling the tool with an unbuilt index returns the descriptive error string; calling it with a seeded index returns a JSON array where each element has `chat_id`, `name`, `platform`, `last_message_date`, `message_count`, `snippet`, `distance`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_
  - _Boundary: mcp.ts additions_
  - _Depends: 2.1, 3.2_

- [x] 5.2 Add semantic_search_messages MCP tool handler and registration
  - Export `async function handleSemanticSearchMessages(query: string, filters: MessageFilters): Promise<SemanticMessageResult[] | { error: string }>` in `src/mcp.ts`
  - Check `isIndexed('messages')`; return the same descriptive error string if false; otherwise call `embedOne(query)` then `semanticSearchMessages(vector, filters)`
  - Register `semantic_search_messages` in `ListToolsRequestSchema` with `query` (required), `limit`, `chat_id`, `platform`, `before_timestamp`, `after_timestamp`; dispatch inside the auth-gated block
  - Calling the tool with `platform: 'telegram'` on a multi-platform seeded index returns only telegram messages; calling with an unbuilt index returns the error string
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_
  - _Boundary: mcp.ts additions_
  - _Depends: 2.1, 3.3_

- [x] 6. Tests and sync integration
- [x] 6.1 (P) Unit tests for the embedding inference module
  - Create `tests/embeddings.test.ts`; mock the `@huggingface/transformers` pipeline using Vitest `vi.mock` to return deterministic fake Float32Arrays (avoid 90 MB model download in CI)
  - Test: `embedOne('x')` returns a `Float32Array` of length 384
  - Test: `embed(['a', 'b'])` returns exactly two arrays of length 384
  - Test: same input produces identical output bytes (deterministic mock)
  - All three tests pass with `npm test`
  - _Requirements: 5.4, 5.5_
  - _Boundary: embeddings.ts_

- [x] 6.2 (P) Unit tests for vector storage functions
  - Create `tests/vec-db.test.ts`; seed an in-memory DB via `initDb(':memory:')` (which loads the extension); use hardcoded 384-element Float32Arrays for test vectors
  - Test: `loadVecExtension` does not throw; `SELECT vec_version()` returns a string
  - Test: after `upsertMessageVector(1, vec)`, id 1 no longer appears in `getUnindexedMessages` results
  - Test: `semanticFindContacts` with two seeded chat vectors returns results ordered by ascending distance; a result with distance > 0.7 is excluded
  - Test: `semanticFindContacts` with `platform: 'imessage'` excludes telegram chats
  - Test: `semanticSearchMessages` with `before_timestamp: N` excludes messages at or after N
  - Test: `isIndexed('messages')` returns false before `upsertEmbeddingMeta`, true after
  - All tests pass with `npm test`
  - _Requirements: 1.4, 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 4.3, 4.4, 4.6, 4.7_
  - _Boundary: vec-db.ts_

- [x] 6.3 Integration tests for MCP semantic tool handlers
  - Add tests to `tests/mcp.test.ts`; seed in-memory DB with chats, messages, and pre-inserted vectors; mock `embedOne` to return the pre-inserted query vector
  - Test: `handleSemanticFindContacts('query', {})` returns `{ error: ... }` when `embedding_meta` is empty
  - Test: `handleSemanticFindContacts('query', {})` with a seeded index returns an array with the expected `SemanticContactResult` fields
  - Test: `handleSemanticSearchMessages('query', { platform: 'telegram' })` excludes non-telegram results
  - Test: `handleSemanticSearchMessages('query', { before_timestamp: N })` excludes messages at or after N
  - All new tests pass alongside existing MCP tests with `npm test`
  - _Requirements: 3.7, 4.8, 3.1, 3.6, 4.1, 4.4, 4.6_

- [x] 6.4 Wire incremental embedding into platform sync scripts
  - In `src/platforms/telegram/sync.ts`, import `embedNewMessages` and `embedNewChats` from `../../index-embeddings`; call them at the end of the main sync loop, passing the IDs of chats that received new messages; wrap in try/catch so embedding failure does not abort the sync
  - Repeat the identical pattern in the remaining six sync scripts (imessage, wechat, discord, slack, email, whatsapp) — each script calls `embedNewMessages` + `embedNewChats` at the end of its message-insertion loop
  - After `npm run sync:telegram` runs on a DB with existing Telegram messages, `isIndexed('messages')` returns true and `getUnindexedMessages(1)` returns an empty array for the synced chats
  - A deliberately broken `embed()` call (e.g., by setting an invalid cache path) logs an error to stderr but does not cause the sync script to exit with a non-zero code
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 4.2_

- [x] 6.5 E2E test: index:embeddings CLI on seeded database
  - Seed a test SQLite file with known chats and messages; run `npx tsx src/index-embeddings.ts` via `child_process.execSync` pointed at the seeded file
  - Assert: exit code 0; stdout contains `Done. Indexed`; `embedding_meta` table has rows for both 'messages' and 'chats'
  - Run again on same DB; assert second run prints `Done. Indexed 0 messages, 0 chats.` (incremental skip)
  - _Requirements: 1.3, 1.4, 1.6_

- [ ] 7. (P) Add force-clear helpers to the vector store
  - Add `clearMessageVectors(platform?)`: when no platform is given, delete all rows from `vec_messages`; when platform is set, collect matching rowids from `messages` where platform matches, then delete each from `vec_messages` per rowid (the proven per-rowid DELETE idiom, not a subquery on `vec0`)
  - Add `clearChatVectors(platform?)`: identical pattern for `chats` / `vec_chats`
  - After `clearMessageVectors()`, `SELECT COUNT(*) FROM vec_messages` returns 0; after a platform-scoped clear, only that platform's vectors are removed and all others remain
  - _Requirements: 1.5_
  - _Boundary: VecStore (vec-db.ts)_

- [ ] 8. (P) Log model download on cache miss in the embedding module
  - Before the `pipeline()` call, check whether the model's own subdirectory under `env.cacheDir` exists and is non-empty
  - If absent or incomplete, emit a log line indicating a download is occurring before loading begins
  - If the cache is valid, load silently (no log line emitted)
  - Keep the `KHIPUCHAT_EMBED_MOCK` test hook intact so existing unit tests are unaffected
  - On a simulated-missing-cache run, exactly one download-notice log line appears; on a cache-present run, no line appears
  - _Requirements: 5.5_
  - _Boundary: Embeddings (embeddings.ts)_

- [ ] 9. (P) Update not-built error messages and MCP tool descriptions to reference `khipu index`
  - Change `INDEX_NOT_BUILT_MSG` in `query-handlers.ts` to instruct operators to run `khipu index` instead of the old npm script reference
  - Update both `semantic_find_contacts` and `semantic_search_messages` tool descriptions in `mcp.ts` to reference `khipu index`
  - Both MCP tools return an error string containing the text `khipu index` when the embedding index is absent
  - _Requirements: 3.7, 4.8_
  - _Boundary: SemanticTools (query-handlers.ts, mcp.ts)_

- [ ] 10. Add force-rebuild path and total-count reporting to the indexing pipeline
  - Extend `rebuildEmbeddings(platform?, force?)` to accept an optional `force` boolean
  - When `force` is true, call `clearMessageVectors(platform)` and `clearChatVectors(platform)` before running the incremental sweep, making all in-scope rows "unindexed" without a separate full-scan branch
  - After both message and chat phases complete, read row counts from `vec_messages` and `vec_chats` (scoped to platform when set) and print the completion line reporting those DB totals
  - Preserve per-record failure isolation: a failed embed is caught, logged to stderr, and skipped; the sweep does not abort
  - `rebuildEmbeddings(undefined, true)` on a seeded, previously-indexed DB completes with a completion line reporting the expected DB-total row counts; incremental behavior is unchanged when `force` is omitted
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.4, 2.5_
  - _Depends: 7_
  - _Boundary: IndexPipeline (index-embeddings.ts)_

- [ ] 11. Add `khipu index [--force]` CLI subcommand
  - Add `case 'index'` to the existing dispatch switch in `cli.ts`
  - Parse `--force` from `process.argv` within this case
  - Call `rebuildEmbeddings(undefined, force)` and exit with code 0 on success
  - Extend the CLI usage/help text to include the `index [--force]` command
  - `khipu index` triggers an incremental whole-DB sweep; `khipu index --force` triggers a clear-then-rebuild; the usage text lists the `index` command
  - _Requirements: 1.1, 1.3, 1.4, 1.5_
  - _Depends: 10_
  - _Boundary: IndexCli (cli.ts)_

- [ ] 12. (P) Wire sync `--force` through to the embedding pipeline
  - In `sync-runner.ts`, pass the already-parsed `force` flag into `rebuildEmbeddings(adapter.platform, force)`
  - A `sync --force` run calls `rebuildEmbeddings` with both the platform identifier and `force=true`, causing already-indexed messages for that platform to be re-embedded from scratch
  - _Requirements: 2.3_
  - _Depends: 10_
  - _Boundary: SyncEmbedHook (sync-runner.ts)_

- [ ] 13. Tests for gap-closure changes
- [ ] 13.1 (P) Unit tests for force-clear helpers
  - Global `clearMessageVectors()` empties `vec_messages`; platform-scoped clear removes only that platform's vectors and leaves others intact
  - Same coverage for `clearChatVectors`
  - _Requirements: 1.5_
  - _Boundary: VecStore (vec-db.ts)_

- [ ] 13.2 (P) Unit tests for `rebuildEmbeddings` force path and count reporting
  - Seed the DB, index once, force-rebuild: row counts in `vec_messages`/`vec_chats` match the original seed count
  - Completion line reports DB totals, not only rows embedded in the current run
  - A deliberate per-record embed failure leaves the sweep running for remaining records
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.5_
  - _Depends: 10_
  - _Boundary: IndexPipeline (index-embeddings.ts)_

- [ ] 13.3 (P) Unit tests for model-download logging
  - Simulated-missing-cache run emits exactly one download-notice log line; cache-present run emits none
  - Existing `KHIPUCHAT_EMBED_MOCK`-guarded tests remain unaffected
  - _Requirements: 5.5_
  - _Depends: 8_
  - _Boundary: Embeddings (embeddings.ts)_

- [ ] 13.4 (P) Integration tests for the `khipu index` CLI subcommand
  - `khipu index` triggers an incremental whole-DB sweep and exits 0
  - `khipu index --force` triggers a clear-then-rebuild
  - Usage/help output lists the `index` command
  - _Requirements: 1.1, 1.3, 1.4, 1.5_
  - _Depends: 11_
  - _Boundary: IndexCli (cli.ts)_

- [ ] 13.5 (P) Integration tests for the sync `--force` embedding path
  - `sync --force` calls `rebuildEmbeddings(platform, true)` so already-indexed messages for that platform are re-embedded
  - _Requirements: 2.3_
  - _Depends: 12_
  - _Boundary: SyncEmbedHook (sync-runner.ts)_

- [ ] 13.6 (P) Integration tests for updated MCP not-built message text
  - Both `semantic_find_contacts` and `semantic_search_messages` return an error string containing `khipu index` when the index is absent
  - _Requirements: 3.7, 4.8_
  - _Depends: 9_
  - _Boundary: SemanticTools (query-handlers.ts, mcp.ts)_
