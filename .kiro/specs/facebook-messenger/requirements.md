# Requirements Document

## Introduction

The facebook-messenger feature adds Facebook Messenger as a supported messaging platform in KhipuChat. KhipuChat already archives Telegram, iMessage, Discord, Slack, WhatsApp, Signal, and email, but Messenger — a primary 1:1 and group chat channel for many users — is absent from the unified archive, search, and Claude/MCP queries. Because Facebook offers no privacy-preserving local ingestion path (the official Graph API does not expose personal DMs and unofficial scrapers risk account bans), Messenger chats and messages are ingested through Beeper Desktop, which already bridges Facebook Messenger and exposes messages through the same local `@beeper/desktop-api` surface the Signal adapter uses. This mirrors the proven `signal-platform` adapter with a different Beeper network filter. Once synced, Messenger conversations (text and images) are queryable through the existing MCP tools, CLI, and Web UI without any Messenger-specific changes to those surfaces.

## Boundary Context

- **In scope**: Facebook Messenger chat and message backfill and incremental sync (text and image messages, with OCR of image attachments) via Beeper Desktop; registration of a new `facebook` platform in every platform-enumeration point; `khipu sync facebook` and `khipu sync facebook@<account>` CLI commands and coverage by the `khipu sync all` daemon; graceful error behavior when Beeper Desktop or a connected Messenger account is unavailable; Messenger messages appearing in existing MCP tools, CLI, and Web UI without changes to those surfaces; single-account environment-variable configuration (`BEEPER_ACCESS_TOKEN`) working for Messenger.
- **Out of scope**: Sending Messenger messages; Instagram DMs; Facebook Groups, Pages, and Marketplace; reactions or threads richer than the existing message model; any non-Beeper transport (official Facebook Graph API or unofficial scrapers); changes to Beeper Desktop itself; real-time listener support.
- **Adjacent expectations**: This feature depends on the `platform-abstraction` `PlatformAdapter` interface, the shared `runPlatformSync` backfill/incremental runner, the `multi-account` account registry, and the shared image-storage + OCR pipeline (`storeMedia`, `extractText`) without modifying any of them. It is a near-identical sibling of `signal-platform`; the two adapters must stay consistent, including the single-account legacy environment-variable registry entry for `BEEPER_ACCESS_TOKEN`.

## Requirements

### Requirement 1: Facebook Messenger Platform Registration

**Objective:** As an operator, I want Facebook Messenger to be a recognized KhipuChat platform, so that I can sync and query Messenger messages through the same surfaces as every other platform.

#### Acceptance Criteria

1. The KhipuChat Sync Service shall recognize `facebook` as a valid platform name.
2. When the operator runs `khipu sync facebook`, the KhipuChat Sync Service shall execute a Messenger sync using the same backfill-or-incremental lifecycle as other platforms.
3. When the operator runs `khipu sync facebook@<account>`, the KhipuChat Sync Service shall execute a Messenger sync scoped to the named account.
4. When the operator runs `khipu sync` (all-platform sync), the KhipuChat Sync Service shall include Facebook Messenger in the set of platforms synced.
5. When the background sync daemon starts, the KhipuChat Sync Service shall poll Facebook Messenger like every other configured platform and shall skip it when its credentials are absent.
6. When the Web UI renders a Messenger chat or message, the KhipuChat Web UI shall display a Messenger platform badge.

---

### Requirement 2: Beeper Desktop Connectivity and Messenger Scoping

**Objective:** As an operator, I want the Facebook adapter to retrieve messages through Beeper Desktop scoped strictly to Messenger, so that Messenger data is accessible locally without any Facebook cloud API and without ingesting other bridged platforms.

#### Acceptance Criteria

1. When the Facebook adapter initiates a sync, the Facebook Adapter shall retrieve Messenger chats and messages through Beeper Desktop.
2. The Facebook Adapter shall scope all Beeper queries to Facebook Messenger accounts only, identified by Beeper's network identifier for Messenger, and shall not ingest messages from other platforms accessible through Beeper.
3. While no Messenger account is connected in Beeper Desktop, the Facebook Adapter shall complete as a clean no-op that writes no rows and reports that no Messenger account is connected, without raising an error.
4. If Beeper Desktop is not reachable when a Messenger sync is attempted, the Facebook Adapter shall report a clear error identifying Beeper Desktop as the unavailable dependency and shall not produce an unhandled exception.
5. If Beeper Desktop returns an error for a specific chat or message query, the Facebook Adapter shall log the error and continue syncing the remaining chats without aborting the entire sync.

---

### Requirement 3: Chat and Message Backfill

**Objective:** As an operator, I want a full backfill of Messenger chats and message history on the first sync, so that historical Messenger conversations are immediately available in the archive.

#### Acceptance Criteria

1. When a full backfill is triggered for Facebook Messenger, the Facebook Adapter shall retrieve all Messenger chats accessible through Beeper and archive each as a Messenger chat.
2. When a full backfill is triggered for Facebook Messenger, the Facebook Adapter shall retrieve text and image messages for each chat and archive them under the correct chat.
3. When the same backfill is run more than once, the Facebook Adapter shall not create duplicate chat records for the same Messenger chat.
4. When the same backfill is run more than once, the Facebook Adapter shall not create duplicate message records for the same Messenger message.

---

### Requirement 4: Incremental Sync

**Objective:** As an operator, I want incremental Messenger syncs to fetch only new messages since the last sync, so that subsequent syncs are fast and do not re-process existing data.

#### Acceptance Criteria

1. When an incremental sync is triggered for Facebook Messenger, the Facebook Adapter shall retrieve only Messenger messages newer than the last recorded sync point for each chat.
2. When the Facebook Adapter successfully completes a sync, the sync point shall be recorded so the next incremental sync starts from there.
3. While no prior sync record exists for a Messenger chat, the Facebook Adapter shall treat that chat as a first-time sync and fetch its full history.
4. When the operator runs a forced full re-read (`--force`), the Facebook Adapter shall re-read all Messenger chats and messages and trigger reindexing.

---

### Requirement 5: Message Content and Metadata

**Objective:** As an operator, I want Messenger messages stored with accurate content and metadata, so that they are correctly attributed and fully searchable.

#### Acceptance Criteria

1. The Facebook Adapter shall archive each Messenger message with sender name, send timestamp (converted to unix seconds), and platform `facebook`.
2. The Facebook Adapter shall record whether the operator is the sender of each message.
3. The Facebook Adapter shall associate each message with its Messenger chat.
4. When a Beeper message indicates it is a reply to another message, the Facebook Adapter shall store the reply-to relationship.
5. The Facebook Adapter shall classify each message as `text`, `image`, or `other` based on the Beeper message type and content.
6. When a Messenger message carries an image attachment, the Facebook Adapter shall download the image, store it in the shared media store, and record its local path and dimensions.
7. When an image attachment has been downloaded, the Facebook Adapter shall run OCR on it and store the extracted text so the image is discoverable through search.
8. If an image download or OCR step fails for a message, the Facebook Adapter shall record the failure and continue processing the remaining messages without aborting the sync.

---

### Requirement 6: Query Parity via Existing Surfaces

**Objective:** As an operator, I want Messenger messages to be queryable through the existing MCP tools, CLI, and Web UI without Messenger-specific changes to those surfaces, so that Messenger is a first-class archive citizen at parity with Signal.

#### Acceptance Criteria

1. When Messenger messages have been synced, the KhipuChat MCP Server shall return Messenger chats in `list_chats` and `find_chat_by_name` results.
2. When Messenger messages have been synced, the KhipuChat MCP Server shall return Messenger messages in `list_messages` and `search_messages` results for the relevant chat.
3. When Messenger messages have been synced, the KhipuChat CLI shall return Messenger chats and messages for the same filters available to the MCP surface.
4. When Messenger messages have been indexed, the KhipuChat Search Service shall include Messenger message text and image OCR text in full-text and semantic search results.
5. When the operator browses the Web UI, the KhipuChat Web UI shall list and display Messenger chats and messages alongside other platforms.

---

### Requirement 7: Graceful Degradation

**Objective:** As an operator, I want the system to behave predictably when Beeper Desktop or the Messenger credential is unavailable, so that a missing runtime dependency does not break the broader sync process.

#### Acceptance Criteria

1. If `BEEPER_ACCESS_TOKEN` is not set when a Messenger sync is attempted, the Facebook Adapter shall output a human-readable error identifying the missing credential and Beeper Desktop.
2. If Beeper Desktop is not running during an all-platform sync, the KhipuChat Sync Service shall continue syncing the other platforms.
3. If Beeper Desktop is not running when `khipu sync facebook` is run explicitly, the KhipuChat Sync Service shall exit with a non-zero status code.
4. The KhipuChat Sync Service shall not produce an unhandled exception when the Facebook adapter fails due to Beeper Desktop unavailability.

---

### Requirement 8: Single-Account Environment Configuration Consistency

**Objective:** As an operator running without a `khipu.config.json`, I want Messenger (and Signal) to sync from a single `BEEPER_ACCESS_TOKEN` environment variable, so that legacy single-account mode works consistently for every Beeper-backed platform.

#### Acceptance Criteria

1. While no `khipu.config.json` is present and `BEEPER_ACCESS_TOKEN` is set in the environment, the KhipuChat Account Registry shall synthesize a `default` Facebook Messenger account carrying that token.
2. While no `khipu.config.json` is present and `BEEPER_ACCESS_TOKEN` is set in the environment, the KhipuChat Account Registry shall synthesize a `default` Signal account carrying that token, so the two Beeper-backed platforms behave identically.
3. Where a `khipu.config.json` is present, the KhipuChat Account Registry shall resolve Messenger accounts and their `BEEPER_ACCESS_TOKEN` field from that config, consistent with all other platforms.
