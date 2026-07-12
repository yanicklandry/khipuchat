# Roadmap

## Overview
KhipuChat is a self-hosted multi-platform message archive with an MCP server and web UI. Goal: sync all your conversations locally, query them with Claude, search them in a browser. Your messages never leave your machine.

## Usage Surfaces (priority order)
The archive is consumed through three surfaces. Specs that expose data or queries MUST serve them in this priority:
1. **MCP (primary)** — the main way the archive is used: an LLM (Claude) queries it, from specific lookups (list chats, list messages, get thread) to semantic search. New query/filter capabilities land here first and must be account-aware and platform-aware.
2. **CLI (secondary)** — mainly for debugging, but also for scripted automation: list/search messages with filters (date range, platform, account, type). The CLI should reach parity with MCP filtering so anything the LLM can query, an operator can query from the terminal.
3. **Web (secondary)** — a browser UI for testing and manual browsing of the archive.
Whatever the archive can answer through one surface should be answerable through the others (agent-native parity), with MCP as the reference implementation.

Phase 1 (Telegram sync + MCP) and Phase 2 (iMessage sync + platform abstraction) are complete. This roadmap tracks the remaining phases: web UI, additional platform integrations, semantic search, security hardening, and release.

## Approach Decision
- **Chosen**: Vertical slices — each phase delivers independently useful functionality on top of the shared platform-abstraction foundation
- **Why**: Every phase ships something usable. No phase depends on a future phase. Platform adapters follow the established PlatformAdapter interface.
- **Rejected alternatives**:
  - Big-bang all platforms at once: too risky, no intermediate value
  - Web UI last: users can't browse messages until very late

## Scope
- **In**: Web UI, WeChat/Discord/Email/Slack/WhatsApp sync, semantic search, security hardening, Docker release
- **Out**: Sending messages on any platform, Instagram/Facebook, mobile app, cloud sync

## Constraints
- All DB operations remain synchronous (better-sqlite3)
- MCP server communicates via stdio only
- Keep each source file under 200 lines
- Self-hosted only — no external services, no cloud
- Each phase must have passing tests before the next starts

## Boundary Strategy
- **Why this split**: Each platform adapter is isolated in `src/platforms/<name>/`. `src/db.ts` is the shared boundary — adapters only call exported db functions, never touch the schema.
- **Shared seams to watch**: `src/db.ts` (schema), `src/mcp.ts` (tool descriptions), `src/platforms/types.ts` (PlatformAdapter interface)

## Specs (dependency order)
- [x] platform-abstraction -- Generalize schema, reorganize src/platforms/, rename telegram_id→external_id, update MCP tools. Dependencies: none
- [x] imessage-sync -- Read ~/Library/Messages/chat.db, map to generic schema, add npm run sync:imessage. Dependencies: platform-abstraction
- [x] wechat-sync -- Read WeChat Mac local SQLite DB directly (no API, no auth), map to generic schema, add npm run sync:wechat. Dependencies: platform-abstraction
- [x] wechat-image-sync -- Extract and map image messages from WeChat database, store file references. Dependencies: wechat-sync
- [x] semantic-search -- Local ONNX embeddings (all-MiniLM-L6-v2) + sqlite-vec; new MCP tools semantic_find_contacts and semantic_search_messages; incremental indexing pipeline. Dependencies: platform-abstraction
- [x] web-ui -- Express + plain HTML search UI served at localhost:3333, chat list sidebar, message thread view, platform badges. Dependencies: platform-abstraction, imessage-sync
- [x] discord-sync -- Discord bot token, sync DMs and non-broadcast channels, npm run sync:discord. Dependencies: platform-abstraction
- [x] email-sync -- IMAP via imapflow, sync sent+received threads as messages, npm run sync:email. Dependencies: platform-abstraction
- [x] slack-sync -- Personal Slack app OAuth, sync DMs and channels, npm run sync:slack. Dependencies: platform-abstraction
- [x] whatsapp-sync -- whatsapp-web.js QR-code session, sync DMs, npm run sync:whatsapp. Dependencies: platform-abstraction
- [x] security-hardening -- SQLCipher encryption, web UI basic-auth, MCP bearer token, localhost-only binding. Dependencies: web-ui
- [x] release -- Dockerfile + docker-compose, GitHub Actions CI/publish, SECURITY.md, demo GIF. Dependencies: web-ui, wechat-sync, discord-sync, email-sync, slack-sync, whatsapp-sync, security-hardening
- [x] incremental-sync -- Extend PlatformAdapter with lastSyncAt tracking; sync_state table; all sync scripts fetch only messages newer than last successful sync. `--force` full re-read + reindex; per-account sync_state. Dependencies: platform-abstraction.
- [x] web-ui-enhancements -- Chat-window scroll layout (oldest top, newest bottom, auto-scroll to newest, load-older on scroll-up) + semantic search input in web UI. Dependencies: web-ui, semantic-search
- [x] sync-watcher -- Daemon that polls all configured platforms continuously; sync => index => wait; `khipu sync all` entry point; `--once` single-pass. Dependencies: incremental-sync.
- [x] multi-account -- khipu.config.json account registry; add `account` dimension to schema; per-account sync_state; adapters iterate configured accounts (WeChat excluded). Dependencies: platform-abstraction, incremental-sync
- [x] khipu-cli -- Global `khipu` command (bin + npm link) replacing `npm run sync:*`; `khipu sync` (list), `khipu sync all` (daemon: sync=>index=>wait, `--once` for cron), `khipu sync <platform>[@account]` (one-shot debug), `--force` (re-read all + reindex). Dependencies: sync-watcher, incremental-sync, semantic-search, multi-account
- [x] telegram-image-sync -- Download Telegram photo messages via GramJS `client.downloadMedia()`, store locally, OCR with local model, add `ocr_text` column + `get_image` MCP tool; establishes shared image storage convention. Dependencies: platform-abstraction
- [x] image-support -- Umbrella: make image messages (across platforms) visible to search, semantic search, and MCP. Combines telegram-image-sync infrastructure with iMessage attachment extraction and Signal image sync. Dependencies: telegram-image-sync, signal-platform
- [ ] signal-platform -- Sync Signal chats and text messages via Beeper Desktop MCP connector (not direct DB access); implements `PlatformAdapter`; ingests into `chats`/`messages` tables using existing MCP tools. Dependencies: platform-abstraction
- [ ] signal-image-sync -- Download and OCR Signal image attachments via Beeper's attachment API, reusing storage + OCR pipeline from telegram-image-sync. Dependencies: signal-platform, telegram-image-sync

## Existing Spec Updates
- [ ] web-ui -- extended by web-ui-enhancements (chat layout + semantic search UI)
- [ ] platform-abstraction -- extended by incremental-sync (PlatformAdapter interface addition)
- [ ] platform-abstraction -- extended by multi-account (schema `account` dimension + account-aware adapter interface)

## Existing Spec Corrections (2026-07-11 quality pass — see .kiro/brief.md)
- [ ] sync-watcher -- poll cycle must ALSO run embedding indexing after a successful sync (sync => index => wait); entry point becomes `khipu sync all`; support `--once` single-pass. Correction appended to requirements.md.
- [ ] incremental-sync -- rename/alias `--backfill` to `--force`; `--force` additionally rebuilds embeddings; `sync_state` keyed by (platform, account) once multi-account lands. Correction appended to requirements.md.
- [ ] semantic-search -- indexing is invoked automatically by the watch loop after each sync and by `--force`; add `khipu index` entry point. Correction appended to requirements.md.
- [ ] release -- Docker, README, and CI must use the `khipu` CLI (global install / npm link) instead of `npm run sync:*` and raw `tsx`. Correction appended to requirements.md.

## Direct Implementation Candidates
- [ ] mcp-test-script -- `scripts/test-mcp.sh` bash script with sample queries for every MCP tool + `.claude/skills/mcp-testing/SKILL.md`. Pure tooling, no spec needed.
