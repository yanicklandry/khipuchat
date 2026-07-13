# Research Log

## Summary

This research identifies key implementation details for WeChat image synchronization. The current WeChat adapter handles text messages but lacks image support, requiring extension of the message mapping logic to detect and process image-type messages.

## Key Findings

1. **Current Message Handling**: The existing adapter only maps text messages (type 1 with rawText) and treats all other types as 'other'. For image processing, we need to extend this detection logic.

2. **Schema Analysis**: WeChat uses two database schemas:
   - Legacy (3.x): Uses Chat_XXXX tables with msgSvrID, MesSvrID, CreateTime, Message, strContent, Des, isSend, Type, MsgType fields
   - Modern (4.x): Uses MD5(user_name) tables with server_id, create_time, message_content, WCDB_CT_message_content, real_sender_id, local_type fields

3. **Image Data Storage**: Images are stored as separate files in WeChat's media directory structure. The database contains file paths to these external assets rather than binary data directly.

## Research Log

### 1. Implementation Patterns

**Current Implementation Limitations:**
- Only text messages (type=1 with non-null rawText) are mapped to 'text' type
- All other messages default to 'other' type in `mapMessage()` function
- No specific logic for detecting image or media content types in either schema

**Required Enhancements:**
- Add detection logic for image message types based on WeChat's internal message classification
- Implement extraction of file paths from message_content fields for image handling
- Map detected images to generic 'image' type in the message schema
- Preserve existing functionality for all non-image messages

### 2. Technical Approach

**Schema Detection:**
- Use existing `buildSchemaInfo()` function to determine which schema is present (3.x vs 4.x)
- Apply appropriate column mapping based on detected schema version

**Message Type Identification:**
- For WeChat 3.x: Look for specific field patterns indicating image messages
- For WeChat 4.x: Check local_type or similar fields that indicate media content
- Analyze message_content field to determine if it contains image metadata

### 3. Integration Points

**Database Layer:**
- Minimal changes needed since all required fields are already available in the database
- No schema modifications required

**Message Processing Pipeline:**
- Extend `mapMessage()` function to handle image detection and mapping
- Maintain compatibility with existing incremental sync logic
- Ensure proper handling of both legacy and modern schemas

### 4. Design Considerations

**Data Flow:**
- Image messages will be detected during message processing
- File paths will be extracted from database fields for downstream systems
- No actual file downloading or storage is part of this implementation

**Compatibility:**
- All existing functionality preserved for text and non-image messages
- Incremental sync capabilities maintained
- Both WeChat 3.x and 4.x schemas supported

## External Dependencies

No external dependencies identified. The implementation will use only existing codebase patterns and available database fields.

## Risks and Mitigation

**Risk**: Incorrect message type detection could lead to data loss or incorrect categorization
**Mitigation**: Implement comprehensive testing with sample data from both schema versions

**Risk**: Performance impact on large databases
**Mitigation**: Leverage existing incremental sync patterns that process messages in batches

---

# Gap Analysis Update — 2026-07-11

_This section supersedes the summary above; the original research pre-dates the image-detection implementation._

## 1. Codebase State at Gap Analysis Time

### What is already implemented

| Requirement | Status |
|---|---|
| Req 1: Image type detection (Type 4/43/49, local_type 4) | **DONE** — `mapMessage` in `sync.ts` lines 160–165 |
| Req 3: Cross-schema compatibility (type detection) | **DONE** — same logic handles legacy and V4 |
| Req 4: Backward compatibility (non-image messages) | **DONE** — unchanged code path |
| Req 2: Image metadata extraction (file path, URL, dimensions) | **NOT IMPLEMENTED** |

All 16 tests in `tests/wechat-image.test.ts` pass as of this analysis.

### What is missing

The `Message` interface in `src/db.ts` has no metadata fields for image messages. The `messages` table has no columns for file paths, URLs, or dimensions. `mapMessage` returns `text: ''` for image rows and discards any content.

---

## 2. Gap: Image Metadata Extraction

### Message interface gap

`src/db.ts` — `Message` interface does not include:
- `media_file_path?: string | null`
- `media_url?: string | null`
- `media_width?: number | null`
- `media_height?: number | null`

### Schema gap

`messages` table has no columns for the above. A migration in `src/db-migrations.ts` would add them as nullable `ALTER TABLE ADD COLUMN` statements.

### Extraction logic gap

`mapMessage` in `sync.ts` (~570 lines, approaching the 200-line module limit) would need to parse metadata from:
- Legacy Type 4/43: `Message`/`strContent` column — likely a plain file path string or XML
- Type 49: `Message` is XML; sub-type and media URL inside XML envelope — *Research Needed* (Type 49 is a generic app-message; may not always be an image)
- V4 local_type 4: `message_content` — likely a path string or may be zstd-compressed blob

---

## 3. Implementation Approach Options

### Option A: Extend `mapMessage` inline + DB columns

Modify `sync.ts` to extract metadata inside `mapMessage`; add nullable columns to `messages` via migration; extend `Message` interface.

- **Pro**: minimal new files
- **Con**: `sync.ts` already ~570 lines; adding XML parsing could push it well past 200-line guideline

### Option B: Hybrid — DB extension + `image-meta.ts` helper (Recommended)

Same DB/interface changes as A. Additionally, create `src/platforms/wechat/image-meta.ts` with a pure `extractImageMeta(row, isV4): ImageMeta` function. `mapMessage` calls it only for image rows.

- **Pro**: clean separation; `sync.ts` stays manageable; helper testable in isolation
- **Con**: one additional file

### Option C: JSON metadata column

Store all metadata in a single `image_meta TEXT` (JSON) column rather than four separate columns.

- **Pro**: schema stays narrow; easy to extend later
- **Con**: queries filtering on specific metadata fields become harder; deviates from flat-column convention already used

---

## 4. Research Needed for Design Phase

1. **Type 49 content**: Is `Message` XML always an image sub-type, or does it cover links, mini-programs, files too? If mixed, the design must decide how to sub-classify or treat all Type 49 as "image" per current requirements.
2. **V4 local_type=4 content format**: Is `message_content` always a plain path string, or can it be zstd-compressed? `WCDB_CT_message_content` flag indicates compression; must handle both.
3. **Legacy Type 4/43 content**: Confirm whether `Message`/`strContent` contains a path, an XML fragment, or is simply empty for inline images.

---

## 5. Effort and Risk

| | Label | Justification |
|---|---|---|
| Effort | S (1–2 days) | Type detection done; DB migration and extraction logic is incremental. Complexity scales with XML parsing for Type 49. |
| Risk | Low–Medium | Established patterns; unknown is WeChat XML format for Type 49 and V4 blob encoding. |

---

## 6. Recommendation

Use **Option B**. Add four nullable columns to `messages` via migration, extend `Message` interface with optional fields, create `src/platforms/wechat/image-meta.ts` for pure extraction logic, and wire it into `mapMessage`. Carry the three research items into the design phase.

---

# Design Synthesis — 2026-07-11

## Discovery Scope

Extension (integration-focused). Type detection (Req 1, 3, 4) already implemented and green in `tests/wechat-image.test.ts`. Remaining work is metadata extraction (Req 2) plus persistence and interface plumbing.

## Codebase Findings Confirmed

- `insertMessage(msg)` (`src/db.ts:149`) binds the whole `Message` object via `.run(msg)`. `better-sqlite3` uses **strict named-parameter binding**: a statement param with no matching object key throws "Missing named parameter", and an object value of `undefined` is not bindable. Adding `@media_*` params to the INSERT would therefore break every existing adapter (telegram, imessage, …) whose `Message` objects never set those keys.
- `getMessages` and `searchMessages` use `SELECT *` / explicit columns; `SELECT *` propagates new columns into `MessageRow` automatically, so MCP/CLI/Web receive enriched records with no interface change (satisfies Req 2 adjacent expectation).
- `buildSchemaInfo` already selects the content column for both schemas: legacy aliases `strContent`/`Message` AS `Message`; V4 selects `message_content`. No SELECT changes are required for extraction.
- No XML parser dependency exists in `package.json`. Only ad-hoc string work is used elsewhere (`src/web/icons.ts`).

## Design Decisions

### Decision: Extraction as a single pure helper `extractImageMeta`
- **Alternatives**: (A) inline extraction in `mapMessage`; (B) dedicated `image-meta.ts` helper.
- **Selected**: B. `mapMessage` already spans `sync.ts` which is near the 200-line module guideline; a pure `extractImageMeta(row, isV4): ImageMeta` keeps `sync.ts` manageable and makes extraction unit-testable in isolation.
- **Generalization**: `ImageMeta` is the image-specific case of "structured media metadata." The return type is a small typed record so the interface can later cover video/voice without reshaping callers; implementation stays image-only per current scope.

### Decision: Regex extraction, no new dependency
- **Alternatives**: adopt `fast-xml-parser`; build regex attribute extraction.
- **Selected**: build. Extraction is best-effort (Req 2.4) and targets a handful of known WeChat XML attributes (`cdnthumbwidth`, `cdnthumbheight`, `cdnthumburl`, `cdnmidimgurl`) or a plain path string. A full XML parser is disproportionate and adds a dependency, conflicting with the local-only / minimal-dependency steering posture.

### Decision: Four flat nullable columns, not JSON
- **Alternatives**: Option C single `image_meta TEXT` JSON column; Option B four typed columns.
- **Selected**: B. Matches the existing flat-column convention in `messages`, keeps values directly queryable by downstream surfaces, and avoids JSON parsing on the read path.

### Decision: `insertMessage` null-coalesces media fields
- **Context**: strict named-param binding (above).
- **Selected**: `insertMessage` builds an explicit bound-params object that maps each new column to `msg.media_* ?? null`. Existing adapters that never set the keys bind `null` and remain byte-for-byte unchanged in behavior (Req 4). This is the single cross-cutting seam of the feature.

## Carried Research Items — Resolutions

1. **Type 49 content**: Per approved Req 1.3, all Type 49 classify as `image`. Type 49 is a generic app-message envelope (may also carry links/files/mini-programs). Extraction is best-effort: when the payload is not an image, metadata fields stay `null` while `type` remains `image` per requirement. Not reopened here — recorded as a known limitation.
2. **V4 `local_type=4` format**: `message_content` may be a plain path string or a zstd blob (flagged by `WCDB_CT_message_content=4`). `extractImageMeta` treats non-string / blob content as "no metadata" and returns nulls (Req 2.4). Plain-string content is parsed for a path or XML attributes.
3. **Legacy Type 4/43 content**: `Message`/`strContent` typically holds image XML (`<msg><img .../></msg>`); may also be empty. Extraction parses attributes when present, returns nulls otherwise. Fidelity depends on which column `buildSchemaInfo` selected — see Risks.

## Risks & Mitigations

- **Extraction fidelity vs. selected column** — `buildSchemaInfo` selects `strContent` in preference to `Message` for legacy; image XML may reside in the unselected column, yielding null metadata. Mitigation: acceptable under best-effort Req 2.4; SELECT is left unchanged to avoid regressing text extraction. Flagged as a follow-up if real-data sampling shows loss.
- **Named-param binding regression** — mitigated by the `insertMessage` null-coalescing decision plus a regression test asserting a non-WeChat `Message` (no media keys) still inserts.
- **Idempotent re-sync** — `insertMessage` ON CONFLICT updates only `is_sender`; media columns are not refreshed on conflict. Acceptable: metadata is immutable for a given message; first insert wins.

---

# Gap Validation Update — 2026-07-13

## Implementation Status: Complete

All gaps identified in the 2026-07-11 analysis are now closed. Verified by running the full test suite.

### Requirement-to-Asset Map (final)

| Requirement | Asset | Status |
|---|---|---|
| Req 1: Type detection (Type 4/43/49, local_type 4) | `sync.ts:161-166` (`isImageMessage`) | **CLOSED** |
| Req 2: Metadata extraction (file path, URL, dimensions) | `src/platforms/wechat/image-meta.ts` (`extractImageMeta`) | **CLOSED** |
| Req 2.4: Missing metadata does not fail sync | `extractImageMeta` returns `NULL_META` on null/Buffer content | **CLOSED** |
| Req 3: Cross-schema consistency | Both legacy and V4 produce identical `Message` shape via `mapMessage` | **CLOSED** |
| Req 4: Backward compatibility | `insertMessage` null-coalesces all media fields; non-WeChat adapters unaffected | **CLOSED** |

### Approach Adopted

Option B (hybrid) was implemented as recommended:
- `sync.ts`: extended `mapMessage` with `isImageMessage` detection and `extractImageMeta` call (lines 161-182)
- `src/platforms/wechat/image-meta.ts`: new pure helper (73 lines), regex-based attribute extraction, no new dependencies
- `src/db.ts`: four flat nullable media columns added to `Message` interface and `messages` table; `insertMessage` null-coalesces keys
- `src/db-migrations.ts`: idempotent `ALTER TABLE ADD COLUMN` migration for the four columns

### Test Evidence

```
tests/wechat-image-meta.test.ts  21 tests  PASS
tests/wechat-image.test.ts       20 tests  PASS
Total: 41 tests, 0 failures
```

### No Remaining Research Items

All three carried research items from the design synthesis were resolved during implementation (see Design Synthesis section above).