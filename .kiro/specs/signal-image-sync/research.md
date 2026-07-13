# Gap Analysis: signal-image-sync

_Generated: 2026-07-12_

---

## Executive Summary

- **Scope**: Add `src/platforms/signal/image-sync.ts`, update `mapMessage` to classify IMAGE messages, and wire image-sync into both `runBackfillImpl` and `runIncrementalImpl`.
- **Template available**: `src/platforms/telegram/image-sync.ts` is an almost exact structural template; the only novel work is attachment fetching.
- **Key open gap**: How to get the image binary from a `BeeperMessage`. Two viable paths exist via the Beeper API (`assets.serve()`) and a local filesystem fallback (`srcURL` as `file://` path). Neither path has been exercised in this codebase before.
- **No schema changes**: All required DB columns (`media_file_path`, `media_url`, `media_width`, `media_height`, `ocr_text`) already exist. `updateMessageMedia` and `getMessageIdByExternalId` are ready to use.
- **`get_image` compatibility**: `handleGetImage` is fully platform-agnostic; it reads `media_file_path` regardless of which adapter wrote it. Zero changes needed there.

---

## Existing Codebase Inventory

### Reusable as-is

| Module | Location | Relevance |
|---|---|---|
| `storeMedia` | `src/media-storage.ts` | Path convention + write; platform is just a string |
| `mediaPathFor` | `src/media-storage.ts` | Idempotency check (`media_file_path` already set) |
| `extractText` | `src/ocr.ts` | Never-throw OCR; singleton tesseract worker |
| `handleGetImage` | `src/image-handlers.ts` | Already works for any platform; no changes needed |
| `updateMessageMedia` | `src/db.ts` | Persists `media_file_path`, dimensions, `ocr_text` |
| `getMessageIdByExternalId` | `src/db.ts` | Looks up DB row from (chatId, externalId) |
| `processImageMessages` pattern | `src/platforms/telegram/image-sync.ts` | Structural template for the new module |

### Requires modification

| Module | Location | Change needed |
|---|---|---|
| `mapMessage` | `src/platforms/signal/sync.ts:31` | Currently maps `type === 'IMAGE'` to `'other'`. Must map it to `'image'` so `handleGetImage` accepts it. |
| `runBackfillImpl` | `src/platforms/signal/sync.ts:52` | Must call image-sync after inserting messages per chat. |
| `runIncrementalImpl` | `src/platforms/signal/sync.ts:77` | Same as above. |
| `BeeperSignalClient` interface | `src/platforms/signal/client.ts` | May need an `fetchAttachmentBuffer(url: string): Promise<Buffer \| null>` method to expose `beeper.assets.serve()` without leaking the `BeeperDesktop` instance. |

### Does not exist yet

| Module | What to create |
|---|---|
| `src/platforms/signal/image-sync.ts` | Signal-specific download logic; calls shared infrastructure |

---

## Critical Gap: Attachment Fetching

This is the only novel implementation work. The Beeper `@beeper/desktop-api` SDK exposes two relevant mechanisms:

### Option A: `beeper.assets.serve({ url })`

```
GET /v1/assets/serve?url=<mxc_or_localmxc_or_file_url>
Response: application/octet-stream (binary)
```

- `BeeperMessage.attachments[0].id` is documented as "typically an mxc:// URL; use the download file endpoint to get a local file path."
- `BeeperMessage.attachments[0].srcURL` is documented as "Public URL or local file path to fetch the file. May be temporary or local-only to this device."
- The `serve` endpoint accepts `mxc://`, `localmxc://`, and `file://` URLs. It streams the raw bytes and returns a `Response` object.
- To convert to `Buffer`: `Buffer.from(await response.arrayBuffer())`
- The `beeper` instance inside `createBeeperSignalClient` is currently private. To expose this without leaking the SDK type, add a method to `BeeperSignalClient`:

```typescript
fetchAttachmentBuffer(url: string): Promise<Buffer | null>
```

This wraps `beeper.assets.serve()` and returns `null` on failure, keeping error isolation at the client boundary.

**Risk**: `assets.serve()` downloads on demand if not cached. For Signal, attachments may have expired or been purged from Beeper's cache if the message is old. This is mitigated by the filesystem fallback.

### Option B: Local filesystem fallback

When `BeeperMessage.attachments[0].srcURL` is a `file://` URL pointing to an already-decrypted Signal attachment on disk, read it directly with `fs.readFileSync`. On macOS, Signal Desktop stores decrypted attachments under:

```
~/Library/Application Support/Signal/attachments.noindex/<subdirectory>/<filename>
```

Beeper bridges Signal via its own local matrix bridge; it may expose the local Signal attachment path as `srcURL` directly. If `srcURL` starts with `file://`, strip the scheme and read the path. If that fails, fall back to `assets.serve()` — or try `assets.serve()` first, filesystem second.

**Risk**: The actual format of `srcURL` for Signal messages routed through Beeper Desktop is not confirmed in this codebase. This is the primary design-time unknown.

### Option C: `beeper.assets.download({ url })`

```
POST /v1/assets/download { url: mxc_url }
Response: { srcURL?: string } — a local file:// URL
```

This tells Beeper to download the file to its local cache and returns the path. Then read the file from disk. This is a two-step approach vs. `assets.serve()` which streams directly.

**Recommendation**: Primary strategy = `assets.serve(url)` where `url` is `attachments[0].srcURL ?? attachments[0].id`. Fallback = if `srcURL` is already a `file://` URL, try reading it directly from disk before calling `assets.serve()` (avoids a network round-trip to Beeper).

---

## Image Detection Logic

From the Beeper API types:

```typescript
// BeeperMessage.type values include:
'TEXT' | 'NOTICE' | 'IMAGE' | 'VIDEO' | 'VOICE' | 'AUDIO' | 'FILE' | 'STICKER' | 'LOCATION' | 'REACTION'

// BeeperMessage.attachments[].type values:
'unknown' | 'img' | 'video' | 'audio'
```

An image message is identified by `m.type === 'IMAGE'` AND `m.attachments?.some(a => a.type === 'img')`. Using both guards is more robust than type alone, because `type === 'IMAGE'` without a usable attachment (no `id` or `srcURL`) should be skipped.

The `mapMessage` update is: if `m.type === 'IMAGE'` then emit `type: 'image'`, else if `m.type === 'TEXT' && Boolean(m.text)` then `'text'`, else `'other'`.

---

## Dimensions

`BeeperMessage.attachments[0].size?.width` and `.height` are available. These map directly to `media_width` and `media_height`. No parsing needed (unlike Telegram where photo sizes had to be inspected for the largest candidate).

---

## Integration Points in the Sync Loop

Two strategies exist for invoking image-sync:

### Strategy 1: Per-chat, inline (matches Telegram pattern)

In `runBackfillImpl` and `runIncrementalImpl`, after inserting messages for a chat, collect the image messages that were just inserted and call `processSignalImageMessages(client, chatId, imageMsgs)`. This gives early feedback and limits memory usage.

**Advantage**: Matches telegram pattern; image sync runs as part of the normal sync loop; no separate pass needed.
**Disadvantage**: The sync loop already has error isolation per chat for text messages; adding image-sync here mixes concerns slightly.

### Strategy 2: Post-sync pass

After all text sync completes, query the DB for all signal messages with `type = 'image' AND media_file_path IS NULL`, then process them. This is how a standalone re-run would work.

**Advantage**: Clean separation; image-sync can be retried independently.
**Disadvantage**: Requires an extra DB query; defers image sync until after all chats are processed.

**Recommendation**: Strategy 1 (per-chat inline) to match the existing telegram pattern. The sync runner already handles per-chat error isolation.

---

## Sync Reporting (Req 6.4)

`runBackfillImpl` and `runIncrementalImpl` currently log a summary count. The image-sync pass must report `imagesStored` and `imagesFailed` counts back up to be included in that summary line.

The `processSignalImageMessages` function should return `{ stored: number; failed: number }` rather than `void` (unlike `processImageMessages` in Telegram which returns `void`).

---

## Test Coverage Gaps

Existing tests (`tests/signal.test.ts`) cover text sync only. The following new test scenarios are needed:

1. `mapMessage` for `type === 'IMAGE'` now returns `type: 'image'` (not `'other'`)
2. `processSignalImageMessages`: image already processed (skipped), Beeper fetch success, Beeper fetch fails + filesystem fallback succeeds, both strategies fail (logged + continued), OCR failure (continues), returns correct `{ stored, failed }` counts
3. `runBackfillImpl` / `runIncrementalImpl` integration: image messages trigger image-sync; counts are reported in summary; text-only messages are unaffected

The test pattern from `tests/telegram-image-sync.test.ts` (mocking `media-storage` and `ocr`, using `:memory:` DB) is directly applicable.

---

## Summary of What Needs to Be Built

| Item | Effort | Risk |
|---|---|---|
| `src/platforms/signal/image-sync.ts` (new) | Medium | Low — template exists |
| `mapMessage` patch: IMAGE => 'image' | Trivial | Low |
| `BeeperSignalClient.fetchAttachmentBuffer()` | Small | Medium — `assets.serve()` behavior for Signal attachments is not yet tested |
| Wire image-sync into `runBackfillImpl` + `runIncrementalImpl` | Small | Low |
| Tests for all of the above | Medium | Low |
| Local filesystem fallback implementation | Small | Medium — `srcURL` format for Signal/Beeper attachments is an open unknown |

**Total scope**: 1 new file (~120 lines), 2 modified files, test file (~150 lines). Strongly shaped by the Telegram precedent. The only genuine design-time unknown is the attachment URL format served by Beeper for Signal messages.

---

## Recommendations for Design Phase

1. **Confirm `srcURL` format**: Document the two fallback branches (mxc:// vs file://) and their detection logic. The design must be explicit about which is tried first.
2. **Expose `fetchAttachmentBuffer` on the client interface**: Keep `BeeperDesktop` instance private; the test double for `BeeperSignalClient` can mock this method without importing the SDK.
3. **Return `{ stored, failed }` from `processSignalImageMessages`**: Enables Req 6.4 reporting without global mutable state.
4. **mapMessage IMAGE => 'image'**: This is a behaviour change to an existing function with tests; update the existing test case that asserts `type === 'other'` for IMAGE messages.

---

## Design Synthesis (2026-07-12)

_Recorded during `/kiro-spec-design`. Confirms discovery against actual source and SDK type definitions._

### Confirmed facts (verified against source, not inferred)

- `Attachment` (`node_modules/@beeper/desktop-api/resources/shared.d.ts:2`): `type: 'unknown' | 'img' | 'video' | 'audio'`; optional `id` (mxc:// identifier), `srcURL` ("Public URL or local file path... may be temporary or local-only"), `size.{width,height}`, `mimeType`, `fileName`.
- `beeper.assets.serve({ url })` (`resources/assets.d.ts:34`): accepts `mxc://`, `localmxc://`, or `file://`; "Downloads first if not cached"; returns `APIPromise<Response>`. Buffer via `Buffer.from(await response.arrayBuffer())`.
- Telegram wiring pattern (`src/platforms/telegram/sync.ts:180,187`): image messages are collected into a per-chat `imageMsgs` array during the insert loop, then `processImageMessages(client, chatId, imageMsgs)` runs once per chat after insertion. Signal mirrors this.
- Shared infra is platform-agnostic: `storeMedia`/`mediaPathFor` (`src/media-storage.ts`) take `platform` as a plain string; `extractText` (`src/ocr.ts`) never throws; `updateMessageMedia`/`getMessageIdByExternalId` (`src/db.ts:209,218`) are ready; `handleGetImage` (`src/image-handlers.ts:34`) reads `media_file_path` regardless of writer. Zero changes needed to any of these.

### Design decisions (finalized)

1. **Fetch order follows requirements, not the micro-optimization.** Req 2.1/2.2 mandate Beeper Desktop first, local filesystem fallback second. The design orders `assets.serve()` (via `fetchAttachmentBuffer`) first, then a `file://` disk read second. The gap-analysis note about reading `file://` first to skip a round-trip is rejected to keep traceability to 2.1/2.2 clean and behavior deterministic.
2. **`fetchAttachmentBuffer(url)` on `BeeperSignalClient`** wraps `assets.serve` and returns `Buffer | null`, isolating both the SDK type and network errors at the client boundary. The test double mocks this method without importing the SDK.
3. **`processSignalImageMessages` returns `{ stored: number; failed: number }`** (unlike Telegram's `void`) to satisfy Req 6.4 reporting without global mutable state.
4. **`failed` counts only fetch-attempted messages.** An `IMAGE` message with no usable `img` attachment (no `srcURL` and no `id`) is skipped-and-logged, not counted as `failed`. `failed` means "had a fetchable reference but both strategies failed."
5. **File extension derived from `mimeType`** with a small map (`image/png`=>`png`, `image/gif`=>`gif`, `image/webp`=>`webp`, default `jpg`). Deterministic per message, keeping `mediaPathFor` idempotency stable.
6. **Idempotency reuses the Telegram guard**: skip when the DB row already has `media_file_path` (Req 1.3, 3.3); skip OCR when `ocr_text` already present (Req 4.4). `storeMedia` overwrites idempotently on a deterministic path, so a partial prior run is safe to re-run.
7. **Primary design-time unknown remains** the concrete `srcURL` scheme Beeper emits for Signal attachments (`mxc://` vs `file://`). The two-strategy fetch is specifically structured so either scheme resolves: `serve()` handles all three schemes; the disk fallback handles the `file://` case when `serve()` is unavailable (e.g., Beeper down).

---

## Implementation-State Gap Analysis (2026-07-13)

_Run after design and tasks were approved; most code is already written._

### What Is Already Complete

| Item | File | Verified |
|------|------|---------|
| `processSignalImageMessages` + helpers (`extFromMime`, `pickImageAttachment`, `fetchSignalAttachment`) | `src/platforms/signal/image-sync.ts` | Full implementation present |
| `AttachmentFetcher` interface + `createSignalAttachmentFetcher` (Beeper `assets.serve` wrapper) | `src/platforms/signal/image-sync.ts` | Present; uses separate interface, not `BeeperSignalClient` |
| `mapMessage` IMAGE => `'image'` classification | `src/platforms/signal/sync.ts:33` | Done; test at `signal.test.ts:129` verifies |
| Unit tests (`extFromMime`, `pickImageAttachment`) | `tests/signal-image-sync.test.ts` | 14 cases |
| Integration tests (`processSignalImageMessages`) | `tests/signal-image-sync.test.ts` | Covers all skip, fetch, fallback, OCR, and failure paths |
| `createSignalAttachmentFetcher` tests | `tests/signal-client-attachment.test.ts` | 5 cases |
| E2E tests (runBackfillImpl + handleGetImage + FTS) | `tests/signal-image-e2e.test.ts` | Present (see gap below) |

### What Is Missing

**Gap 1 — Sync-loop wiring (Task 3.1 incomplete)**

`runBackfillImpl` and `runIncrementalImpl` in `src/platforms/signal/sync.ts` do NOT:
- Collect image `BeeperMessage`s into a per-chat array during the insert loop
- Call `processSignalImageMessages` after each chat's inserts
- Accumulate or log `{ stored, failed }` counts

The completion log currently emits only `[signal] Sync complete: N chats, M messages`. Req 6.4 requires `images: N stored, M failed` appended.

**Gap 2 — Interface mismatch for wiring**

The design specified adding `fetchAttachmentBuffer` to `BeeperSignalClient` so the existing `client` parameter could be passed directly to `processSignalImageMessages`. The actual implementation places `fetchAttachmentBuffer` in a separate `AttachmentFetcher` interface (in `image-sync.ts`). As a result, `runBackfillImpl(client, ...)` cannot pass `client` to `processSignalImageMessages` — the wiring needs either:

- **Option B (recommended)**: Add an optional `fetcher?: AttachmentFetcher` parameter to `runBackfillImpl` / `runIncrementalImpl`. `createSignalAdapter` constructs `createSignalAttachmentFetcher(token)` and passes it. Zero changes to `image-sync.ts` or `client.ts`.
- **Option A (original design)**: Add `fetchAttachmentBuffer` to `BeeperSignalClient` in `client.ts`; change `processSignalImageMessages`'s first parameter type; remove `createSignalAttachmentFetcher`. More refactoring, breaks current tests for `createSignalAttachmentFetcher`.

**Gap 3 — E2E test does not verify wiring**

`tests/signal-image-e2e.test.ts` mocks `processSignalImageMessages` entirely, so the test passes regardless of whether `runBackfillImpl` actually calls it. After wiring is added:
- The mock should be updated (or removed) so the test uses a real `AttachmentFetcher` mock
- The log assertion should check for `images:` counts

### Recommended Implementation Path

1. In `sync.ts`, add `fetcher?: AttachmentFetcher` to `runBackfillImpl` and `runIncrementalImpl`.
2. In the per-chat insert loop, collect raw `BeeperMessage`s where the mapped type is `'image'` into a `imageMsgs` array.
3. After the insert loop, if `fetcher` present: call `processSignalImageMessages(fetcher, chatId, imageMsgs)` and accumulate `stored`/`failed`.
4. Extend the completion log: `images: ${totalStored} stored, ${totalFailed} failed`.
5. In `createSignalAdapter`, pass `createSignalAttachmentFetcher(token)` when calling `runBackfillImpl`/`runIncrementalImpl`.
6. Update `signal-image-e2e.test.ts` to pass a mock fetcher and assert the image counts in the log.

### Effort and Risk

| Dimension | Rating | Justification |
|-----------|--------|---------------|
| Effort | **S** (half-day) | Two loop extensions + one log line + one test update; all logic exists |
| Risk | **Low** | `processSignalImageMessages` never throws; no schema changes; pattern mirrors existing code |
