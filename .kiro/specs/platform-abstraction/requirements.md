# Requirements Document

## Introduction

KhipuChat is a self-hosted multi-platform message archive. The existing codebase was built Telegram-first: the `messages` table stores `telegram_id` as the sole external identifier, the `chats` table has no platform discriminator, and all sync logic lives in a single `sync.ts` file that couples Telegram concerns to the top-level module. The platform-abstraction feature generalizes the database schema, renames Telegram-specific identifiers, reorganizes source into per-platform modules, and makes MCP tool responses platform-aware — creating the necessary foundation for adding iMessage (and future platforms) without schema migration or code duplication.

## Boundary Context

- **In scope**: DB schema changes (`chats.platform`, `messages.platform`, rename `telegram_id` → `external_id`); DB function signature updates; moving `src/sync.ts` → `src/platforms/telegram/sync.ts`; creating `src/platforms/types.ts`; additive MCP changes (optional `platform?` param, `platform` field in responses); updating and extending tests.
- **Out of scope**: iMessage sync implementation; Discord/Slack/WhatsApp sync; new MCP tools; Web UI changes; migration tooling for existing deployed databases; changes to `.env` or configuration file format.
- **Adjacent expectations**: The `imessage-sync` spec depends on `chats.platform`, `messages.platform`, `messages.external_id`, and the `PlatformAdapter` interface being stable and exported by the time it begins. This spec must not break those contracts once written.

## Requirements

### Requirement 1: Platform Column on Chats and Messages

**Objective:** As a KhipuChat operator, I want every chat and message row to carry a `platform` field, so that records from different messaging services can coexist in the same database and be queried independently.

#### Acceptance Criteria

1. The KhipuChat database shall include a `platform` column on the `chats` table typed as `TEXT NOT NULL DEFAULT 'telegram'`.
2. The KhipuChat database shall include a `platform` column on the `messages` table typed as `TEXT NOT NULL DEFAULT 'telegram'`.
3. When a chat or message is inserted without an explicit `platform` value, the KhipuChat database shall store `'telegram'` as the default.
4. The KhipuChat system shall accept only the values `'telegram'`, `'imessage'`, `'discord'`, `'slack'`, and `'whatsapp'` as valid platform identifiers in TypeScript types; any other value shall not be assignable at compile time.
5. When the KhipuChat database schema is initialized, the KhipuChat system shall create both `platform` columns if they do not already exist.

### Requirement 2: Rename telegram_id to external_id

**Objective:** As a KhipuChat developer, I want the per-platform message identifier column to use a generic name (`external_id`), so that the schema is not coupled to Telegram's naming conventions and can represent identifiers from any platform without confusion.

#### Acceptance Criteria

1. The KhipuChat database shall store the platform-assigned message identifier in a column named `external_id` (not `telegram_id`).
2. When a message is inserted, the KhipuChat system shall accept `external_id` as the field name in the `Message` TypeScript interface.
3. When `getLastSyncedId` is called for a chat, the KhipuChat system shall return the `external_id` value of the most recent message for that chat.
4. The KhipuChat system shall maintain a `UNIQUE(external_id, chat_id)` constraint on the `messages` table so duplicate platform messages are silently ignored.
5. The `reply_to_telegram_id` column shall be renamed to `reply_to_external_id` in both the database schema and the `Message` interface.

### Requirement 3: Platform Adapter Interface

**Objective:** As a KhipuChat developer, I want a shared `PlatformAdapter` interface and `Platform` type exported from a central types module, so that all current and future platform sync implementations conform to a common contract without requiring runtime discovery.

#### Acceptance Criteria

1. The KhipuChat system shall export a `Platform` type union containing `'telegram' | 'imessage' | 'discord' | 'slack' | 'whatsapp'` from `src/platforms/types.ts`.
2. The KhipuChat system shall export a `PlatformAdapter` interface from `src/platforms/types.ts` that specifies the minimum contract each platform sync module must implement.
3. When a new file imports `Platform` or `PlatformAdapter`, the TypeScript compiler shall resolve the import from `src/platforms/types.ts` without errors.

### Requirement 4: Source Reorganization — Telegram Sync Module

**Objective:** As a KhipuChat developer, I want all Telegram-specific sync logic to live under `src/platforms/telegram/`, so that each platform owns its own directory and the top-level `src/` directory is not polluted with platform-specific files.

#### Acceptance Criteria

1. When the Telegram sync daemon starts, the KhipuChat system shall execute the same auth-wizard, backfill, and real-time listener behavior as before the reorganization.
2. The KhipuChat system shall resolve the Telegram sync entry point from `src/platforms/telegram/sync.ts`.
3. After the reorganization, no file at `src/sync.ts` shall exist.
4. All imports that previously referenced `src/sync.ts` shall be updated to reference the new path.

### Requirement 5: MCP Tool Platform Filter and Response Field

**Objective:** As a Claude Desktop user, I want MCP tools to accept an optional `platform` filter and to include a `platform` field in every response object, so that I can distinguish messages from different messaging services and optionally narrow queries to a single platform.

#### Acceptance Criteria

1. When `find_chat_by_name` is called with an optional `platform` parameter, the KhipuChat MCP server shall return only chats whose `platform` column matches the supplied value.
2. When `find_chat_by_name` is called without a `platform` parameter, the KhipuChat MCP server shall return chats from all platforms.
3. When `search_messages` is called with an optional `platform` parameter, the KhipuChat MCP server shall return only messages whose `platform` column matches the supplied value.
4. When `search_messages` is called without a `platform` parameter, the KhipuChat MCP server shall return messages from all platforms.
5. The KhipuChat MCP server shall include a `platform` field in every object returned by `find_chat_by_name`.
6. The KhipuChat MCP server shall include a `platform` field in every object returned by `search_messages`.
7. The KhipuChat MCP server shall include a `platform` field in every object returned by `list_messages`.
8. The KhipuChat MCP server shall include a `platform` field in every object returned by `get_chat_summary`.
9. The existing MCP tool names (`find_chat_by_name`, `list_messages`, `search_messages`, `get_chat_summary`) shall not change; the `platform` parameter and field are additive only.

### Requirement 6: Test Coverage

**Objective:** As a KhipuChat developer, I want all existing tests to pass after the schema and source changes, and new tests to verify platform filtering and renamed fields, so that regressions are caught automatically.

#### Acceptance Criteria

1. When `npm test` is run after the platform-abstraction changes are applied, all pre-existing tests shall pass without modification to their assertions.
2. The KhipuChat test suite shall include tests that verify `chats` rows include a `platform` field defaulting to `'telegram'`.
3. The KhipuChat test suite shall include tests that verify `messages` rows use `external_id` (not `telegram_id`) and include a `platform` field.
4. The KhipuChat test suite shall include tests that verify `find_chat_by_name` filters correctly when `platform` is supplied and returns results from all platforms when it is omitted.
5. The KhipuChat test suite shall include tests that verify `search_messages` filters correctly when `platform` is supplied and returns results from all platforms when it is omitted.
6. The KhipuChat test suite shall include a test that verifies `getLastSyncedId` returns the `external_id` of the most recent message.
