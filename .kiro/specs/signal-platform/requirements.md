# Requirements Document

## Introduction

The signal-platform feature adds Signal as a supported messaging platform in KhipuChat. Because Signal Desktop's local database is encrypted with a key held in the OS keychain, direct local-DB ingestion is fragile and out of scope. Instead, Signal chats and text messages are ingested via Beeper Desktop, which already bridges Signal and exposes messages through a queryable interface. Once synced, Signal conversations are queryable through the existing MCP tools, CLI, and Web UI without any Signal-specific changes to those surfaces.

## Boundary Context

- **In scope**: Signal chat and text-message backfill and incremental sync via Beeper Desktop; `khipu sync signal` CLI command; graceful error behavior when Beeper Desktop is unavailable; Signal messages appearing in existing MCP tools without changes to those tools
- **Out of scope**: Signal image and attachment sync (separate `signal-image-sync` spec); ingestion of any platform other than Signal through Beeper (WhatsApp, Telegram, and iMessage have or will have native KhipuChat adapters and must not be dual-sourced); any changes to Beeper Desktop; real-time listener support unless a live-update mechanism is confirmed available
- **Adjacent expectations**: This feature depends on the `platform-abstraction` `PlatformAdapter` interface and the shared sync runner's backfill/incremental dispatch without modifying either. The `signal-image-sync` spec depends on this spec's chat and message records being present before it can run.

## Requirements

### Requirement 1: Signal Platform Registration

**Objective**: As an operator, I want Signal to be a recognized KhipuChat platform, so that I can sync and query Signal messages through the same surfaces as other platforms.

#### Acceptance Criteria

1. The KhipuChat Sync Service shall recognize `signal` as a valid platform name.
2. When the operator runs `khipu sync signal`, the KhipuChat Sync Service shall execute a Signal sync using the same backfill-or-incremental lifecycle as other platforms.
3. When the operator runs `khipu sync` (all-platform sync), the KhipuChat Sync Service shall include Signal in the set of platforms synced.

---

### Requirement 2: Beeper Desktop Connectivity

**Objective**: As an operator, I want the Signal adapter to retrieve messages through Beeper Desktop, so that Signal data is accessible without accessing the encrypted Signal Desktop database.

#### Acceptance Criteria

1. When the Signal adapter initiates a sync, the Signal Adapter shall retrieve Signal chats and messages through Beeper Desktop.
2. The Signal Adapter shall scope all Beeper queries to Signal chats only and shall not ingest messages from other platforms accessible through Beeper.
3. If Beeper Desktop is not reachable when a Signal sync is attempted, the Signal Adapter shall report a clear error identifying Beeper Desktop as the unavailable dependency and shall not crash.
4. If Beeper Desktop returns an error for a specific chat or message query, the Signal Adapter shall log the error and continue syncing remaining chats without aborting the entire sync.

---

### Requirement 3: Chat and Message Backfill

**Objective**: As an operator, I want a full backfill of Signal chats and message history on the first sync, so that historical Signal conversations are immediately available in the archive.

#### Acceptance Criteria

1. When a full backfill is triggered for Signal, the Signal Adapter shall retrieve all Signal chats accessible through Beeper and archive each as a Signal chat.
2. When a full backfill is triggered for Signal, the Signal Adapter shall retrieve text messages for each chat and archive them under the correct chat.
3. When the same backfill is run more than once, the Signal Adapter shall not create duplicate chat records for the same Signal chat.
4. When the same backfill is run more than once, the Signal Adapter shall not create duplicate message records for the same Signal message.

---

### Requirement 4: Incremental Sync

**Objective**: As an operator, I want incremental Signal syncs to fetch only new messages since the last sync, so that subsequent syncs are fast and do not re-process existing data.

#### Acceptance Criteria

1. When an incremental sync is triggered for Signal, the Signal Adapter shall retrieve only Signal messages newer than the last recorded sync point for each chat.
2. When the Signal Adapter successfully syncs a chat, it shall record the sync point so the next incremental sync starts from there.
3. While no prior sync record exists for a Signal chat, the Signal Adapter shall treat that chat as a first-time sync.

---

### Requirement 5: Message Content and Metadata

**Objective**: As an operator, I want Signal messages stored with accurate content and metadata, so that they are correctly attributed and fully searchable.

#### Acceptance Criteria

1. The Signal Adapter shall archive each Signal message with sender name, send timestamp, and platform `signal`.
2. The Signal Adapter shall record whether the operator is the sender of each message.
3. The Signal Adapter shall associate each message with its Signal chat.
4. When a Beeper message indicates it is a reply to another message, the Signal Adapter shall store the reply-to relationship.
5. The Signal Adapter shall archive only the text content of messages; image and attachment data are not archived by this feature.
6. If a Beeper message contains both text and an image or attachment, the Signal Adapter shall archive the text portion and omit the media reference.

---

### Requirement 6: Query Parity via Existing Surfaces

**Objective**: As an operator, I want Signal messages to be queryable through the existing MCP tools, CLI, and Web UI without Signal-specific changes to those surfaces, so that Signal is a first-class archive citizen.

#### Acceptance Criteria

1. When Signal messages have been synced, the KhipuChat MCP Server shall return Signal chats in `list_chats` results.
2. When Signal messages have been synced, the KhipuChat MCP Server shall return Signal chats in `find_chat_by_name` results.
3. When Signal messages have been synced, the KhipuChat MCP Server shall return Signal messages in `list_messages` and `search_messages` results for the relevant chat.
4. When Signal messages have been synced, the KhipuChat MCP Server shall include Signal message content in `get_chat_summary` results.
5. When Signal messages have been indexed, the KhipuChat Search Service shall include Signal messages in full-text and semantic search results.

---

### Requirement 7: Graceful Degradation

**Objective**: As an operator, I want the system to behave predictably when Beeper Desktop is unavailable, so that a missing runtime dependency does not break the broader sync process.

#### Acceptance Criteria

1. If Beeper Desktop is not running when a Signal sync is attempted, the Signal Adapter shall output a human-readable error identifying Beeper Desktop as the missing dependency.
2. If Beeper Desktop is not running during an all-platform sync, the KhipuChat Sync Service shall continue syncing other platforms.
3. If Beeper Desktop is not running when `khipu sync signal` is run explicitly, the KhipuChat Sync Service shall exit with a non-zero status code.
4. The KhipuChat Sync Service shall not produce an unhandled exception when the Signal adapter fails due to Beeper Desktop unavailability.
