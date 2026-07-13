# Implementation Plan

- [x] 1. Core: message classification and Beeper transport
- [x] 1.1 (P) Patch Signal message type classification
  - In `mapMessage` within `sync.ts`, change the branch so `m.type === 'IMAGE'` emits `type: 'image'` instead of `'other'`
  - Ensure the fallback branch still maps TEXT with a body to `'text'` and all other types to `'other'`, leaving non-image messages untouched
  - Update any existing test that asserts IMAGE => 'other' to assert IMAGE => 'image'
  - Observable: the existing test suite passes with IMAGE messages now classified as `type: 'image'`
  - _Requirements: 1.1, 1.2, 5.2, 5.3_
  - _Boundary: SignalAdapter/Mapping (sync.ts)_

- [x] 1.2 (P) Implement AttachmentFetcher interface and factory in the new image-sync module
  - Create `src/platforms/signal/image-sync.ts` and declare the `AttachmentFetcher` interface: `fetchAttachmentBuffer(url: string): Promise<Buffer | null>`
  - Implement `createSignalAttachmentFetcher(accessToken: string): AttachmentFetcher` which privately constructs a `BeeperDesktop` instance and wraps `assets.serve({ url })` in try/catch, returning `null` on any error or empty/zero-length body
  - Log a warning on failure; never throw to the caller; the `BeeperDesktop` instance stays private to the factory closure; `client.ts` is not modified
  - Observable: calling the factory returns an object whose `fetchAttachmentBuffer` resolves to a non-null `Buffer` for a valid Beeper URL and `null` for an unavailable one, without throwing
  - _Requirements: 2.1, 2.4_
  - _Boundary: SignalAdapter/Transport (image-sync.ts)_

- [x] 2. Core: image sync orchestration
- [x] 2.1 Implement `processSignalImageMessages` and its private helpers
  - Add to `image-sync.ts`: `extFromMime` mapping `image/png` => `'png'`, `image/gif` => `'gif'`, `image/webp` => `'webp'`, anything else => `'jpg'`
  - Add `pickImageAttachment`: return the first attachment with `type === 'img'` and a non-empty `srcURL` or `id`; return `null` if none qualify
  - Add `fetchSignalAttachment`: try `fetcher.fetchAttachmentBuffer(srcURL ?? id)` first; if null and `srcURL` starts with `file://`, strip the scheme and read from disk with `fs`; return `null` if both strategies fail or throw
  - Implement the per-message loop in `processSignalImageMessages`: resolve DB id via `getMessageIdByExternalId`; skip (uncounted) if missing or `media_file_path` already set; pick attachment; fetch; call `storeMedia` with platform `'signal'`, chatId, externalId, extension, buffer; read dimensions from `att.size`; call `extractText` only if `ocr_text` is not already set; call `updateMessageMedia`; increment `stored`
  - Wrap each message's work in try/catch so any throw increments `failed` and continues the loop; the function always resolves with `{ stored, failed }` and never rejects
  - Observable: given one image message where Beeper returns a buffer, `processSignalImageMessages` returns `{ stored: 1, failed: 0 }` and the DB row has `media_file_path` and `ocr_text` populated
  - _Requirements: 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 6.4_
  - _Depends: 1.2_
  - _Boundary: SignalAdapter/ImageSync (image-sync.ts)_

- [x] 3. Integration: wire image sync into sync runs
- [x] 3.1 Collect image messages per chat and invoke image sync after inserts
  - In `runBackfillImpl` and `runIncrementalImpl` in `sync.ts`, collect each raw `BeeperMessage` that maps to `type: 'image'` into a per-chat array during the insert loop, without changing insert behavior
  - After each chat's insert loop, call `processSignalImageMessages(fetcher, chatId, imageMsgs)` and accumulate the returned `stored` and `failed` counts into run-level totals
  - In `createSignalAdapter`, construct `createSignalAttachmentFetcher(token)` and thread it into both run functions as the optional `fetcher` parameter (omitting it skips image work cleanly for tests)
  - Extend the existing completion log line to append `images: N stored, M failed`
  - Observable: a sync run over a chat with one text and one image message inserts both rows, then the completion log includes `images: 1 stored, 0 failed`, and text rows remain intact when image fetch fails
  - _Requirements: 6.3, 6.4_
  - _Depends: 1.1, 2.1_
  - _Boundary: SignalAdapter/Runtime (sync.ts)_

- [x] 4. Validation: tests
- [x] 4.1 (P) Unit tests for image-sync helper functions and mapMessage classification
  - Test `extFromMime`: `image/png` => `'png'`, `image/gif` => `'gif'`, `image/webp` => `'webp'`, `image/jpeg` => `'jpg'`, `undefined` => `'jpg'`
  - Test `pickImageAttachment`: returns first `img` attachment with `srcURL`; returns `null` when no attachment has `srcURL` or `id`; returns `null` when only non-`img` type attachments exist
  - Test updated `mapMessage`: IMAGE => `'image'`; TEXT with body => `'text'`; other types => `'other'`
  - Observable: all helper and classification unit tests pass
  - _Requirements: 1.1, 1.2_
  - _Depends: 1.1, 1.2_
  - _Boundary: SignalAdapter/ImageSync, SignalAdapter/Mapping_

- [x] 4.2 (P) Integration tests for `processSignalImageMessages`
  - Use in-memory SQLite DB with mocked `media-storage` and `ocr`, following `tests/telegram-image-sync.test.ts`
  - Case: `media_file_path` already set => skipped, no fetch called, counted in neither stored nor failed
  - Case: Beeper fetch returns buffer => `stored: 1, failed: 0`; `media_file_path` and `ocr_text` populated on DB row
  - Case: Beeper returns null, `srcURL` is `file://`, disk read succeeds => `stored: 1, failed: 0`
  - Case: both strategies fail => `stored: 0, failed: 1`; loop continues and remaining messages are processed
  - Case: OCR returns null => image still stored and counted as stored; `ocr_text` null
  - Case: `ocr_text` already set => `extractText` is not called
  - Observable: all six integration test cases pass
  - _Requirements: 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.4_
  - _Depends: 2.1_
  - _Boundary: SignalAdapter/ImageSync_

- [x] 4.3 E2E tests: sync run counts and retrieval parity
  - Test `runBackfillImpl` with a mixed chat (one text + one image message): verify both rows inserted, image sync triggered, completion log includes `images: 1 stored, 0 failed`, and text rows intact even when image fetch fails
  - Test that after a successful image store, `handleGetImage(messageId)` returns `file_available: true`, confirming `get_image` MCP tool parity requires no code changes
  - Test that stored OCR text appears in existing FTS query results, confirming searchability requires no FTS pipeline changes
  - Observable: all three E2E test cases pass with no modifications to `get_image`, FTS, or semantic search code
  - _Requirements: 5.1, 5.2, 5.3, 6.3, 6.4_
  - _Depends: 3.1_
  - _Boundary: SignalAdapter/Runtime, SharedInfra_
