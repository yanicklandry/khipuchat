# Requirements Document

## Project Description (Input)
Signal image messages need the same download, OCR, and search treatment that Telegram images receive. The `signal-platform` adapter syncs text/chat data via Beeper Desktop; images referenced in those messages must now be fetched (via Beeper MCP or a local filesystem fallback), stored using the shared local media helper from `telegram-image-sync`, OCR'd with the same pipeline, and made searchable. The `get_image` MCP tool built in `telegram-image-sync` must work for Signal images without modification if the storage convention is followed. Attachment fetching from Beeper is an open gap that must be resolved (or worked around) as part of this spec. Failures must be best-effort: a failed image fetch or OCR must not break the overall sync run.

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
