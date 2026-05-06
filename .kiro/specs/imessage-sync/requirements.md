# Requirements Document

## Introduction

KhipuChat is a self-hosted multi-platform message archive with an MCP server. iMessage history is stored in `~/Library/Messages/chat.db` on every Mac, but KhipuChat currently has no way to read it — users must manually query SQLite or use third-party tools to access their iMessage conversations through Claude. The imessage-sync feature implements a one-shot import command (`npm run sync:imessage`) that reads `chat.db`, maps chats and messages to KhipuChat's generic schema (adding `platform='imessage'` to every row), resolves phone numbers and email handles to display names, and inserts them idempotently so that MCP tools (`find_chat_by_name`, `list_messages`, `search_messages`, `get_chat_summary`) immediately return iMessage conversations alongside Telegram ones.

## Boundary Context

- **In scope**: Reading `~/Library/Messages/chat.db` (SQLite, no auth); mapping `chat`, `handle`, and `message` tables to `upsertChat` + `insertMessage` from `src/db.ts`; resolving phone/email handles to display names with raw number/email as fallback; Full Disk Access permission error detection and clear error messaging; adding `sync:imessage` npm script; tests covering schema mapping, deduplication, and name resolution.
- **Out of scope**: Sending iMessages; attachment or media sync; real-time iMessage listener; address book write-back; any changes to `src/db.ts` or `src/mcp.ts` (owned by platform-abstraction); Telegram sync changes.
- **Adjacent expectations**: This spec depends on platform-abstraction being complete — specifically `chats.platform`, `messages.platform`, `messages.external_id`, `upsertChat`, `insertMessage`, and the `PlatformAdapter` interface exported from `src/platforms/types.ts`. The Web UI (future phase) will use the `platform` field already present in DB rows written by this feature.

## Requirements

### Requirement 1: iMessage Database Access

**Objective:** As a KhipuChat operator, I want the sync command to read `~/Library/Messages/chat.db` directly without authentication, so that I can import my iMessage history without installing third-party agents or granting API credentials.

#### Acceptance Criteria

1. When `npm run sync:imessage` is executed on macOS, the KhipuChat system shall open `~/Library/Messages/chat.db` using the synchronous SQLite API.
2. When `~/Library/Messages/chat.db` is not readable due to missing Full Disk Access permission, the KhipuChat system shall print a human-readable error message explaining that Full Disk Access must be granted to the terminal application in System Settings, then exit with a non-zero code.
3. When `~/Library/Messages/chat.db` does not exist at the expected path, the KhipuChat system shall print a clear error message stating the expected file path and exit with a non-zero code.
4. The KhipuChat system shall open `chat.db` in read-only mode so that the Messages application's live data is never modified.
5. Where the feature is macOS-only, the KhipuChat system shall document this constraint clearly (in a README section or inline error message) so that operators on other platforms understand why the command is unavailable.

### Requirement 2: Chat Mapping and Upsert

**Objective:** As a KhipuChat operator, I want iMessage conversations to appear as chats in KhipuChat's database with `platform='imessage'`, so that MCP tools can list and query them alongside Telegram chats.

#### Acceptance Criteria

1. When sync runs, the KhipuChat system shall map each row in `chat.db`'s `chat` table to a `Chat` object and call `upsertChat` for it with `platform: 'imessage'`.
2. The KhipuChat system shall derive the chat name from the resolved display names of its participants (handles), falling back to the raw handle identifier when no display name is available.
3. The KhipuChat system shall set `chat.type` to `'group'` when the chat has more than one participant handle, and `'private'` when it has exactly one participant handle.
4. When `upsertChat` is called for an iMessage chat that already exists in the KhipuChat database, the KhipuChat system shall update it without creating a duplicate row (idempotent upsert via `chats.id` conflict).
5. The KhipuChat system shall use the `chat.guid` field from `chat.db` as the basis for a stable, unique chat identifier in the KhipuChat database.

### Requirement 3: Message Mapping and Deduplication

**Objective:** As a KhipuChat operator, I want iMessage messages to be stored in KhipuChat's database with `platform='imessage'` and be deduplicated on re-runs, so that I can re-run the sync command without creating duplicate messages.

#### Acceptance Criteria

1. When sync runs, the KhipuChat system shall map each row in `chat.db`'s `message` table to a `Message` object and call `insertMessage` for it with `platform: 'imessage'`.
2. The KhipuChat system shall use the iMessage `message.guid` as the `external_id` value so that each message has a stable, globally unique identifier.
3. When `insertMessage` is called for a message whose `(external_id, chat_id)` pair already exists in the KhipuChat database, the KhipuChat system shall silently ignore the duplicate (rely on the `UNIQUE(external_id, chat_id)` constraint with `INSERT OR IGNORE`).
4. The KhipuChat system shall set `message.is_sender` to `1` when the iMessage `is_from_me` field is `1`, and `0` otherwise.
5. The KhipuChat system shall convert iMessage's `date` field (nanoseconds since 2001-01-01 Apple epoch) to a Unix timestamp in seconds before storing it.
6. The KhipuChat system shall set `message.type` to `'text'` for messages with non-empty body text, and `'other'` for messages with null or empty body.
7. When a message has a `reply_to_guid`, the KhipuChat system shall store it in `reply_to_external_id`.

### Requirement 4: Contact Name Resolution

**Objective:** As a KhipuChat operator, I want iMessage handle identifiers (phone numbers and email addresses) to be resolved to human-readable display names, so that chat names and sender names are recognizable rather than showing raw phone numbers.

#### Acceptance Criteria

1. When sync runs, the KhipuChat system shall attempt to resolve each `handle.id` (phone number or email) to a display name using macOS address book data.
2. When a display name cannot be resolved for a handle, the KhipuChat system shall use the raw `handle.id` value (phone number or email) as the fallback display name.
3. The KhipuChat system shall perform contact resolution without requiring any npm packages beyond those already present in the project; it shall use Node.js built-ins or system command invocation as necessary.
4. The KhipuChat system shall isolate contact resolution logic in `src/platforms/imessage/contacts.ts` so that it can be mocked independently in tests.
5. When contact resolution fails entirely (e.g., address book inaccessible), the KhipuChat system shall fall back gracefully to raw handle identifiers for all contacts without aborting the sync.

### Requirement 5: Sync Entry Point and Script

**Objective:** As a KhipuChat operator, I want a `npm run sync:imessage` command that imports all iMessage history into KhipuChat, so that I can trigger the import from the command line without writing code.

#### Acceptance Criteria

1. When `npm run sync:imessage` is executed, the KhipuChat system shall import all chats and messages from `~/Library/Messages/chat.db` into the KhipuChat database.
2. When the sync completes successfully, the KhipuChat system shall print a summary indicating the number of chats and messages imported.
3. The KhipuChat system shall implement the iMessage sync module as a `PlatformAdapter` from `src/platforms/types.ts`, exposing at minimum a `runBackfill` method.
4. The `sync:imessage` script shall be defined in `package.json` and invoke `src/platforms/imessage/sync.ts` via `tsx`.
5. When `npm run sync:imessage` is run multiple times, each run shall complete without error and without creating duplicate chats or messages.

### Requirement 6: Test Coverage

**Objective:** As a KhipuChat developer, I want automated tests that cover schema mapping, deduplication, and contact name resolution for the iMessage sync, so that regressions are caught without requiring a live `chat.db`.

#### Acceptance Criteria

1. The KhipuChat test suite shall include tests that verify iMessage `chat` rows are correctly mapped to `Chat` objects with `platform: 'imessage'`.
2. The KhipuChat test suite shall include tests that verify iMessage `message` rows are correctly mapped to `Message` objects, including Apple epoch conversion and `external_id` assignment.
3. The KhipuChat test suite shall include a test that verifies re-running the sync with the same data does not create duplicate messages.
4. The KhipuChat test suite shall include tests that verify contact resolution returns a display name when found and falls back to the raw handle identifier when not found.
5. The KhipuChat test suite shall mock `~/Library/Messages/chat.db` access using an in-memory SQLite database so that tests do not depend on a real macOS Messages installation.
6. When `npm test` is run, all imessage-sync tests shall pass alongside all pre-existing tests without modification to existing test assertions.
