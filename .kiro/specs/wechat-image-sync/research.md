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