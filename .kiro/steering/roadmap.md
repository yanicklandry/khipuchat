# Roadmap

## Overview
KhipuChat is a self-hosted multi-platform message archive with an MCP server and web UI. Goal: sync all your conversations locally, query them with Claude, search them in a browser. Your messages never leave your machine.

Phase 1 (Telegram sync + MCP) and Phase 2 (iMessage sync + platform abstraction) are complete. This roadmap tracks the remaining phases: web UI, additional platform integrations, security hardening, and release.

## Approach Decision
- **Chosen**: Vertical slices — each phase delivers independently useful functionality on top of the shared platform-abstraction foundation
- **Why**: Every phase ships something usable. No phase depends on a future phase. Platform adapters follow the established PlatformAdapter interface.
- **Rejected alternatives**:
  - Big-bang all platforms at once: too risky, no intermediate value
  - Web UI last: users can't browse messages until very late

## Scope
- **In**: Web UI, WeChat/Discord/Email/Slack/WhatsApp sync, security hardening, Docker release
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
- [ ] wechat-sync -- Read WeChat Mac local SQLite DB directly (no API, no auth), map to generic schema, add npm run sync:wechat. Dependencies: platform-abstraction
- [ ] web-ui -- Express + plain HTML search UI served at localhost:3333, chat list sidebar, message thread view, platform badges. Dependencies: platform-abstraction, imessage-sync
- [ ] discord-sync -- Discord bot token, sync DMs and non-broadcast channels, npm run sync:discord. Dependencies: platform-abstraction
- [ ] email-sync -- IMAP via imapflow, sync sent+received threads as messages, npm run sync:email. Dependencies: platform-abstraction
- [ ] slack-sync -- Personal Slack app OAuth, sync DMs and channels, npm run sync:slack. Dependencies: platform-abstraction
- [ ] whatsapp-sync -- whatsapp-web.js QR-code session, sync DMs, npm run sync:whatsapp. Dependencies: platform-abstraction
- [ ] security-hardening -- SQLCipher encryption, web UI basic-auth, MCP bearer token, localhost-only binding. Dependencies: web-ui
- [ ] release -- Dockerfile + docker-compose, GitHub Actions CI/publish, SECURITY.md, demo GIF. Dependencies: web-ui, wechat-sync, discord-sync, email-sync, slack-sync, whatsapp-sync, security-hardening
