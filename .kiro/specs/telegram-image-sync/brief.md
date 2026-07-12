# Brief: telegram-image-sync

## Problem
Telegram photo messages are detected but never downloaded or stored. Image content
is invisible to search, semantic search, and MCP tools.

## Current State
- `messages` table already has media columns (`media_file_path`, `media_url`,
  `media_width`, `media_height`), added by `wechat-image-sync`.
- Telegram's adapter (`src/platforms/telegram/sync.ts`) already classifies photo
  messages via `detectType()` (`MessageMediaPhoto` → `'image'`), but never
  downloads the media. GramJS (`telegram` package, already a dependency) exposes
  `client.downloadMedia()` for this.
- No OCR exists anywhere in the codebase. No MCP tool returns image content or a
  file path a client can view.

## Desired Outcome
Telegram image messages are downloaded to local storage, OCR'd, and searchable
through the same `search_messages` / `semantic_search_messages` tools as text,
plus a new MCP tool to retrieve/view an image. The storage convention, OCR
pipeline, and MCP tool built here are platform-agnostic and will be reused by
`signal-platform` / `signal-image-sync` and later `wechat-image-sync` (download
phase).

## Approach
- In `msgToRow` and the surrounding sync loops (`runBackfill`,
  `syncIncrementalImpl`, and the live listener in `startListener`), when
  `detectType(msg) === 'image'`, call `client.downloadMedia(msg)` to fetch the
  photo.
- Save to a local media directory using a platform-agnostic convention (e.g.
  `./media/<platform>/<chat_id>/<external_id>.jpg`) so other platforms can reuse
  the same helper later.
- Populate `media_file_path`, and `media_width`/`media_height` from Telegram's
  `PhotoSize` attributes where cheaply available.
- Add `tesseract.js` (pure JS, no native binary) and a nullable `ocr_text` column
  via a migration in `src/db-migrations.ts` (follow the existing
  `columnExists`/`ALTER TABLE` pattern).
- Run OCR on newly-downloaded images; feed `ocr_text` into `messages_fts` and the
  semantic embedding pipeline (`embeddings.ts` / `index-embeddings.ts`) the same
  way `text` does today.
- Add MCP tool `get_image` (file path and/or base64 content, plus `ocr_text`),
  registered in `src/mcp.ts` / `src/query-handlers.ts`, documented in README.

## Scope
- **In**:
  - Local media storage helper, designed to be platform-agnostic and reused by
    later specs.
  - `ocr_text` column + OCR pipeline + FTS/embedding indexing (shared,
    platform-agnostic).
  - `get_image` MCP tool (shared, platform-agnostic).
  - Telegram media download wired into `runBackfill`, `syncIncrementalImpl`, and
    `startListener`.
- **Out**:
  - Any other platform's image sync (Signal, iMessage, WhatsApp, WeChat download
    phase, Discord, Slack, email) — those are separate specs that will reuse the
    shared pieces built here.
  - Video, voice note, or sticker handling.
  - Image editing, compression, or format conversion.

## Boundary Candidates
- `src/platforms/telegram/sync.ts` (download wiring).
- New shared media storage helper module.
- New shared OCR module.
- `src/mcp.ts` / `src/query-handlers.ts` (`get_image` tool).

## Out of Boundary
- Signal, WeChat, iMessage, WhatsApp, Discord, Slack, email image handling.

## Upstream / Downstream
- **Upstream**: `wechat-image-sync` (established the media columns this reuses),
  `platform-abstraction`, `semantic-search` (embedding pipeline).
- **Downstream**: `signal-platform` / `signal-image-sync` (reuses storage
  convention, OCR module, `get_image` tool), `wechat-image-sync` follow-on
  (download phase), `khipu-cli` / `web-ui` (may eventually surface `get_image`).

## Constraints
- Keep each source file under 200 lines.
- DB operations remain synchronous (better-sqlite3); MCP over stdio only;
  self-hosted, no external services.
- OCR must be best-effort: failures must not break sync runs.
- Downloaded media must not be re-fetched on every re-sync — check
  `media_file_path` before downloading again. Respect existing rate-limiting
  (`sleep(300)` between dialogs) — don't hammer Telegram's media CDN.
- Local media directory excluded from git (`.gitignore`) and handled sensibly in
  Docker (`docker-compose.yml` volumes, `.dockerignore`).
- Schema changes must migrate existing databases without data loss.
