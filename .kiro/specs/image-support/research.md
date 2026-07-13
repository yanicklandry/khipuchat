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

---

## Design Discovery & Synthesis

_Date: 2026-07-12 — appended during `/kiro-spec-design`_

### Discovery Scope
Extension (brownfield). Light, integration-focused discovery. Source files read to specify the four gaps precisely: `src/image-handlers.ts`, `src/db.ts`, `src/cli.ts`, `src/mcp.ts`, `src/query-handlers.ts`, `src/vec-db.ts`. No external research required — no new dependencies.

### Synthesis Outcomes

**Generalization**: The four gaps collapse into two shared themes rather than four independent fixes:
- **Theme A — surface `type` in read models**: Gap 2 (`SearchResult`) and Gap 3 (`handleGetImage` type validation) both stem from the same root: the `messages.type` column exists but is not selected into the read model. Fixing both means adding `m.type` to the relevant SELECTs.
- **Theme B — `get_image` structured partial result**: Gap 4 (preserve `ocr_text` when file missing) plus Req 3.2 (informative unavailability indication) require `handleGetImage` to return a discriminated result rather than always throwing.

**Build vs. Adopt**: No new components or libraries. All work is edits to existing files using in-place patterns (`better-sqlite3` prepared statements, existing CLI `switch` structure, existing MCP JSON passthrough). Adopt existing conventions.

**Simplification**: No new files, no new abstraction layers. The only new type shape is the `GetImageResult` discriminated union. Keep everything else as targeted edits.

### New Finding Beyond Gap Analysis (Req 4.3 scope correction)

The gap analysis scoped the missing `type` field (Req 4.3) to `SearchResult` only. However, `SemanticMessageResult` (`src/vec-db.ts:19`) also omits `type`, and Req 4.2 guarantees image messages are returned by `semantic_search_messages` with no default filtering. Req 4.3 states generically that "a search result corresponding to a message of type `'image'`" must include the message type so callers can distinguish it. Therefore full Req 4.3 coverage requires adding `type` to **both** `SearchResult` and `SemanticMessageResult` (and their SELECTs). This design corrects the gap analysis under-scope.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Targeted in-place edits (chosen) | Modify existing handlers/queries only | Minimal surface, no migration, preserves existing patterns | Requires touching read-model types shared across MCP/CLI | Aligns with brownfield gap-closure scope |
| New image-query module | Extract image retrieval into a dedicated service layer | Cleaner separation | Over-engineering for 4 localized gaps; new indirection with single caller | Rejected by Simplification lens |

## Design Decisions

### Decision: `get_image` returns a discriminated `GetImageResult` (Gap 4 / Req 3.2, 3.3)
- **Context**: Req 3.2 requires an informative unavailability indication when the file is missing; Req 3.3 requires `ocr_text` still be returned in that case. A thrown `Error` string cannot carry `ocr_text`.
- **Alternatives Considered**:
  1. Option A — partial result object with `file_available: false` and `ocr_text` retained.
  2. Option B — custom `Error` subclass carrying `ocr_text` (callers must `instanceof`-check).
- **Selected Approach**: Option A. `GetImageResult` becomes a union discriminated on `file_available`. When the message is an image but the file is absent (never downloaded, or `ENOENT` on read), return `{ file_available: false, error, ocr_text, ... }`. When present, return `{ file_available: true, file_path, content_base64, ocr_text }`.
- **Rationale**: Structured data flows cleanly to both MCP (JSON) and CLI consumers; agent-native (a caller reasoning over the result sees `ocr_text` even when the binary is gone). Consistent with the existing sync-friendly return type.
- **Trade-offs**: MCP/CLI callers check `file_available` instead of catching. Acceptable and explicit.
- **Boundary of throwing vs returning**: Hard errors still throw — message-not-found (bad ID) and non-image type (Req 3.4, wrong tool). These have no `ocr_text` to preserve and represent caller error, not partial availability. Only the image-file-unavailable case returns the partial object.

### Decision: Add `type` to both search read models (Req 4.3)
- **Context**: See "New Finding" above.
- **Selected Approach**: Add `type: MessageType` to `SearchResult` and `SemanticMessageResult`; add `m.type` to `searchMessages` SQL and the semantic result assembly in `vec-db.ts`.
- **Rationale**: Full Req 4.3 coverage across both search surfaces the requirement's objective targets.
- **Trade-offs**: Slightly wider blast radius than the gap analysis anticipated (one extra file, `vec-db.ts`), but required for correctness.

## Risks & Mitigations
- **Read-model type change ripples to callers/tests** — `SearchResult`/`SemanticMessageResult` are consumed by MCP, CLI, and tests. Mitigation: `type` is additive (new required field on internal interfaces); update the SELECTs and the test fixtures/assertions in the same task.
- **CLI `get_image` output for base64** — printing full base64 to a terminal is noisy. Mitigation: CLI prints `file_path`, `ocr_text`, `file_available`, and a base64 length/summary rather than the full blob (full content still available via MCP).
- **Signal image sync (deferred)** — out of scope this wave; only research findings are recorded (below). No implementation risk this spec.

## Signal Image Sync — Deferred Research Note
Per the requirements Boundary Context, Signal ingestion is deferred to a follow-on spec. Findings retained for that spec: Signal media in KhipuChat arrives via the Beeper Desktop bridge (not native Signal protocol), so image retrieval would follow the same `storeMedia()` / `processImageMessages()` shared convention already built for Telegram; the open question for the follow-on spec is how Beeper exposes Signal attachment blobs/URLs versus GramJS's `downloadMedia()`. No implementation in this spec.

## References
- `src/image-handlers.ts`, `src/db.ts`, `src/cli.ts`, `src/mcp.ts`, `src/query-handlers.ts`, `src/vec-db.ts` — source of truth for gap specification.
- Requirements Boundary Context (`requirements.md`) — Signal deferral, multi-account path isolation assumption.

---

# Gap Re-validation: image-support

_Date: 2026-07-13_

## Analysis Summary

- **Scope**: Re-validation of implementation completeness against requirements, post all four design-phase gaps being closed.
- **Codebase status**: All four gaps identified in the previous analysis are now implemented. No new gaps found.
- **Outcome**: The feature is fully implemented. All requirements from Wave 1 are covered.
- **Recommendation**: Proceed to `/kiro-validate-impl image-support` for final integration validation.

---

## Gap Closure Verification

All four gaps from the 2026-07-12 analysis are now resolved:

| Previous Gap | Requirement | Resolution Verified |
|---|---|---|
| Gap 1: CLI `get_image` | Req 3.5 | `src/cli.ts:248` dispatches `case 'get_image'`, prints `file_path`, `file_available`, `ocr_text`, base64 length; `getUsageText()` documents it |
| Gap 2: `SearchResult.type` | Req 4.3 | `src/db.ts:54` has `type: MessageType` on `SearchResult`; `searchMessages` SELECT includes `m.type` at line 253 |
| Gap 3: `handleGetImage` type validation | Req 3.4 | `src/image-handlers.ts:40` checks `row.type !== 'image'` before any path access and throws with message naming the actual type |
| Gap 4: `ocr_text` preserved on file-unavailable | Req 3.3 | `src/image-handlers.ts` returns `GetImageResultUnavailable` with `ocr_text` retained when `media_file_path` is null or ENOENT |

Additionally: `SemanticMessageResult` in `src/vec-db.ts` includes `type: MessageType` at line 28, covering the design-phase extension of Req 4.3 to semantic search.

## Full Requirements Coverage Snapshot

| Req | Description | File | Status |
|---|---|---|---|
| 1.1 | Path convention: `<MEDIA_DIR>/<platform>/<chatId>/<externalId>.<ext>` | `src/media-storage.ts` | Complete |
| 1.2 | `MEDIA_DIR` env var with fallback to `./media` | `src/media-storage.ts:23` | Complete |
| 1.3 | Skip download when `media_file_path` already set | `src/platforms/telegram/image-sync.ts:70` | Complete |
| 1.4 | `media/` in `.gitignore`; `media-data` volume in `docker-compose.yml` | Root files | Complete |
| 1.5 | `ocr_text`, `media_*` columns added via migration guard | `src/db-migrations.ts:72-84` | Complete |
| 2.1 | `extractText()` stores result in `ocr_text` | `src/platforms/telegram/image-sync.ts:102-106` | Complete |
| 2.2 | OCR failures logged; sync continues | `src/ocr.ts:20-28` (never throws) | Complete |
| 2.3 | FTS `messages_fts` includes `ocr_text` column | `src/db-migrations.ts:14` | Complete |
| 2.4 | Embedding input concatenates `text + ocr_text` | `src/index-embeddings.ts:29-30` | Complete |
| 2.5 | `media_width`/`media_height` written from photo sizes | `src/platforms/telegram/image-sync.ts:94-98` | Complete |
| 3.1 | `get_image` returns `file_path`, `content_base64`, `ocr_text` | `src/image-handlers.ts` | Complete |
| 3.2 | Unavailable file returns informative error | `src/image-handlers.ts:43-51, 58-70` | Complete |
| 3.3 | `ocr_text` included in unavailability response | `src/image-handlers.ts:48, 66` | Complete |
| 3.4 | Non-image message type error | `src/image-handlers.ts:40` | Complete |
| 3.5 | CLI `get_image` subcommand | `src/cli.ts:248-261` | Complete |
| 3.6 | README documents `get_image` | `README.md:122-142` | Complete |
| 4.1 | FTS search matches `ocr_text` via `messages_fts` | `src/db.ts:252-259` | Complete |
| 4.2 | Semantic search returns image messages (no type filtering) | `src/vec-db.ts` (no type default filter) | Complete |
| 4.3 | `type` field in both `SearchResult` and `SemanticMessageResult` | `src/db.ts:54`, `src/vec-db.ts:28` | Complete |
| 4.4 | `type: 'image'` filter on `search_messages` | `src/db.ts:250`, `src/mcp.ts:85` | Complete |
| 5.1 | Backfill downloads image messages | `src/platforms/telegram/sync.ts:152-187` | Complete |
| 5.2 | Incremental sync downloads image messages | `src/platforms/telegram/sync.ts:252-287` | Complete |
| 5.3 | Live listener downloads image messages | `src/platforms/telegram/sync.ts:210-211` | Complete |
| 5.4 | Per-message try/catch; sync continues on failure | `src/platforms/telegram/image-sync.ts:57, 113` | Complete |
| 5.5 | Account-scoped paths via `chatId` + platform in path | `src/media-storage.ts:25` | Complete |

## No New Gaps Found

The implementation is complete for all Wave 1 requirements. Signal image sync (`src/platforms/signal/image-sync.ts`) is already present as a bonus but was deferred per the boundary context; it does not block this spec.
