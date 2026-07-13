# Requirements Document

## Introduction

Discord Sync fetches all DM channels, group DM channels, and non-broadcast guild text channels accessible to a configured bot token, maps messages to the shared archive schema, and stores them under `platform = 'discord'`. The sync is idempotent, rate-limit-aware, supports incremental updates, and follows the platform adapter pattern. Multiple Discord accounts may be configured.

## Boundary Context

- **In scope**: Discord REST API access (DMs + group DMs + guild text channels), paginated message backfill, incremental sync from last sync point, `DISCORD_TOKEN` env var and multi-account config, `khipu sync discord`, deduplication by platform-assigned message ID, reply thread linking.
- **Out of scope**: Discord Gateway WebSocket / real-time listener, guild channels the bot has not been added to, sending messages, media/attachment download, reaction sync.
- **Adjacent expectations**: `Platform` union in `src/platforms/types.ts` already contains `'discord'`. Shared `upsertChat` / `insertMessage` DB functions are consumed but not modified. `AccountRegistry` provides credentials for each configured account. Archived Discord messages are queryable via the same MCP and CLI surfaces as other platforms, with no Discord-specific query tooling required.

## Requirements

### Requirement 1: Bot Token Configuration

**Objective:** As a user, I want to configure my Discord bot token via environment variable or config file so that credentials are never hardcoded.

#### Acceptance Criteria

1. The Discord Sync shall read the bot token from the `DISCORD_TOKEN` environment variable when no multi-account config is present.
2. If `DISCORD_TOKEN` is not set and no account is configured, the Discord Sync shall exit with a clear error message instructing the user to set the variable.
3. Where multiple Discord accounts are configured in `khipu.config.json`, the Discord Sync shall read each account's token from the config and process them independently.

---

### Requirement 2: Channel Discovery

**Objective:** As a user, I want all accessible DM channels, group DM channels, and joined guild text channels discovered automatically so I don't need to configure channel IDs manually.

#### Acceptance Criteria

1. When sync runs, the Discord Sync shall retrieve all DM channels accessible to the bot token.
2. When sync runs, the Discord Sync shall retrieve all group DM channels accessible to the bot token.
3. When sync runs, the Discord Sync shall retrieve all text channels in guilds the bot has been added to.
4. The Discord Sync shall skip announcement, voice, forum, and other non-text channel types.

---

### Requirement 3: Message Backfill and Mapping

**Objective:** As a user, I want all messages from discovered channels fetched and stored in the archive so I can search them.

#### Acceptance Criteria

1. When processing a channel, the Discord Sync shall fetch all available messages using paginated requests until no more messages remain.
2. The Discord Sync shall map each message to the archive schema, capturing: the platform-assigned message identifier for deduplication, author display name and user identifier, message text, and timestamp.
3. When a message is a reply to another message, the Discord Sync shall store the referenced message's identifier so that the reply relationship is preserved in the archive.
4. The Discord Sync shall store all messages under the `discord` platform so that they can be filtered by platform in queries.
5. The Discord Sync shall create one chat record per discovered channel.
6. If a message has no text content (e.g. an embed-only message), the Discord Sync shall store it with a non-text type rather than skipping it.

---

### Requirement 4: Rate Limit Compliance

**Objective:** As a user, I want the sync to respect Discord's rate limits so that the bot token is not suspended.

#### Acceptance Criteria

1. When the Discord API returns a 429 Too Many Requests response, the Discord Sync shall wait for the duration indicated in the response before retrying.
2. The Discord Sync shall not exceed Discord's global rate limit of 50 requests per second under normal operation.

---

### Requirement 5: Incremental Sync and Sync Command

**Objective:** As a user, I want `khipu sync discord` to be safe to run repeatedly and to fetch only new messages after the first run.

#### Acceptance Criteria

1. The Discord Sync shall be executable via `khipu sync discord`.
2. When run multiple times against the same channels, the Discord Sync shall not create duplicate message or chat records.
3. When run after a prior successful sync, the Discord Sync shall fetch only messages newer than the last sync point without re-fetching previously stored messages.
4. When run with the `--force` flag, the Discord Sync shall perform a full re-read of all messages regardless of prior sync state.

---

### Requirement 6: Multi-Account Support

**Objective:** As a user, I want to configure multiple Discord accounts so that messages from all of them are archived.

#### Acceptance Criteria

1. Where multiple Discord accounts are configured, the Discord Sync shall process each account independently.
2. The Discord Sync shall store each account's messages with a distinct account identifier so that messages from different accounts can be distinguished.
3. When sync runs for multiple accounts, the Discord Sync shall maintain independent sync state per account so that a failure on one account does not affect others.
