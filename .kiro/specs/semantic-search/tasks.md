# Implementation Plan

- [ ] 1. Foundation: dependencies, test harness, and npm script
- [ ] 1.1 Install embedding and vector-store packages; verify extension compatibility
  - Add `@huggingface/transformers` and `sqlite-vec` to package.json dependencies
  - Write a synchronous smoke test (in any test file) that calls `sqliteVec.load(db)` on an in-memory `better-sqlite3-multiple-ciphers` instance and confirms no error is thrown — this validates the critical risk of extension compatibility with the fork
  - Note: `initDb()` already sets `journal_mode = WAL`, satisfying the concurrent-process requirement (5.3) without additional work
  - `npm install` succeeds; darwin-arm64 prebuilts resolve for both packages without compilation errors
  - The smoke test passes: `SELECT vec_version()` returns a version string
  - _Requirements: 1.5, 5.3_

- [ ] 1.2 Add the index:embeddings npm script
  - Add `"index:embeddings": "tsx src/index-embeddings.ts"` to the scripts section of package.json
  - `npm run index:embeddings -- --help 2>&1 || true` exits without a "script not found" error (script entry point registered)
  - _Requirements: 1.1_

- [ ] 2. (P) Embedding inference module
- [ ] 2.1 Implement local ONNX embedding with model caching and offline mode
  - Create `src/embeddings.ts` with a module-level lazy pipeline singleton
  - On first call, set `env.cacheDir = path.join(os.homedir(), '.cache', 'khipuchat', 'models')` and `env.allowRemoteModels = true`; after the model loads successfully, flip `env.allowRemoteModels = false` so subsequent runs are fully offline
  - Implement `embed(texts: string[]): Promise<Float32Array[]>` using `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32', device: 'cpu' })` with `{ pooling: 'mean', normalize: true }`; return one `Float32Array` per input
  - Implement `embedOne(text: string): Promise<Float32Array>` as a convenience one-liner wrapper
  - Calling `embedOne('hello world')` returns a `Float32Array` of exactly 384 elements; calling it twice with the same input returns identical bytes (deterministic ONNX model)
  - _Requirements: 1.5, 5.4, 5.5_
  - _Boundary: embeddings.ts_

- [ ] 3. (P) Vector storage functions
- [ ] 3.1 Create vec-db.ts, define vector schema, and wire extension into DB init
  - Create `src/vec-db.ts`; export `loadVecExtension(db: Database.Database): void` wrapping `sqliteVec.load(db)`
  - Export `createVecSchema(): void` that creates `vec_chats` (vec0 virtual, cosine), `vec_messages` (vec0 virtual, cosine), and `embedding_meta` (regular) tables using `IF NOT EXISTS`
  - In `src/db.ts`, import `loadVecExtension` and `createVecSchema` from `./vec-db`; call `loadVecExtension(_db)` then `createVecSchema()` inside `initDb()` after the existing pragma calls
  - Export `isIndexed(table: 'chats' | 'messages'): boolean`, `upsertEmbeddingMeta(table: string, ts: number): void`
  - Export `getUnindexedMessages(limit: number): Array<{ id: number; text: string }>`, `getUnindexedChats(): Array<{ id: number; name: string }>`, `getChatSnippets(chatId: number, n?: number): string[]`
  - Export `upsertMessageVector(id: number, vector: Float32Array): void` and `upsertChatVector(id: number, vector: Float32Array): void` passing `BigInt(id)` and the `Float32Array` directly to a prepared statement
  - `initDb(':memory:')` succeeds in existing tests with no regression; `SELECT * FROM embedding_meta` returns an empty result; after `upsertMessageVector(42, vec)`, `SELECT rowid FROM vec_messages WHERE rowid = 42` returns one row
  - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.2_
  - _Boundary: vec-db.ts, db.ts (initDb wiring only)_

- [ ] 3.2 Implement semantic contact discovery with filters and similarity threshold
  - Export `semanticFindContacts(queryVector: Float32Array, filters: ContactFilters): SemanticContactResult[]`
  - Issue a kNN `WHERE embedding MATCH ? AND k = ?` query on `vec_chats`; join `chats` for name, platform, message count, and last message date; fetch one recent snippet per result via `getChatSnippets`
  - Apply `before`, `after` (unix-timestamp filters on last message date), and `platform` filters; clamp limit to 1–50 (default 10); exclude results where `distance > 0.7`
  - `semanticFindContacts(vec, {})` returns results sorted by ascending distance; results with distance > 0.7 are absent; an empty array is returned when no chat qualifies
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8_
  - _Boundary: vec-db.ts_

- [ ] 3.3 Implement semantic message search with filters
  - Export `semanticSearchMessages(queryVector: Float32Array, filters: MessageFilters): SemanticMessageResult[]`
  - Issue a kNN query on `vec_messages`; join `messages` and `chats`; return `chat_name`, `sender_name`, `text`, `timestamp`, `platform`, `distance`
  - Apply `chat_id`, `platform`, `before_timestamp`, and `after_timestamp` filters; clamp limit to 1–100 (default 20)
  - `semanticSearchMessages(vec, { platform: 'telegram' })` on a seeded DB excludes non-telegram messages; results are sorted by ascending distance
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - _Boundary: vec-db.ts_

- [ ] 4. (P) Indexing CLI and sync-integration exports
- [ ] 4.1 Implement batch message indexing with progress logging and summary
  - Create `src/index-embeddings.ts`; call `initDb(dbPath)` then iterate `getUnindexedMessages(100)` in a loop until no rows remain
  - For each batch: call `embed(texts)`, then `upsertMessageVector` for each result; catch per-message errors with `console.error` and continue
  - Log `Indexed N/total messages...` to stdout every 1,000 messages; log `Downloading embedding model (~90 MB)...` before the first `embed()` call on a fresh index
  - On completion print `Done. Indexed X messages, Y chats.`; exit code 0
  - _Requirements: 1.1, 1.3, 1.5, 1.6, 2.3, 5.3_
  - _Boundary: index-embeddings.ts_
  - _Depends: 2.1, 3.1_

- [ ] 4.2 Add chat indexing, incremental skip, and named sync-integration exports
  - After message indexing, iterate `getUnindexedChats()`; for each chat build input text as `<name>. <snippet1>. ... <snippet5>` via `getChatSnippets`; call `embedOne` + `upsertChatVector`
  - Call `upsertEmbeddingMeta('messages', Date.now())` and `upsertEmbeddingMeta('chats', Date.now())` after all indexing completes
  - Export `embedNewMessages(chatIds: number[]): Promise<void>` and `embedNewChats(chatIds: number[]): Promise<void>` as named exports from `index-embeddings.ts`; each function runs `getUnindexedMessages`/`getUnindexedChats` filtered to the given IDs, calls `embed`/`embedOne`, and upserts vectors — wrapping each individual call in try/catch with `console.error` on failure
  - Running `npm run index:embeddings` a second time on the same DB skips already-indexed records and prints `Done. Indexed 0 messages, 0 chats.`
  - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 2.3_
  - _Boundary: index-embeddings.ts_

- [ ] 5. (P) MCP tool handlers
- [ ] 5.1 Add semantic_find_contacts MCP tool handler and registration
  - Export `async function handleSemanticFindContacts(query: string, filters: ContactFilters): Promise<SemanticContactResult[] | { error: string }>` in `src/mcp.ts`
  - Check `isIndexed('chats')`; return `{ error: 'Embedding index not built. Run: npm run index:embeddings' }` if false; otherwise call `embedOne(query)` then `semanticFindContacts(vector, filters)`
  - Register `semantic_find_contacts` in `ListToolsRequestSchema` handler with `query` (required string), `limit`, `before`, `after`, `platform` in inputSchema; dispatch inside the existing auth-gated block in `CallToolRequestSchema`
  - Calling the tool with an unbuilt index returns the descriptive error string; calling it with a seeded index returns a JSON array where each element has `chat_id`, `name`, `platform`, `last_message_date`, `message_count`, `snippet`, `distance`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_
  - _Boundary: mcp.ts additions_
  - _Depends: 2.1, 3.2_

- [ ] 5.2 Add semantic_search_messages MCP tool handler and registration
  - Export `async function handleSemanticSearchMessages(query: string, filters: MessageFilters): Promise<SemanticMessageResult[] | { error: string }>` in `src/mcp.ts`
  - Check `isIndexed('messages')`; return the same descriptive error string if false; otherwise call `embedOne(query)` then `semanticSearchMessages(vector, filters)`
  - Register `semantic_search_messages` in `ListToolsRequestSchema` with `query` (required), `limit`, `chat_id`, `platform`, `before_timestamp`, `after_timestamp`; dispatch inside the auth-gated block
  - Calling the tool with `platform: 'telegram'` on a multi-platform seeded index returns only telegram messages; calling with an unbuilt index returns the error string
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_
  - _Boundary: mcp.ts additions_
  - _Depends: 2.1, 3.3_

- [ ] 6. Tests and sync integration
- [ ] 6.1 (P) Unit tests for the embedding inference module
  - Create `tests/embeddings.test.ts`; mock the `@huggingface/transformers` pipeline using Vitest `vi.mock` to return deterministic fake Float32Arrays (avoid 90 MB model download in CI)
  - Test: `embedOne('x')` returns a `Float32Array` of length 384
  - Test: `embed(['a', 'b'])` returns exactly two arrays of length 384
  - Test: same input produces identical output bytes (deterministic mock)
  - All three tests pass with `npm test`
  - _Requirements: 5.4, 5.5_
  - _Boundary: embeddings.ts_

- [ ] 6.2 (P) Unit tests for vector storage functions
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

- [ ] 6.3 Integration tests for MCP semantic tool handlers
  - Add tests to `tests/mcp.test.ts`; seed in-memory DB with chats, messages, and pre-inserted vectors; mock `embedOne` to return the pre-inserted query vector
  - Test: `handleSemanticFindContacts('query', {})` returns `{ error: ... }` when `embedding_meta` is empty
  - Test: `handleSemanticFindContacts('query', {})` with a seeded index returns an array with the expected `SemanticContactResult` fields
  - Test: `handleSemanticSearchMessages('query', { platform: 'telegram' })` excludes non-telegram results
  - Test: `handleSemanticSearchMessages('query', { before_timestamp: N })` excludes messages at or after N
  - All new tests pass alongside existing MCP tests with `npm test`
  - _Requirements: 3.7, 4.8, 3.1, 3.6, 4.1, 4.4, 4.6_

- [ ] 6.4 Wire incremental embedding into platform sync scripts
  - In `src/platforms/telegram/sync.ts`, import `embedNewMessages` and `embedNewChats` from `../../index-embeddings`; call them at the end of the main sync loop, passing the IDs of chats that received new messages; wrap in try/catch so embedding failure does not abort the sync
  - Repeat the identical pattern in the remaining six sync scripts (imessage, wechat, discord, slack, email, whatsapp) — each script calls `embedNewMessages` + `embedNewChats` at the end of its message-insertion loop
  - After `npm run sync:telegram` runs on a DB with existing Telegram messages, `isIndexed('messages')` returns true and `getUnindexedMessages(1)` returns an empty array for the synced chats
  - A deliberately broken `embed()` call (e.g., by setting an invalid cache path) logs an error to stderr but does not cause the sync script to exit with a non-zero code
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 4.2_

- [ ]* 6.5 E2E test: index:embeddings CLI on seeded database
  - Seed a test SQLite file with known chats and messages; run `npx tsx src/index-embeddings.ts` via `child_process.execSync` pointed at the seeded file
  - Assert: exit code 0; stdout contains `Done. Indexed`; `embedding_meta` table has rows for both 'messages' and 'chats'
  - Run again on same DB; assert second run prints `Done. Indexed 0 messages, 0 chats.` (incremental skip)
  - _Requirements: 1.3, 1.4, 1.6_
