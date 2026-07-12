# Brief: image-support

## Problem
KhipuChat archives text messages across platforms but drops image messages almost
entirely. Image content — screenshots, photos, documents shared as images — is
invisible to search, semantic search, and MCP tools. The operator's primary use
case is Signal, but Signal is not currently a KhipuChat platform at all.

## Current State
- The `messages` table already has media columns (`media_file_path`, `media_url`,
  `media_width`, `media_height`), added by `wechat-image-sync`.
- `wechat-image-sync` only extracts a **remote CDN URL** into `media_url` — no
  local file is ever downloaded or stored, for any platform.
- Telegram's adapter (`src/platforms/telegram/sync.ts`) already classifies photo
  messages via `detectType()` (`MessageMediaPhoto` → `'image'`), but never
  downloads the media. GramJS (`telegram` package, already a dependency) exposes
  `client.downloadMedia()` for this.
- iMessage's adapter does not detect or handle attachments at all; image messages
  arrive with `text: null, type: 'other'` and are effectively dropped, despite
  `chat.db` exposing local attachment file paths via its `attachment` /
  `message_attachment_join` tables.
- Signal is not a KhipuChat platform. It is currently only reachable through a
  separate tool, Beeper Desktop, via its own MCP connector (`search_messages` with
  `mediaTypes: ['image']`, `list_messages`, etc.) — Signal Desktop's local SQLite
  store is encrypted with a key in the OS keychain, making direct local-DB access
  meaningfully harder and more fragile than Telegram or iMessage.
- No OCR exists anywhere in the codebase. No MCP tool returns image content or a
  file path a client can view.

## Desired Outcome
Image messages become first-class: downloaded/resolved to a local file where
possible, OCR'd, and searchable through the same `search_messages` /
`semantic_search_messages` tools as text — plus a new MCP tool to actually
retrieve/view an image. Signal is the operator's priority platform; all platforms
should eventually be covered.

## Approach
Land this in three waves rather than one cross-platform pass, since each platform's
attachment-access model is different enough to need its own design work:

1. **Telegram** (first wave) — closest to done already; `detectType()` exists,
   GramJS has a built-in download method, no auth/encryption obstacles.
2. **Signal** (operator's actual priority) — no native local-DB path comparable to
   Telegram/iMessage. Likely approach: a new KhipuChat adapter that ingests via the
   existing Beeper Desktop MCP connector (which already normalizes Signal,
   WhatsApp, and others behind one interface) rather than reverse-engineering
   Signal Desktop's encrypted database directly. This needs its own design
   spike/research before a design doc is written — do not assume the Beeper
   approach is correct without validating it.
3. **Remaining platforms** (iMessage, WhatsApp, Discord, Slack, email) — follow
   once the pattern is proven on Telegram (and ideally Signal), each getting its
   own scoped spec rather than being bundled here.

A shared, platform-agnostic piece cuts across all waves and should be designed
once, in the first wave, then reused: local media storage convention, the
`ocr_text` column + FTS/embedding indexing, and the `get_image` MCP tool.

## Scope
- **In**:
  - Local media storage convention (directory layout, naming, dedup-on-resync)
    usable by any platform adapter.
  - `ocr_text` column on `messages` (migration in `src/db-migrations.ts`), OCR via
    `tesseract.js`, feeding into `messages_fts` and the semantic embedding
    pipeline the same way `text` does today.
  - New MCP tool `get_image` (file path and/or base64 content, plus `ocr_text`),
    registered in `src/mcp.ts` / `src/query-handlers.ts`, documented in README.
  - Telegram: download images via `client.downloadMedia()` in `runBackfill`,
    `syncIncrementalImpl`, and the live listener; populate `media_file_path` (and
    width/height where cheaply available).
  - Research/design spike for Signal ingestion via Beeper Desktop's MCP connector
    (or an alternative, if the spike finds a better path) — this wave's design.md
    should document findings even if implementation lands as a follow-on spec.
- **Out** (this brief; may become their own specs later):
  - Full implementation of Signal, iMessage, WhatsApp, Discord, Slack, or email
    image sync — only Telegram ships working image sync from this brief; Signal
    gets research + design, not necessarily implementation.
  - Video, voice note, or sticker handling.
  - Image editing, compression, or format conversion.
  - Any change to Beeper Desktop itself (KhipuChat only ever calls it as a client).

## Boundary Candidates
- Media download/resolution logic per adapter (`telegram/sync.ts`, future
  `imessage/sync.ts`, future Signal adapter).
- Shared local media storage helper (new, platform-agnostic).
- OCR invocation + `ocr_text` column + indexing pipeline (new, shared).
- `get_image` MCP tool (new, shared).

## Out of Boundary
- Beeper Desktop's own internals/config.
- Any non-image media type.
- Multi-account handling beyond what `multi-account` already covers (this brief
  assumes account-awareness already lands per that spec; don't re-solve it here).

## Upstream / Downstream
- **Upstream**: `wechat-image-sync` (established the media columns this reuses),
  `platform-abstraction` (`PlatformAdapter` interface), `multi-account` (account
  dimension on sync state), `semantic-search` (embedding pipeline `ocr_text` feeds
  into).
- **Downstream**: `khipu-cli` / `web-ui` (should eventually surface `get_image` or
  equivalent), any future Signal-specific spec that implements what this brief's
  Signal wave only researches.

## Constraints
- Keep each source file under 200 lines (existing project constraint).
- DB operations remain synchronous (better-sqlite3); MCP over stdio only;
  self-hosted, no external services — `tesseract.js` (pure JS, no native binary,
  no cloud OCR API) fits this.
- OCR must be best-effort: failures must not break sync runs.
- Downloaded media must not be re-fetched on every re-sync — check
  `media_file_path` before downloading again.
- Local media directory must be excluded from git (`.gitignore`) and handled
  sensibly in Docker (`docker-compose.yml` volumes, `.dockerignore`).
- Schema changes must migrate existing databases without data loss, following the
  `columnExists`/`ALTER TABLE` pattern already used in `db-migrations.ts`.
