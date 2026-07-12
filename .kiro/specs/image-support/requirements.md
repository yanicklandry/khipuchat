# Requirements Document

## Project Description (Input)
KhipuChat archives text messages across platforms but drops image messages almost
entirely. Image content — screenshots, photos, documents shared as images — is
invisible to search, semantic search, and MCP tools.

**Who has the problem**: KhipuChat operators (self-hosted users) who rely on message
archives for search and retrieval of image-bearing conversations, primarily on Signal
and Telegram.

**Current situation**: The `messages` table has media columns (`media_file_path`,
`media_url`, `media_width`, `media_height`) but no image is ever downloaded or stored
locally. Telegram's adapter detects photo messages via `detectType()` but never calls
`client.downloadMedia()`. iMessage drops image attachments entirely (`text: null, type:
'other'`). Signal is not a KhipuChat platform at all — only reachable via Beeper
Desktop's MCP connector. No OCR exists anywhere; no MCP tool returns image content or
a file path a client can view.

**What should change**: Image messages become first-class: downloaded/resolved to a
local file where possible, OCR'd via `tesseract.js`, and searchable through
`search_messages` / `semantic_search_messages` the same way text is today — plus a new
`get_image` MCP tool. Telegram ships working image sync in wave 1. Signal gets a
research/design spike in wave 1, with implementation as a follow-on spec. Remaining
platforms (iMessage, WhatsApp, Discord, Slack, email) follow later.

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
