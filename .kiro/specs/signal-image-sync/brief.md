# Brief: signal-image-sync

## Problem
Once Signal chats/messages sync (via `signal-platform`), image messages still need
the same download → OCR → search treatment Telegram gets, using Beeper Desktop as
the ingestion path rather than local file access.

## Current State
- Depends on `signal-platform` (text/chat sync) and `telegram-image-sync` (shared
  local media storage helper, `ocr_text` column + OCR pipeline, `get_image` MCP
  tool) both landing first.
- Beeper's `search_messages` tool supports `mediaTypes: ['image']` and returns
  attachment references (`beeper-mcp://attachments/...`), but does not expose a
  direct download/fetch tool for attachment bytes in what has been explored so
  far — this needs to be re-verified as part of this spec, not assumed.

## Desired Outcome
Signal image messages are downloaded (via whatever mechanism `signal-platform`
established for calling Beeper), OCR'd, and searchable the same way Telegram
images are, reusing the shared infrastructure from `telegram-image-sync` rather
than duplicating it.

## Approach
- Confirm (or find a workaround for) how to pull actual image bytes for a Beeper
  attachment reference — this was an open gap when last checked; may require a
  different Beeper API/tool than what's been tried, or a local filesystem path to
  Beeper's own attachment cache as a fallback.
- Reuse the local media storage helper and OCR module built in
  `telegram-image-sync` — do not build a second implementation.
- Populate the same `media_file_path` / `ocr_text` columns; feed into the same
  FTS/embedding pipeline.
- `get_image` MCP tool (already built in `telegram-image-sync`) should work for
  Signal messages without platform-specific changes, if the schema/storage
  convention is followed correctly.

## Scope
- **In**: Signal-specific image download/resolution logic; wiring into
  `signal-platform`'s sync loop.
- **Out**: Any change to the shared storage/OCR/`get_image` infrastructure's
  design (reuse as-is; if it doesn't fit, that's a signal the shared design needs
  revisiting as its own follow-up, not a reason to fork it here).

## Boundary Candidates
- `src/platforms/signal/` (image download wiring, added to the adapter from
  `signal-platform`).

## Out of Boundary
- Shared storage/OCR/`get_image` design (owned by `telegram-image-sync`).
- Non-Signal platforms.

## Upstream / Downstream
- **Upstream**: `signal-platform` (chat/message sync must exist first),
  `telegram-image-sync` (shared infrastructure).
- **Downstream**: none currently.

## Constraints
- Keep each source file under 200 lines.
- OCR must be best-effort: failures must not break sync runs.
- Must degrade gracefully if Beeper Desktop is not running or an attachment can't
  be fetched — skip that image, don't fail the whole sync.
