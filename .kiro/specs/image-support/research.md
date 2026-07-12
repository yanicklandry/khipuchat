# Gap Analysis: image-support

_Date: 2026-07-12_

## Analysis Summary

- **Scope**: Telegram image sync with shared media/OCR/retrieval infrastructure.
- **Codebase status**: Most infrastructure is already implemented. The `src/media-storage.ts`, `src/ocr.ts`, `src/image-handlers.ts`, and `src/platforms/telegram/image-sync.ts` modules exist and are substantially complete.
- **Key finding**: Four targeted gaps remain before full requirements coverage is achieved. None are architectural blockers; all are small, localized changes.
- **Overall posture**: This is a brownfield integration — the design phase should focus on specifying the four gaps below, not re-describing already-implemented infrastructure.
- **Recommendation**: Proceed to design phase with gap closure as primary scope.

---

## What Is Already Implemented

| Requirement | Area | Status |
|---|---|---|
| Req 1.1-1.3 | `storeMedia()`, `mediaPathFor()`, MEDIA_DIR env, idempotency check | Complete |
| Req 1.4 | `media/` in `.gitignore`, `docker-compose.yml` volume | Complete |
| Req 1.5 | `db-migrations.ts`: `ocr_text`, `media_file_path` columns, FTS recreation guard | Complete |
| Req 2.1-2.2 | `ocr.ts` singleton worker, non-throwing `extractText()` | Complete |
| Req 2.3 | FTS triggers include `ocr_text` in `messages_fts`; rebuild guard in migration | Complete |
| Req 2.4 | `index-embeddings.ts` `buildEmbedInput` joins `text + ocr_text`; `HAS_CONTENT` includes `ocr_text` | Complete |
| Req 2.5 | `image-sync.ts` reads `photo.sizes`, extracts `w`/`h`, writes `media_width`/`media_height` | Complete |
| Req 3.1 | `handleGetImage` returns `file_path`, `content_base64`, `ocr_text` | Complete |
| Req 3.2 | Throws informative error when file not on disk | Complete (but see Gap 4) |
| Req 3.6 | README documents `get_image` tool with parameters and response fields | Complete |
| Req 4.1 | FTS match on `messages_fts` covers `ocr_text` column | Complete |
| Req 4.2 | Semantic search on `vec_messages` covers embeddings built from `ocr_text` | Complete |
| Req 4.4 | `searchMessages` accepts `type` filter, applies `AND m.type = ?` | Complete |
| Req 5.1 | Telegram backfill calls `processImageMessages` per chat | Complete |
| Req 5.2 | Telegram incremental sync calls `processImageMessages` per chat | Complete |
| Req 5.3 | `startListener` calls `processImageMessages` on live photo events | Complete |
| Req 5.4 | `processImageMessages` wraps each message in try/catch, continues on error | Complete |
| Req 5.5 | `storeMedia` path includes `chatId`; combined with platform and multi-account structure | Complete |

---

## Gaps: What Is Missing

### Gap 1: CLI `get_image` Command (Req 3.5)

**File**: `src/cli.ts`
**Requirement**: The `get_image` capability shall be accessible through the CLI query surface.

`handleGetImage` is exported from `src/mcp.ts` and works correctly, but `src/cli.ts` has no `get_image` case in its `switch(tool)` block. The `getUsageText()` function also does not mention it.

**What is needed**:
- Add a `case 'get_image':` to the CLI switch that calls `handleGetImage(messageId)` and prints `file_path`, `content_base64` (or a summary), and `ocr_text`.
- Update `getUsageText()` to document the new subcommand.
- Update the CLI test (`tests/cli.test.ts`) to cover the new case.

---

### Gap 2: `SearchResult` Missing `type` Field (Req 4.3)

**Files**: `src/db.ts` (`SearchResult` interface + `searchMessages` SQL)
**Requirement**: When a search result corresponds to a message of type `'image'`, KhipuChat shall include the message type in the result.

The `SearchResult` interface has no `type` property. The `searchMessages` SQL selects `m.chat_id, c.name AS chat_name, m.sender_name, m.text, m.timestamp, m.platform, c.account` — `m.type` is absent.

Callers (MCP `search_messages`, CLI `search`) currently cannot distinguish image messages from text messages in search results.

**What is needed**:
- Add `type: MessageType` to `SearchResult`.
- Add `m.type` to the `searchMessages` SELECT.
- Update downstream callers and tests accordingly.

---

### Gap 3: `handleGetImage` Does Not Validate Message Type (Req 3.4)

**File**: `src/image-handlers.ts`
**Requirement**: When `get_image` is called for a message that is not of type `'image'`, KhipuChat shall return an error indicating the message type is not supported by this tool.

The current `handleGetImage` queries only `id, media_file_path, ocr_text`. It throws `"image not available: no media_file_path"` for non-image messages, which is misleading.

**What is needed**:
- Expand the SELECT to also fetch `type`.
- Before checking `media_file_path`, check `row.type !== 'image'` and throw a message type error.

---

### Gap 4: `handleGetImage` Suppresses `ocr_text` in File-Not-Found Case (Req 3.3)

**File**: `src/image-handlers.ts`
**Requirement**: When `get_image` is called for a message that has `ocr_text` but no accessible local file, KhipuChat shall include `ocr_text` in the response alongside the unavailability indication.

Currently, when `fs.readFileSync` throws `ENOENT`, the handler throws a plain `Error` string with no `ocr_text`. When `media_file_path` is null (file never downloaded), it also throws without returning `ocr_text`.

Both throw paths discard `ocr_text`, violating Req 3.3.

**Options**:

**Option A**: Return a partial result object (preferred — stays sync-friendly, composable)
- Define `GetImageResult` to allow a partial/error state with `file_available: false` and `ocr_text` still present.
- Return the partial object rather than throwing when the file is missing or inaccessible.
- Pro: Callers get structured data in both success and file-missing paths.
- Con: MCP and CLI callers need to check `file_available` instead of catching.

**Option B**: Throw a structured error class that carries `ocr_text`
- Define `class ImageFileUnavailableError extends Error { ocr_text: string | null }`.
- Pro: Preserves exception-based flow for callers that already catch.
- Con: More boilerplate; callers must `instanceof`-check.

**Recommendation**: Option A (partial result) — consistent with the existing `GetImageResult` return type; cleaner for both MCP and CLI consumers.

---

## External Dependency Assessment

| Dependency | Current state | Notes |
|---|---|---|
| `tesseract.js` | Listed in `package.json` (per tech.md) | Singleton worker pattern implemented; no version issues expected |
| `better-sqlite3` | Already in use | Synchronous; all DB calls in image path stay sync |
| `telegram` (GramJS) | Already in use | `client.downloadMedia()` called in `image-sync.ts` |

No new external dependencies are required for any of the four gaps.

---

## Design Phase Guidance

The design document should:
1. Specify the exact CLI interface for `get_image` (args, output format).
2. Specify the updated `SearchResult` shape and FTS query change.
3. Specify the message-type validation logic in `handleGetImage`.
4. Choose between Option A and Option B for Req 3.3 and specify the result type accordingly.
5. Document Signal image sync research findings as deferred (per requirements boundary context) — no implementation needed.

The existing infrastructure does not need to be redesigned; the design phase is gap-closure specification only.
