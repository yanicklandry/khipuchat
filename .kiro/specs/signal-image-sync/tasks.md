# Implementation Plan

- [ ] 1. Core: message classification and Beeper transport
- [ ] 1.1 (P) Patch Signal message type classification
  - In `mapMessage` within `sync.ts`, change the branch so `m.type === 'IMAGE'` emits `type: 'image'` instead of `'other'`
  - Ensure the fallback branch still maps TEXT with a body to `'text'` and all other types to `'other'`, leaving non-image messages untouched
  - Update any existing test that asserts IMAGE → 'other' to assert IMAGE → 'image'
  - Observable: the existing test suite passes with IMAGE messages now classified as `type: 'image'`
  - _Requirements: 1.1, 1.2, 5.2, 5.3_
  - _Boundary: SignalAdapter/Mapping (sync.ts)_

- [ ] 1.2 (P) Add attachment fetch method to the Signal client
  - Add `fetchAttachmentBuffer(url: string): Promise<Buffer | null>` to the `BeeperSignalClient` interface in `client.ts`
  - Implement by calling `beeper.assets.serve({ url })`, reading the response into a `Buffer`, and returning `null` on any error or empty/zero-length body
  - Wrap the implementation in try/catch; log a warning on failure; never throw to the caller
  - Observable: calling the method with a recognized Beeper URL returns a non-null `Buffer`; an invalid or unavailable URL returns `null` without throwing
  - _Requirements: 2.1, 2.4_
  - _Boundary: SignalAdapter/Transport (client.ts)_

- [ ] 2. Core: image sync orchestration module
- [ ] 2.1 Implement `processSignalImageMessages` and its private helpers
  - Create `src/platforms/signal/image-sync.ts`
  - Implement `extFromMime`: `image/png` → `'png'`, `image/gif` → `'gif'`, `image/webp` → `'webp'`, anything else → `'jpg'`
  - Implement `pickImageAttachment`: return the first attachment whose type is `'img'` and that has a non-empty `srcURL` or `id`; return `null` if none qualify
  - Implement `fetchSignalAttachment`: try `client.fetchAttachmentBuffer(srcURL ?? id)` first; if it returns `null` and `srcURL` starts with `file://`, strip the scheme and read the file from disk with `fs`; return `null` and count the message as failed if both strategies yield nothing or throw
  - Implement the main per-message loop: resolve DB id via `getMessageIdByExternalId`; skip (uncounted) if missing or if `media_file_path` already set; pick attachment; fetch; call `storeMedia` with platform `'signal'`, chatId, externalId, extension, and buffer; read dimensions from `att.size`; call `extractText` only if `ocr_text` not already set; call `updateMessageMedia`; increment `stored`
  - Wrap each message's work in try/catch so any throw increments `failed` and continues the loop; the function always resolves with `{ stored, failed }` and never rejects
  - Observable: given one image message where Beeper returns a buffer, the function returns `{ stored: 1, failed: 0 }` and the database row has `media_file_path` and `ocr_text` populated
  - _Requirements: 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 6.4_
  - _Depends: 1.2_
  - _Boundary: SignalAdapter/ImageSync (image-sync.ts)_

- [ ] 3. Integration: wire image sync into sync runs
- [ ] 3.1 Collect image messages per chat and invoke image sync after inserts
  - In `runBackfillImpl` and `runIncrementalImpl` in `sync.ts`, collect each raw `BeeperMessage` that maps to `type: 'image'` into a per-chat array during the insert loop, without changing the insert behavior
  - After each chat's insert loop, call `processSignalImageMessages(client, chatId, imageMsgs)` and accumulate the returned `stored` and `failed` counts into run-level totals
  - Extend the existing completion log line to append `images: N stored, M failed`
  - Image sync is called after inserts so text rows are durable before any image work begins
  - Observable: a sync run over a chat with one text and one image message inserts both rows, then the completion log line includes `images: 1 stored, 0 failed` (or a failure count) confirming image sync ran
  - _Requirements: 6.3, 6.4_
  - _Depends: 1.1, 2.1_
  - _Boundary: SignalAdapter/Runtime (sync.ts)_

- [ ] 4. Validation: tests
- [ ] 4.1 (P) Unit tests for image-sync helper functions
  - Test `extFromMime`: `image/png` → `'png'`, `image/gif` → `'gif'`, `image/webp` → `'webp'`, `image/jpeg` → `'jpg'`, `undefined` → `'jpg'`
  - Test `pickImageAttachment`: returns the first `img` attachment with `srcURL`; returns `null` when no attachment has `srcURL` or `id`; returns `null` when only non-`img` type attachments are present
  - Observable: all helper unit test cases pass
  - _Requirements: 1.1, 1.2_
  - _Depends: 2.1_
  - _Boundary: SignalAdapter/ImageSync_

- [ ] 4.2 (P) Integration tests for `processSignalImageMessages`
  - Use an in-memory SQLite DB with mocked `media-storage` and `ocr`, following the pattern in `tests/telegram-image-sync.test.ts`
  - Case: message with `media_file_path` already set → skipped, no fetch called, counted in neither stored nor failed
  - Case: Beeper fetch returns buffer → `stored: 1, failed: 0`; `media_file_path` and `ocr_text` populated on DB row
  - Case: Beeper returns null, `srcURL` is `file://`, disk read succeeds → `stored: 1, failed: 0`
  - Case: both strategies fail → `stored: 0, failed: 1`; loop continues and remaining messages are processed
  - Case: OCR returns null → image still stored and counted as `stored`; `ocr_text` remains null
  - Case: `ocr_text` already set → `extractText` is not called; image is still counted correctly
  - Observable: all six integration test cases pass
  - _Requirements: 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.4_
  - _Depends: 2.1_
  - _Boundary: SignalAdapter/ImageSync_

- [ ] 4.3 E2E tests: sync run counts and retrieval parity
  - Test `runBackfillImpl` with a mixed chat (one text + one image message): verify both rows are inserted, image sync is triggered, the completion log includes `images: 1 stored, 0 failed`, and text rows are intact even when image fetch fails
  - Test that after a successful image store, calling `handleGetImage(messageId)` returns `file_available: true`, confirming `get_image` MCP tool parity requires no code changes
  - Test that stored OCR text appears in existing FTS query results, confirming searchability requires no FTS pipeline changes
  - Observable: all three E2E test cases pass with no modifications to `get_image`, FTS, or semantic search code
  - _Requirements: 5.1, 5.2, 5.3, 6.3, 6.4_
  - _Depends: 3.1_
  - _Boundary: SignalAdapter/Runtime, SharedInfra_
