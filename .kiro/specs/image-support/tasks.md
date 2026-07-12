# Implementation Plan

- [ ] 1. Search read model enrichment
- [x] 1.1 (P) Add `type` field to keyword search read model
  - In `src/db.ts`, extend `SearchResult` interface with `type: MessageType`
  - Add `m.type` to the SELECT in `searchMessages` query
  - A `search_messages` call returns a `type` field on every result row; an image match reports `type: 'image'`
  - _Requirements: 4.3_
  - _Boundary: db.ts SearchResult_

- [x] 1.2 (P) Add `type` field to semantic search read model
  - In `src/vec-db.ts`, extend `SemanticMessageResult` interface with `type: MessageType`
  - Add `m.type` to the semantic query SELECT/assembly
  - A `semantic_search_messages` call returns a `type` field on every result row
  - _Requirements: 4.3_
  - _Boundary: vec-db.ts SemanticMessageResult_

- [ ] 2. Fix image retrieval handler contract
- [x] 2.1 (P) Redefine result type and expand DB query
  - In `src/image-handlers.ts`, redefine `GetImageResult` as a discriminated union on `file_available` with `GetImageResultAvailable` and `GetImageResultUnavailable` arms
  - Both arms carry `ocr_text: string | null`, `ocr_available: boolean`, and `message_id: number`; `GetImageResultUnavailable` additionally carries `file_path: string | null` and `error: string`
  - Expand the SELECT to include `id, type, media_file_path, ocr_text`
  - TypeScript compiles without error after the union is defined
  - _Requirements: 3.2, 3.3_
  - _Boundary: image-handlers.ts GetImageResult type_

- [x] 2.2 Add type validation and file-unavailable degradation to handler
  - Check `row.type !== 'image'` before any path access; throw an error naming the actual type (e.g., "message 42 has type 'text', not supported by get_image")
  - When `media_file_path` is null, return `GetImageResultUnavailable` with `file_path: null`, `ocr_text`, and an informative `error` string identifying the message ID
  - When `fs.readFileSync` throws ENOENT, return `GetImageResultUnavailable` with `file_path` set to the path, `ocr_text`, and an `error` string
  - Non-ENOENT read errors propagate (rethrow)
  - `handleGetImage` on a non-image message ID throws; on a valid image with a missing file returns `{ file_available: false, ocr_text, error }`
  - _Requirements: 3.2, 3.3, 3.4_
  - _Depends: 2.1_
  - _Boundary: image-handlers.ts handleGetImage_

- [ ] 3. CLI get_image subcommand
- [x] 3.1 Add get_image dispatch and usage to CLI
  - In `src/cli.ts`, add `case 'get_image':` to the dispatch switch; parse `<message_id>` using `parseInt(query, 10)` with a NaN-guard matching the existing `messages`/`summary` pattern
  - Print `file_path`, `file_available`, `ocr_text`, and a base64 length summary (not the full blob) for a successful result
  - On `file_available: false`, print the `error` string and the retained `ocr_text`
  - Add the subcommand to `getUsageText()` and update `README.md` to document CLI usage and the `file_available` field in the response shape
  - `npm run cli get_image <id>` on a stored image prints file details; on a missing file prints error and OCR text; on a non-image ID or missing arg prints usage and exits non-zero
  - _Requirements: 3.5, 3.6_
  - _Depends: 2.2_
  - _Boundary: cli.ts dispatch, README.md_

- [ ] 4. Test coverage
- [x] 4.1 Unit tests for handler contract and search models
  - `handleGetImage` returns `GetImageResultAvailable` with `content_base64` and `ocr_text` when the file exists (Req 3.1 regression, 3.3)
  - `handleGetImage` returns `file_available: false` with `file_path`, `ocr_text`, and `error` when `media_file_path` is null and when file read returns ENOENT (Req 3.2, 3.3)
  - `handleGetImage` throws a type-not-supported error for a non-image message (Req 3.4)
  - `searchMessages` includes `type` on each result row; an image message matched via OCR text returns `type: 'image'` (Req 4.3, 4.1 regression)
  - Semantic search result includes `type` for an image-derived match (Req 4.3, 4.2 regression)
  - All listed unit tests pass
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3_
  - _Depends: 2.2_

- [x] 4.2 Integration and regression tests
  - CLI `get_image <id>` prints correct fields for a stored image, prints error and ocr_text for a missing file, and exits non-zero with usage for a non-image or missing ID (Req 3.5)
  - MCP `search_messages` and `semantic_search_messages` responses include `type` end-to-end with no changes to `mcp.ts` (JSON.stringify passthrough confirmed) (Req 4.3)
  - MCP `get_image` tool serializes the discriminated union correctly for both the available and unavailable arms
  - Existing tests asserting `SearchResult`, `SemanticMessageResult`, and `GetImageResult` shapes updated to include the added fields; full test suite passes
  - _Requirements: 3.5, 4.3_
  - _Depends: 1.1, 1.2, 3.1_

- [x]* 4.3 Regression smoke-test for existing infrastructure requirements
  - Confirm Telegram backfill, incremental, and live-listener paths download and store images, run OCR non-fatally, update FTS and embeddings, and isolate files per account
  - Confirm schema migration applies cleanly to a pre-existing database without data loss
  - Confirm Docker config excludes media dir from build context and declares it as a volume
  - Full suite passes covering requirements confirmed as already implemented by the gap analysis
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 4.1, 4.2, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Depends: 4.2_
