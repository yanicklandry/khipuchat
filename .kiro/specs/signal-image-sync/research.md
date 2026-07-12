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
