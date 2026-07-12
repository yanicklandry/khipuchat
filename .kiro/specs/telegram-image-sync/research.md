# Gap Analysis: telegram-image-sync

**Date**: 2026-07-12
**Spec phase**: requirements-generated

---

## Existing Infrastructure

### What Already Exists

| Component | Status | Notes |
|---|---|---|
| `messages.media_file_path` | Exists (migration) | Added by wechat-image-sync; nullable TEXT |
| `messages.media_url` | Exists (migration) | Nullable TEXT |
| `messages.media_width` | Exists (migration) | Nullable INTEGER |
| `messages.media_height` | Exists (migration) | Nullable INTEGER |
| `messages.ocr_text` | **Missing** | Needs migration |
| `detectType()` | Exists | Already returns `'image'` for `MessageMediaPhoto` |
| `msgToRow()` | Exists | Inserts image rows with `text: null`, `media_file_path: null` |
| `client.downloadMedia()` | Available (GramJS) | TelegramClient supports it; never called |
| `columnExists()` | Exists | In `src/db-migrations.ts`; standard migration helper |
| `embedNewMessages()` | Exists | Only indexes messages where `text IS NOT NULL AND text != ''` |
| `rebuildEmbeddings()` | Exists | Same text-only filter |
| `messages_fts` FTS5 table | Exists | Only indexes the `text` column; no `ocr_text` |
| `insertMessage()` | Exists | `ON CONFLICT DO UPDATE` only updates `is_sender` — does NOT update media fields |
| `runBackfill()` | Exists | Per-dialog loop with 300ms sleep between dialogs |
| `syncIncrementalImpl()` | Exists | Same loop structure |
| `startListener()` | Exists | Event handler inserts message + triggers embeddings |
| `src/db-migrations.ts` | Exists | Standard migration pattern with `columnExists` guard |
| `docker-compose.yml` | Exists | No media volume; needs one |
| `.gitignore` | Exists | No `media/` exclusion; needs one |

---

## Gaps to Fill

### 1. Schema: `ocr_text` column

**File**: `src/db-migrations.ts`

Add to existing migration function:

```typescript
if (!columnExists(database, 'messages', 'ocr_text'))
  database.exec('ALTER TABLE messages ADD COLUMN ocr_text TEXT')
```

Also add `ocr_text?: string | null` to the `Message` interface in `src/db.ts`.

**Risk**: Low — follows established pattern exactly.

---

### 2. FTS schema: add `ocr_text` to indexed content

**File**: `src/db.ts` — `createSchema()`

The current FTS5 virtual table only indexes `text`:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='id');
```

This must become:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, ocr_text, content='messages', content_rowid='id');
```

The insert trigger must also be updated to include `ocr_text`:

```sql
CREATE TRIGGER IF NOT EXISTS messages_fts_insert
  AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text, ocr_text) VALUES (new.id, new.text, new.ocr_text);
  END;
```

An update trigger is also needed (currently absent) to re-index when `ocr_text` is set on a previously null column:

```sql
CREATE TRIGGER IF NOT EXISTS messages_fts_update
  AFTER UPDATE OF ocr_text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text, ocr_text)
      VALUES ('delete', old.id, old.text, old.ocr_text);
    INSERT INTO messages_fts(rowid, text, ocr_text) VALUES (new.id, new.text, new.ocr_text);
  END;
```

**Migration challenge**: The existing `messages_fts` virtual table was created with only one column (`text`). SQLite does not support `ALTER VIRTUAL TABLE`. The migration must:

1. Drop the old FTS table and its triggers.
2. Let `createSchema()` recreate it with the new two-column schema.
3. Call `rebuildFtsIndex()` (already done in `initDb()`).

Migration guard: check whether `ocr_text` column is absent from the FTS table using `PRAGMA table_info(messages_fts)`. If absent, drop the table and both existing triggers before `createSchema` runs.

**Risk**: Medium. The drop+recreate destroys FTS index data, but `initDb()` already calls `rebuildFtsIndex()` unconditionally, so FTS is always rebuilt from messages at startup — no data loss.

The search query (`searchMessages()` in `src/db.ts`) uses `WHERE messages_fts MATCH ?` which FTS5 applies across all indexed columns by default — no query change required for `ocr_text` to become searchable.

---

### 3. New DB function: `updateMessageMedia()`

**File**: `src/db.ts`

`insertMessage()` uses `ON CONFLICT DO UPDATE SET is_sender = ...` — it does NOT update `media_file_path`, `media_width`, `media_height`, or `ocr_text`. After downloading and OCR-ing an image, we need a separate update function:

```typescript
export function updateMessageMedia(id: number, fields: {
  media_file_path?: string | null
  media_width?: number | null
  media_height?: number | null
  ocr_text?: string | null
}): void
```

This lets the download and OCR phases be decoupled from the initial insert.

**Risk**: Low — straightforward UPDATE query.

---

### 4. New module: `src/media-storage.ts`

**Purpose**: Platform-agnostic storage helper.

Responsibilities:
- Compute a deterministic local path: `media/<platform>/<chat_id>/<external_id>.<ext>`
- Create parent directories with `fs.mkdirSync(..., { recursive: true })`
- Write a Buffer to disk
- Return the absolute path

The `<ext>` for Telegram JPEG photos is `jpg`. The function should accept an explicit extension so Signal/WeChat adapters can pass their own.

**Risk**: Low — pure Node.js `fs` and `path`. No external dependency.

---

### 5. New module: `src/ocr.ts`

**Purpose**: Platform-agnostic OCR wrapper.

**Library**: `tesseract.js` (specified in requirements). It is a WASM-based OCR engine — no native binaries, no external API. Compatible with the project's local-only ethos.

`tesseract.js` is **not** in `package.json` — it must be added: `npm install tesseract.js`.

The module should:
- Accept a file path (or Buffer)
- Return `string | null` (null on failure, after logging the error)
- Initialize `Tesseract.createWorker()` once (lazy singleton) to avoid repeated WASM load costs
- Be async (tesseract.js is async-only)

**TypeScript types**: `tesseract.js` ships its own types (`@types/tesseract.js` is the old API; modern tesseract.js >= 4 is self-typed).

**Risk**: Medium. OCR is notoriously slow (seconds per image). For sync performance, this suggests a post-insert pass rather than inline OCR. Also, tesseract.js worker initialization takes ~500ms; singleton pattern is important.

---

### 6. Telegram download integration

**File**: `src/platforms/telegram/sync.ts`

**GramJS API**: `await client.downloadMedia(message, { outputFile: Buffer })` returns `Buffer | undefined`. The `message` must be the raw GramJS message object (not the typed `MsgLike` stub). In `runBackfill` and `syncIncrementalImpl`, the loop variable `msg` is already the raw GramJS message — the `MsgLike` typing is a minimal overlay on top of it.

For photos specifically, width/height are available in `msg.media.photo.sizes[]` (the largest size).

**Integration points** (all three paths):

| Path | Location | Change needed |
|---|---|---|
| Backfill | `runBackfill()` inner `for` loop | After `insertMessage(row)` for image messages |
| Incremental | `syncIncrementalImpl()` inner `for` loop | Same |
| Live listener | `startListener()` event handler | Same |

**Idempotency**: Before attempting download, check whether `media_file_path` is already set for that message (`getDb().prepare('SELECT media_file_path FROM messages WHERE id = ?').get(id)`). Skip if already downloaded.

**Rate limiting**: Req 7.1. Telegram MTProto rate limits apply. A strategy:
- Option A: Inline delay (100-500ms) between individual image downloads within a loop
- Option B: Post-sync download pass (separate loop after all messages inserted)

Option B is cleaner: it decouples image download from message sync, making it easier to retry failed downloads and to rate-limit independently. It also means the 300ms inter-dialog sleep in `runBackfill` is not affected.

---

### 7. Embedding pipeline changes

**File**: `src/index-embeddings.ts`

Two changes required:

**a) Include messages with `ocr_text` in the unindexed query**

Current condition:
```typescript
WHERE m.text IS NOT NULL AND m.text != '' AND m.id NOT IN (SELECT rowid FROM vec_messages)
```

New condition (embedding content = text + ocr_text):
```typescript
WHERE (m.text IS NOT NULL AND m.text != '' OR m.ocr_text IS NOT NULL AND m.ocr_text != '')
  AND m.id NOT IN (SELECT rowid FROM vec_messages)
```

Since image messages arrive with `text = null`, they are never embedded until `ocr_text` is populated. Once OCR runs and sets `ocr_text`, the next sync will pick them up as unindexed — no duplicate embedding issue.

**b) Use combined content for embedding input**

```typescript
const content = [row.text, row.ocr_text].filter(Boolean).join(' ')
```

Both `text` and `ocr_text` contribute to the embedding vector, satisfying Req 5.3.

**c) Re-embedding of already-indexed messages (edge case)**

If a message was previously indexed from `text` alone (e.g., a media message that had a caption), it will already be in `vec_messages`. After OCR adds `ocr_text`, the message will NOT be re-embedded because it already has a vector entry. This matches Req 5.4 ("while a message already has a stored embedding... do not regenerate"). The trade-off: the embedding may not reflect `ocr_text` for messages that had both `text` and `ocr_text`. Acceptable per the spec since Req 5.4 explicitly excludes re-embedding.

The `rebuildEmbeddings(platform, force=true)` path clears all vectors and re-indexes from scratch, which will pick up `ocr_text` if the user wants full reindexing.

---

### 8. New MCP tool: `get_image`

**File**: `src/mcp.ts`

**Handler logic**: Query `messages` for the given message ID; read the file at `media_file_path`; base64-encode it; return `{ file_path, content_base64, ocr_text }`.

**Tool registration** (in `ListToolsRequestSchema` handler):

```typescript
{
  name: 'get_image',
  description: 'Retrieve the content and OCR text of a stored image message',
  inputSchema: {
    type: 'object',
    properties: { message_id: { type: 'number' } },
    required: ['message_id']
  }
}
```

**Handler** (in `CallToolRequestSchema` handler):

```typescript
else if (name === 'get_image')
  result = await handleGetImage(Number(args['message_id']))
```

The `handleGetImage` function should live in `src/query-handlers.ts` alongside the other handlers, or in a new `src/image-handlers.ts` if the file would exceed 200 lines.

Error cases:
- Message ID not found: throw descriptive error
- `media_file_path` is null: return error per Req 6.3
- File not on disk (path exists in DB but file deleted): return error

**File size concern**: Base64-encoding a multi-MB JPEG before passing it through MCP stdio may be slow. The spec says "base64-encoded image content" so this is required, but the design should note the tradeoff.

---

### 9. Operational / infrastructure gaps

| Gap | File | Fix |
|---|---|---|
| `media/` not in `.gitignore` | `.gitignore` | Add `media/` line |
| No media Docker volume | `docker-compose.yml` | Add `- media-data:/app/media` volume for both `web` and `sync` services, declare `media-data:` in the volumes section |
| No README entry for `get_image` | `README.md` | Add to MCP tools table (Req 6.5) |

---

## Implementation Approach Recommendation

**Recommended: Download-pass strategy (Option B for rate limiting)**

```
sync messages
  => insert all messages (existing behavior, unchanged)
  => after all messages for a chat: download any image messages with media_file_path IS NULL
     => save file (media-storage.ts)
     => run OCR (ocr.ts) — best-effort, log errors
     => updateMessageMedia()
  => embedNewMessages() — picks up newly OCR'd messages
```

This keeps the message insert loop fast, makes download failures non-disruptive, and makes rate limiting easy (one delay slot per download at the per-chat level).

The live listener runs the same download + OCR inline (one message at a time, so rate limiting is not a concern).

---

## Key Risks & Open Questions

| Risk | Severity | Mitigation |
|---|---|---|
| FTS virtual table schema migration | Medium | Drop+recreate on migration; FTS rebuilt at startup anyway |
| `tesseract.js` WASM startup latency (~500ms) | Low-Medium | Singleton worker initialized once per process |
| Large base64 image over MCP stdio | Low | Document size tradeoff; images are typically 100KB-2MB |
| GramJS `downloadMedia` type safety | Low | Cast through `unknown`; test with real session |
| OCR accuracy / language support | Low | Out of scope per requirements; best-effort only |
| `insertMessage` not returning inserted row ID | Low | Query `SELECT id FROM messages WHERE external_id=? AND chat_id=?` after insert, or refactor to `RETURNING id` |

---

## File Change Summary

| File | Change type | Notes |
|---|---|---|
| `src/db-migrations.ts` | Modify | Add `ocr_text` column migration + FTS table drop/recreate guard |
| `src/db.ts` | Modify | Add `ocr_text` to `Message` interface, FTS schema, triggers, `updateMessageMedia()` |
| `src/media-storage.ts` | **New** | Platform-agnostic file storage helper |
| `src/ocr.ts` | **New** | `tesseract.js` wrapper (async, singleton worker) |
| `src/index-embeddings.ts` | Modify | Extend unindexed query + embedding content to include `ocr_text` |
| `src/platforms/telegram/sync.ts` | Modify | Add image download pass after message insert loop |
| `src/mcp.ts` | Modify | Register `get_image` tool, add handler dispatch |
| `src/query-handlers.ts` | Modify | Add `handleGetImage()` (or new `src/image-handlers.ts`) |
| `docker-compose.yml` | Modify | Add `media-data` named volume |
| `.gitignore` | Modify | Add `media/` |
| `README.md` | Modify | Document `get_image` MCP tool |
| `package.json` | Modify | Add `tesseract.js` dependency |
