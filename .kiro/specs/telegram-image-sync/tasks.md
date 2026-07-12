# Implementation Plan

- [ ] 1. Foundation: schema migrations and database layer
- [ ] 1.1 Add ocr_text column migration and two-column FTS schema
  - Add `columnExists`-guarded migration adding `ocr_text TEXT` to `messages` table (leaves existing rows untouched)
  - Implement `applyFtsSchema(db)` in db-migrations.ts: creates `messages_fts` over `(text, ocr_text)` with `messages_fts_insert`, `messages_fts_delete`, and `messages_fts_update` triggers
  - Add FTS recreate guard: detect stale one-column `messages_fts` via `columnExists(db,'messages_fts','ocr_text')`, drop it and its legacy triggers, then call `applyFtsSchema`
  - `applyFtsSchema` is exported and callable idempotently (double-run leaves DB unchanged)
  - _Requirements: 3.3, 4.1, 7.4_

- [ ] 1.2 Extend db.ts with media/OCR fields and lookup functions
  - Add `ocr_text?: string | null` to `Message`/`MessageRow` interface
  - Delegate FTS DDL in `createSchema` to `applyFtsSchema` imported from db-migrations.ts
  - Implement `updateMessageMedia(id, fields: MediaUpdate)` building its SET clause from only the keys present in `fields` (never touches `text`, embeddings, or other columns)
  - Implement `getMessageIdByExternalId(chatId, externalId)` returning the auto-increment id or null when absent
  - Running `updateMessageMedia` with only `ocr_text` set leaves `text` and all other fields unchanged
  - _Requirements: 1.6, 3.3, 4.1, 4.3, 7.3_
  - _Depends: 1.1_

- [ ] 1.3 (P) Add mediaDir config, tesseract.js dependency, and infrastructure config
  - Add `mediaDir` field to config.ts reading `MEDIA_DIR` env var (default: `<root>/media`)
  - Add `tesseract.js ^5` to package.json dependencies
  - Add `media/` entry to .gitignore
  - Add named `media-data` volume mounted at `/app/media` on both `web` and `sync` services in docker-compose.yml
  - Running `npm install` after this task completes without errors; media directory is absent from git tracking
  - _Requirements: 2.3, 2.4_
  - _Boundary: config.ts, package.json, .gitignore, docker-compose.yml_

- [ ] 2. Core: platform-agnostic leaf services and embedding extension
- [ ] 2.1 (P) Implement platform-agnostic media storage helper
  - Create `src/media-storage.ts` exporting `storeMedia(input: StoreMediaInput): string` and `mediaPathFor(input)`
  - Path convention: `<mediaDir>/<platform>/<chat_id>/<external_id>.<ext>` (no leading dot on ext)
  - Create parent directories with `fs.mkdirSync(dir, { recursive: true })` before writing the buffer
  - `storeMedia` returns the absolute path written; `mediaPathFor` returns the same path without writing
  - Same inputs always resolve to the same path; calling `storeMedia` twice is an idempotent overwrite
  - _Requirements: 2.1, 2.2_
  - _Boundary: media-storage.ts_

- [ ] 2.2 (P) Implement platform-agnostic OCR module
  - Create `src/ocr.ts` exporting `extractText(input: string | Buffer): Promise<string | null>` and `terminateOcr(): Promise<void>`
  - Initialize a single tesseract.js worker lazily on the first `extractText` call; reuse across all subsequent calls
  - Return `null` (never throw) on empty/whitespace OCR output or any extraction failure, logging the error to stderr
  - Verify a single worker instance is reused: consecutive `extractText` calls do not re-initialize the worker
  - _Requirements: 3.1, 3.2, 3.5_
  - _Boundary: ocr.ts_

- [ ] 2.3 (P) Extend embedding pipeline to include OCR text
  - Update every unindexed-message predicate in `index-embeddings.ts` from text-only to `((text IS NOT NULL AND text != '') OR (ocr_text IS NOT NULL AND ocr_text != ''))`
  - Build embedding input as `[row.text, row.ocr_text].filter(Boolean).join(' ')`
  - Consolidate the shared predicate and `SELECT id, text, ocr_text` column list into module-level constants so all call sites stay consistent
  - An image-only message (`text=null`, `ocr_text` set) appears in `vec_messages` after one `embedNewMessages` run and is not re-embedded on the next run
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: index-embeddings.ts_

- [ ] 3. Integration: Telegram orchestrator, sync wiring, and MCP tool
- [ ] 3.1 Implement Telegram image-sync orchestrator
  - Create `src/platforms/telegram/image-sync.ts` exporting `processImageMessages(client, chatId, imageMsgs, sleep?)`
  - For each image message: resolve DB id via `getMessageIdByExternalId`, skip if `media_file_path` already set, download buffer via `client.downloadMedia(msg)`
  - On successful download: store via `storeMedia`, run OCR via `extractText` (skip if `ocr_text` already non-null), persist via `updateMessageMedia` with path, width/height (from largest `msg.media.photo.sizes[]` entry), and ocr_text
  - Wrap each image in try/catch: any failure is logged and skipped; the next image in the batch continues processing
  - Sleep a configurable interval between downloads to stay within Telegram rate limits
  - A re-run of `processImageMessages` on already-processed messages makes zero DB writes
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.1, 3.2, 3.4, 7.1, 7.2, 7.3_
  - _Depends: 2.1, 2.2_
  - _Boundary: image-sync.ts_

- [ ] 3.2 Wire image pass into Telegram sync paths
  - Collect image `msg` objects during the insert loop in `sync.ts` for backfill, incremental, and live listener paths
  - Invoke `processImageMessages` after the insert loop and before `embedNewMessages` in each of the three paths (live listener passes a single-element array)
  - Invoke `terminateOcr()` after the sync run completes so the process exits cleanly
  - A backfill run, an incremental sync run, and a single live listener event each invoke image processing for their respective collected image messages
  - _Requirements: 1.1, 1.2, 1.3, 7.1_
  - _Depends: 3.1_
  - _Boundary: sync.ts_

- [ ] 3.3 (P) Implement get_image MCP tool
  - Create `src/image-handlers.ts` exporting `handleGetImage(messageId: number): Promise<GetImageResult>`
  - Handler reads the message row, returns a descriptive error when `media_file_path` is null or the file is missing on disk
  - On success: base64-encode the file content and return `GetImageResult` with `message_id`, `file_path`, `content_base64`, `ocr_text`, and `ocr_available` (false when `ocr_text` is null)
  - Register `get_image` in `mcp.ts` tool list and dispatch to `handleGetImage` following the existing handler pattern
  - Add `get_image` documentation to README alongside other MCP tools
  - Calling `get_image` with a valid message id returns JSON with all five result fields; calling it with no stored image returns an image-not-available error
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Boundary: image-handlers.ts, mcp.ts_

- [ ] 4. Validation: unit, integration, and E2E tests
- [ ] 4.1 (P) Unit tests for leaf services and database layer
  - `storeMedia` writes to `<mediaDir>/telegram/<chat>/<external>.jpg`, creates missing parent dirs, and returns the absolute path
  - `extractText` returns `null` (not throw) on an unreadable/garbage input; a single worker is reused across consecutive calls
  - `updateMessageMedia` sets only the supplied media/ocr columns; `text` and all other fields remain unchanged
  - FTS guard: starting with a one-column `messages_fts`, migration recreates it with `ocr_text`; after startup rebuild, `searchMessages('<ocr term>')` returns results
  - All unit tests pass
  - _Requirements: 2.1, 2.2, 3.2, 3.5, 4.1, 7.3, 7.4_
  - _Boundary: media-storage.ts, ocr.ts, db.ts, db-migrations.ts_

- [ ] 4.2 (P) Integration tests for image pass and search indexes
  - Image pass on an in-memory DB: fake client returns a buffer; image message receives `media_file_path` and `ocr_text`; re-run of the pass skips it with zero DB writes
  - Best-effort isolation: a download that throws leaves `media_file_path` unset and does not abort processing of the next image in the same batch
  - FTS discovery: after `ocr_text` is set via `updateMessageMedia`, `searchMessages('<ocr term>')` returns the image message even when `text` is null
  - Semantic discovery: an image message with only `ocr_text` is embedded on the next `embedNewMessages` run; a message already in `vec_messages` is not re-embedded
  - All integration tests pass
  - _Requirements: 1.1, 1.4, 1.5, 1.6, 3.4, 4.2, 4.3, 5.1, 5.4_
  - _Boundary: image-sync.ts, index-embeddings.ts, db.ts_

- [ ] 4.3 (P) E2E tests for get_image MCP tool
  - `get_image` for a stored image returns base64 content and `ocr_text` with `ocr_available: true`
  - `get_image` for a message with null `ocr_text` returns content with `ocr_available: false`
  - `get_image` for a message with no `media_file_path` returns an image-not-available error
  - All E2E tests pass
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: image-handlers.ts, mcp.ts_
