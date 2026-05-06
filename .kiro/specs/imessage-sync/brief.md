# Brief: imessage-sync

## Problem
iMessage history lives in `~/Library/Messages/chat.db` on every Mac, but there's no way to query it through KhipuChat or ask Claude about iMessage conversations. Users have to manually grep SQLite or use third-party tools.

## Current State
- No iMessage sync exists
- Platform abstraction spec (prerequisite) will add `platform` column and `PlatformAdapter` interface
- `npm run sync` is Telegram-only

## Desired Outcome
- `npm run sync:imessage` reads `~/Library/Messages/chat.db`, maps contacts to display names (via address book or phone number fallback), inserts chats and messages with `platform='imessage'`
- Idempotent: re-running deduplicates by `external_id`
- MCP tools (`find_chat_by_name`, `list_messages`, `search_messages`) return iMessage conversations alongside Telegram ones
- Tests cover schema mapping, deduplication, and chat name resolution

## Approach
Read `~/Library/Messages/chat.db` directly (no auth, no API — macOS gives read access to the owning user). Map the `chat`, `handle`, and `message` tables to KhipuChat's generic schema. Resolve contact display names from the `handle.id` (phone/email) using a best-effort lookup (address book via `contacts` npm package or `ABAddressBook` fallback, with raw phone number as fallback).

## Scope
- **In**:
  - `src/platforms/imessage/sync.ts` — reads `~/Library/Messages/chat.db`, maps to `upsertChat` + `insertMessage`
  - `src/platforms/imessage/contacts.ts` — resolves phone/email → display name
  - `package.json`: add `sync:imessage` script
  - Tests: `tests/imessage.test.ts` — mocked chat.db queries, deduplication, name resolution
- **Out**:
  - Sending iMessages
  - Attachment/media sync
  - Real-time iMessage listener (iMessage syncs itself; one-shot import is sufficient)
  - Address book write-back

## Boundary Candidates
- iMessage reader (`src/platforms/imessage/sync.ts`): queries chat.db, maps rows to KhipuChat schema
- Contact resolver (`src/platforms/imessage/contacts.ts`): phone/email → display name, isolated for easy mocking in tests
- Shared DB layer (`src/db.ts`): consumed unchanged from platform-abstraction

## Out of Boundary
- Any changes to `src/db.ts` or `src/mcp.ts` (platform-abstraction owns those)
- Telegram sync changes

## Upstream / Downstream
- **Upstream**: platform-abstraction spec (must be complete — needs `platform` column, `external_id`, `PlatformAdapter` interface)
- **Downstream**: Web UI (Phase 3 in ROADMAP.md) will surface platform badges using the `platform` field already present

## Existing Spec Touchpoints
- **Extends**: platform-abstraction (consumes its DB interface and Platform type)
- **Adjacent**: Telegram sync in `src/platforms/telegram/` — no overlap, different directory

## Constraints
- macOS-only (document this clearly in README)
- `~/Library/Messages/chat.db` requires Full Disk Access permission in macOS privacy settings — sync should give a clear error if the file is unreadable
- No new npm dependencies unless strictly necessary; prefer Node.js built-ins or already-present packages
- TypeScript strict mode, no `any`
- Files under 200 lines
