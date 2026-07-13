# Research Log — imessage-sync

## Discovery Scope

Extension-type feature: integrates with an external read-only macOS SQLite database (`~/Library/Messages/chat.db`) and maps its data to KhipuChat's generic schema established by the platform-abstraction spec.

## Codebase Analysis

### Existing Patterns

- `src/db.ts`: All DB operations use `better-sqlite3` synchronously. `upsertChat` uses `INSERT ... ON CONFLICT(id) DO UPDATE`. `insertMessage` uses `INSERT OR IGNORE` for idempotency. Module-level singleton `_db` initialized via `initDb(path)`.
- `src/sync.ts`: Telegram sync follows a mapper pattern (`entityToChat`, `msgToRow`) that converts platform-specific objects to generic `Chat` and `Message` types before calling DB functions. This is the pattern iMessage sync must replicate.
- Platform-abstraction spec establishes: `src/platforms/types.ts` with `Platform` union and `PlatformAdapter` interface; `messages.external_id` (renamed from `telegram_id`); `chats.platform` and `messages.platform` columns; `PlatformAdapter.runBackfill(db)` signature.

### chat.db Schema (macOS Messages)

Key tables:
- `chat`: `ROWID`, `guid` (unique, stable), `chat_identifier`, `display_name`, `service_name`, `room_name`
- `handle`: `ROWID`, `id` (phone number or email), `country`, `service`
- `message`: `ROWID`, `guid` (unique, stable), `text`, `date` (nanoseconds since 2001-01-01 Apple Cocoa epoch), `is_from_me`, `handle_id` (FK to handle.ROWID), `reply_to_guid`
- `chat_handle_join`: `chat_id`, `handle_id` (many-to-many link between chats and participants)
- `chat_message_join`: `chat_id`, `message_id` (many-to-many link between chats and messages)

### Apple Epoch Conversion

iMessage `message.date` stores nanoseconds since 2001-01-01 00:00:00 UTC (Apple Cocoa epoch). To convert to Unix timestamp seconds:
- `unixTs = Math.floor(cocoaDate / 1_000_000_000) + 978307200`
- `978307200` = seconds between 1970-01-01 and 2001-01-01

Note: Some older macOS versions stored `date` in seconds (not nanoseconds). Guard: if `cocoaDate > 1e10`, treat as nanoseconds; otherwise treat as seconds.

### Contact Resolution Strategy

Options considered:
1. `contacts` npm package — not in existing dependencies; adds a dep.
2. `osascript` / AppleScript: `osascript -e 'tell app "Contacts" to ...'` — available on macOS, no extra deps, but slow for bulk lookups.
3. Read `~/Library/Application Support/AddressBook/` SQLite files directly — complex schema, undocumented.
4. `ABAddressBook` via node-gyp native binding — not in project.
5. Parse `AddressBook.sqlitedb` at `~/Library/Application Support/AddressBook/Sources/*/AddressBook.sqlitedb` — undocumented but stable enough for best-effort.

**Decision**: Use `child_process.execSync` to call `sqlite3` (macOS built-in) on the AddressBook SQLite, with raw handle.id as fallback. If `sqlite3` CLI is unavailable or query fails, fall back silently. This avoids new npm deps and stays within the "no new npm packages unless strictly necessary" constraint. The address book query is best-effort and never fatal.

**Simplification**: Keep contact lookup synchronous (best-effort, pre-built map at startup) to stay consistent with the sync-I/O model of the project.

### Chat ID Strategy

`chat.ROWID` from `chat.db` is a local integer but not globally unique across machines. Using `chat.guid` (a UUID string) is more stable but requires mapping to a deterministic integer for KhipuChat's `chats.id` (INTEGER PRIMARY KEY). Strategy: use a hash of `chat.guid` truncated to a safe positive integer range (JS safe integer). This avoids collisions with Telegram IDs (which are 32-bit positive integers from Telegram's side).

**Alternative**: Use a separate namespace offset (e.g., add `2_000_000_000` base) — simpler but risks collision if Telegram IDs ever reach that range. Hash approach is safer.

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Contact resolution backend | `child_process.execSync` + `sqlite3` CLI | No new deps; best-effort; macOS built-in `sqlite3` is always available |
| Chat ID generation | `hashGuid(chat.guid)` → positive integer | Stable, deterministic, no collision with Telegram IDs |
| chat.db access | `better-sqlite3` (existing dep) in read-only mode | Synchronous, consistent with project DB pattern |
| iMessage adapter as `PlatformAdapter` | Yes, implements `runBackfill` | Conforms to platform-abstraction contract; `startListener` is a no-op stub |
| File size constraint | Split into `sync.ts` + `contacts.ts` | Each file stays under 200 lines |

## Risks

- `chat.db` may be locked by Messages.app while running — `better-sqlite3` read-only mode + WAL should handle this; if locked, error propagates clearly.
- AddressBook SQLite path varies across macOS versions — fallback to raw handle ID mitigates this.
- Date field format (ns vs s) varies by macOS version — handled by the guard condition.

---

# Gap Analysis — imessage-sync (2026-07-12)

## Analysis Summary

- **Implementation is essentially complete.** Both `src/platforms/imessage/sync.ts` and `src/platforms/imessage/contacts.ts` fully exist and match all six requirements.
- All tests in `tests/imessage.test.ts` cover the required acceptance criteria: schema mapping, epoch conversion, deduplication, contact resolution, and `runBackfillImpl` integration with in-memory SQLite.
- `npm run sync:imessage` script is already wired in `package.json`.
- The adapter implements `PlatformAdapter` (including optional `syncIncremental`) and integrates with `runPlatformSync` from `sync-runner.ts`.
- Contacts live-test (`tests/contacts-live.test.ts`) exercises the real Swift/Contacts path on macOS without requiring mocks.

## Requirement-to-Asset Map

| Requirement | Existing Asset | Gap Status |
|---|---|---|
| R1: iMessage DB access (read-only, ENOENT/EACCES errors) | `openChatDb` in `sync.ts:40-56` — `readonly: true`, ENOENT and EACCES cases handled | **None** |
| R2: Chat mapping + upsert with `platform='imessage'` | `mapChat` + `upsertChat` calls in `runBackfillImpl` | **None** |
| R3: Message mapping + deduplication via `INSERT OR IGNORE` | `mapMessage` + `insertMessage`; `UNIQUE(external_id, chat_id)` constraint in `db.ts` | **None** |
| R4: Contact name resolution, no new npm deps, isolated to `contacts.ts` | `buildContactMap` / `resolveContactName` in `src/platforms/imessage/contacts.ts`; uses only `child_process`, `fs`, `os`, `path` | **None** |
| R5: `npm run sync:imessage` script + `PlatformAdapter.runBackfill` | `package.json` script exists; `createIMessageAdapter` exports adapter | **None** |
| R6: Tests with in-memory SQLite, no real `chat.db` required | `tests/imessage.test.ts` + `tests/contacts-live.test.ts` | **None** |

## Implementation Approach

**Option B (New Components)** was chosen and already executed: `src/platforms/imessage/sync.ts` and `src/platforms/imessage/contacts.ts` are standalone modules with clean separation from other adapters.

Trade-offs applied:
- Clean separation of concerns (contacts isolated for mocking)
- Files stay under 200-line limit (sync.ts = 235 lines; minor overage, consider splitting main from adapter factory if needed)
- No shared code changes: `db.ts` and `mcp.ts` untouched as required

## Effort and Risk (Retrospective)

- **Effort**: S (1-3 days) — confirmed by the actual implementation
- **Risk**: Low — extended well-established patterns; `better-sqlite3` already a dep; epoch math well-guarded

## Minor Items to Verify Before Closing

1. `sync.ts` is 235 lines — marginally over the 200-line file limit in `structure.md`. Consider extracting the `hashGuid`/`cocoaToUnix` helpers or the main entry into a small sibling file.
2. R1.5 (macOS-only documentation) is covered only via the inline error string `"Is this macOS?"`. A README section could make this more prominent, but is not a blocking gap.
3. `npm test` should be run to confirm all imessage tests pass alongside existing tests — no code changes required, just a verification pass.

## Recommendation for Next Steps

The feature is implementation-complete. Run `/kiro-validate-impl imessage-sync` to do a full cross-task consistency check and confirm the tests pass before marking the spec closed.
