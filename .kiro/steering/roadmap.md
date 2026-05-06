# Roadmap

## Overview
KhipuChat is a self-hosted multi-platform message archive with an MCP server. Phase 1 (Telegram sync + MCP) is complete. This roadmap tracks the platform generalization work that prepares the codebase for all future platform integrations.

The core idea: make every record in the DB self-describing (platform field on both chats and messages), reorganize source into per-platform modules, and deliver iMessage sync as the first second-platform proof.

## Approach Decision
- **Chosen**: Approach B — `platform` field on both `chats` and `messages` tables, typed union, shared Platform adapter interface
- **Why**: Self-describing rows mean no joins needed for platform-aware MCP queries. Every planned future platform (Discord, Slack, WhatsApp) slots in cleanly. Minimal over-engineering.
- **Rejected alternatives**:
  - Approach A (platform on chats only): messages not self-describing, join required for platform filtering
  - Approach C (separate sync-state tables per platform): more tables and complexity with no query benefit given existing `last_synced_at` generic field

## Scope
- **In**: DB schema generalization, source reorganization into `src/platforms/`, rename Telegram-specific identifiers, MCP tool updates, iMessage sync implementation
- **Out**: Discord/Slack/WhatsApp sync (future phases), Web UI, sending messages, media download

## Constraints
- All DB operations remain synchronous (better-sqlite3)
- MCP server communicates via stdio only
- No breaking changes to existing MCP tool names (tools gain optional `platform` param, responses gain `platform` field — additive only)
- iMessage sync is macOS-only (reads `~/Library/Messages/chat.db`)
- Keep each file under 200 lines

## Boundary Strategy
- **Why this split**: Platform abstraction must land first so iMessage sync has the right schema and adapter interface to build on
- **Shared seams to watch**: `src/db.ts` is the shared boundary — platform-abstraction owns its schema changes; imessage-sync only consumes the exported functions

## Specs (dependency order)
- [x] platform-abstraction -- Generalize schema, reorganize src/platforms/, rename telegram_id→external_id, update MCP tools. Dependencies: none
- [x] imessage-sync -- Read ~/Library/Messages/chat.db, map to generic schema, add npm run sync:imessage. Dependencies: platform-abstraction
