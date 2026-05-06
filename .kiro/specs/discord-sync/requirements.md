# Requirements Document

## Introduction

Discord Sync fetches all DM channels and non-broadcast guild text channels accessible to the configured bot token, maps messages to the shared archive schema, and stores them under `platform = 'discord'`. The sync is idempotent, rate-limit-aware, and follows the platform adapter pattern.

## Boundary Context

- **In scope**: Discord REST API access (DMs + text channels), paginated message backfill, `DISCORD_TOKEN` env var, `npm run sync:discord`, deduplication by external_id, tests with mocked REST client.
- **Out of scope**: Discord Gateway WebSocket / real-time listener, guild server message sync beyond channels the bot is in, sending messages, media/attachment download, reaction sync.
- **Adjacent expectations**: `Platform` union in `src/platforms/types.ts` already contains `'discord'` — no type change required. Shared `upsertChat` / `insertMessage` DB functions consumed read-only.

## Requirements

### Requirement 1: Bot Token Configuration

**Objective:** As a user, I want to configure my Discord bot token via environment variable so that credentials are never hardcoded.

#### Acceptance Criteria

1. The Discord Sync shall read the bot token exclusively from the `DISCORD_TOKEN` environment variable.
2. If `DISCORD_TOKEN` is not set at startup, the Discord Sync shall exit with a clear error message instructing the user to set the variable in `.env`.

---

### Requirement 2: Channel Discovery

**Objective:** As a user, I want all accessible DM channels and joined text channels discovered automatically so I don't need to configure channel IDs manually.

#### Acceptance Criteria

1. When sync runs, the Discord Sync shall retrieve all DM channels accessible to the bot token.
2. When sync runs, the Discord Sync shall retrieve all text channels in guilds the bot has been added to.
3. The Discord Sync shall skip announcement, voice, forum, and other non-text channel types.

---

### Requirement 3: Message Backfill and Mapping

**Objective:** As a user, I want all messages from discovered channels fetched and stored in the archive so I can search them.

#### Acceptance Criteria

1. When processing a channel, the Discord Sync shall fetch all available messages using paginated requests until no more messages remain.
2. The Discord Sync shall map each message to the shared schema: message snowflake ID as `external_id`, author username as `sender_name`, author ID as `sender_id`, message content as `text`, ISO timestamp converted to Unix seconds, and reply reference if present.
3. The Discord Sync shall store all messages with `platform = 'discord'`.
4. The Discord Sync shall create one chat record per discovered channel.
5. If a message has no text content (e.g. an embed-only message), the Discord Sync shall store it with `type = 'other'` rather than skipping it.

---

### Requirement 4: Rate Limit Compliance

**Objective:** As a user, I want the sync to respect Discord's rate limits so that the bot token is not suspended.

#### Acceptance Criteria

1. When the Discord API returns a 429 Too Many Requests response, the Discord Sync shall wait for the duration indicated in the response before retrying.
2. The Discord Sync shall not exceed Discord's global rate limit of 50 requests per second under normal operation.

---

### Requirement 5: Idempotency and Sync Command

**Objective:** As a user, I want `npm run sync:discord` to be safe to run repeatedly without duplicating records.

#### Acceptance Criteria

1. The Discord Sync shall be executable via `npm run sync:discord`.
2. When run multiple times against the same channels, the Discord Sync shall not create duplicate message or chat records.
3. When new messages have arrived since the last run, the Discord Sync shall store only the new messages without modifying previously stored records.
