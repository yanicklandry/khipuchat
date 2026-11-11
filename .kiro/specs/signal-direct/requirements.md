# Requirements Document

## Introduction

The signal-direct feature adds a second, Beeper-independent backend for archiving Signal in KhipuChat. Today the Signal adapter reaches Signal only through Beeper Desktop (`@beeper/desktop-api`, `BEEPER_ACCESS_TOKEN`); operators who do not run Beeper — or who do not want a third-party bridge in the loop — cannot archive Signal at all. This feature lets an operator link KhipuChat to their Signal account as a **secondary device** by driving `signal-cli` (AsamK) in daemon / JSON-RPC mode as a separate local process, then ingesting Signal chats and messages (text and images) into the same `chats`/`messages` tables and shared media/OCR pipeline that every other platform uses. A backend selector chooses between the existing Beeper path and the new signal-cli path, so both remain usable and the existing Beeper adapter keeps working unchanged.

The most important scoping constraint is a hard property of Signal's protocol, not a KhipuChat choice: a linked secondary device authoritatively receives messages only **from link-time forward**. Any pre-link back-history is best-effort and unverified, and encrypted media older than **45 days** is deleted server-side and cannot be recovered through linking. Requirements below make live-forward the guarantee and treat backlog recovery as an explicitly unverified, out-of-guarantee concern deferred to a future spec.

## Boundary Context

- **In scope**: A signal-cli-backed Signal backend selectable via an operator-facing backend selector alongside the existing Beeper backend; lifecycle management of and JSON-RPC connectivity to a separately-running `signal-cli` daemon over a local socket; a secondary-device linking flow that surfaces the `sgnl://linkdevice` URI/QR for the operator to scan and persists the resulting link across runs; ingestion of live Signal chats and messages (text and images, with OCR) from link-time forward into the existing `chats`/`messages` tables; incremental draining of messages queued since the last sync; graceful, non-fatal behavior when the daemon is unavailable or not yet linked; Signal (signal-cli backend) messages appearing in the existing MCP, CLI, and Web UI surfaces without changes to those surfaces.
- **Out of scope**: Sending Signal messages; a complete pre-link back-history import (a separate future spec — the local-backup / `signalbackup-tools` parser); recovery of encrypted media older than 45 days; embedding, vendoring, or source-linking `signal-cli` (it stays an arm's-length separate GPLv3 process invoked over IPC); a from-scratch libsignal client; installing or managing the `signal-cli` binary and its JVM runtime (a documented operator prerequisite, not automated by this feature); changes to the shared schema, media-storage, or OCR modules; any change to the existing Beeper-backed Signal behavior.
- **Adjacent expectations**: This feature depends on the `platform-abstraction` `PlatformAdapter` interface, the shared `runPlatformSync` backfill/incremental runner, the `multi-account` account registry, and the shared image-storage + OCR pipeline (`storeMedia`, `extractText`) without modifying any of them. It reuses the `signal-platform` mapping/ingestion conventions (chat and message shape, dedup semantics, `signal` platform name) so that data produced by either backend is indistinguishable to the query surfaces. The `signal-cli` daemon is an external process that must already be installed and reachable; this feature owns connecting to and driving it, not installing it.

## Requirements

### Requirement 1: Signal Backend Selection

**Objective:** As an operator, I want to choose whether Signal is synced through Beeper or through signal-cli, so that I can archive Signal without running Beeper while existing Beeper users are unaffected.

#### Acceptance Criteria

1. The KhipuChat Sync Service shall support two selectable Signal backends: the existing Beeper Desktop backend and the signal-cli backend.
2. Where no backend is explicitly selected, the KhipuChat Sync Service shall default to the existing Beeper Desktop backend so that current behavior is preserved.
3. When the operator selects the signal-cli backend, the KhipuChat Sync Service shall perform Signal sync through signal-cli and shall not require `BEEPER_ACCESS_TOKEN`.
4. When the operator selects the Beeper backend, the KhipuChat Sync Service shall perform Signal sync through Beeper Desktop exactly as it does today.
5. The KhipuChat Sync Service shall record both backends' output under the same `signal` platform so that a chat or message is queried identically regardless of which backend produced it.
6. While either backend is selected, the KhipuChat Sync Service shall continue to run all other platforms unaffected.

---

### Requirement 2: signal-cli Daemon Connectivity and Lifecycle

**Objective:** As an operator, I want the signal-cli backend to drive a separately-running signal-cli daemon over a local socket, so that Signal data is retrieved locally without any cloud bridge and without embedding signal-cli in KhipuChat.

#### Acceptance Criteria

1. When the signal-cli backend starts a sync, the Signal CLI Adapter shall communicate with a `signal-cli` daemon over a local socket using newline-delimited JSON-RPC.
2. The Signal CLI Adapter shall treat `signal-cli` as a separate external process invoked only over the socket and shall not link, embed, or import its source.
3. If the `signal-cli` daemon is not reachable when a sync is attempted, the Signal CLI Adapter shall report a clear error identifying the signal-cli daemon as the unavailable dependency and shall not produce an unhandled exception.
4. If the `signal-cli` binary or its runtime is not installed, the Signal CLI Adapter shall report a human-readable error that names the missing prerequisite and points to setup guidance, rather than failing obscurely.
5. When a JSON-RPC request fails or the socket connection drops mid-sync, the Signal CLI Adapter shall surface the failure without corrupting already-ingested data and shall allow a later sync to resume.
6. When a sync completes or is interrupted, the Signal CLI Adapter shall release the socket connection it opened without leaving the connection open.

---

### Requirement 3: Secondary-Device Linking

**Objective:** As an operator, I want to link KhipuChat to my Signal account by scanning a QR code, so that I can archive my Signal messages without owning a dedicated phone number for KhipuChat.

#### Acceptance Criteria

1. When the operator initiates linking and no device is yet linked, the Signal CLI Adapter shall obtain a `sgnl://linkdevice` device-link URI from signal-cli and present it to the operator as both the raw URI and a scannable QR code.
2. The Signal CLI Adapter shall link as a secondary device to the operator's existing Signal account and shall not require registering or owning a phone number.
3. When the operator scans the presented QR code with their Signal app and approves the link, the Signal CLI Adapter shall report that linking succeeded and record that the device is linked.
4. While a device is already linked, the Signal CLI Adapter shall reuse the existing link on subsequent syncs and shall not prompt the operator to re-scan.
5. If the operator does not complete the scan within the linking window, the Signal CLI Adapter shall report that linking timed out and shall exit without ingesting messages.
6. If linking is rejected or fails, the Signal CLI Adapter shall report the failure clearly and shall not record a linked device.

---

### Requirement 4: Live Message Ingestion From Link-Time Forward

**Objective:** As an operator, I want Signal messages received after linking to be archived, so that my ongoing Signal conversations are captured in the unified archive.

#### Acceptance Criteria

1. When a Signal message is delivered to the linked device after link time, the Signal CLI Adapter shall archive it under the correct Signal chat.
2. The Signal CLI Adapter shall archive both messages the operator sends from any of their devices and messages the operator receives, attributing sender identity and sent-vs-received direction correctly.
3. The Signal CLI Adapter shall archive each message with its sender name, send timestamp converted to unix seconds, and platform `signal`.
4. The Signal CLI Adapter shall classify each message as `text`, `image`, or `other` based on its content.
5. When a message indicates it is a reply to another message, the Signal CLI Adapter shall store the reply-to relationship.
6. When a message belongs to a group conversation, the Signal CLI Adapter shall associate it with the corresponding group chat; when it belongs to a one-to-one conversation, it shall associate it with that direct chat.

---

### Requirement 5: Chat Records and Ingestion Consistency

**Objective:** As an operator, I want signal-cli-sourced chats and messages stored using the same conventions as the Beeper backend, so that Signal data is consistent and free of duplicates regardless of backend.

#### Acceptance Criteria

1. The Signal CLI Adapter shall create a chat record for each direct and group conversation it observes, recording a stable identifier, a display name, and whether it is a private or group chat.
2. When the same chat is observed across multiple syncs, the Signal CLI Adapter shall not create duplicate chat records for it.
3. When the same message is observed more than once, the Signal CLI Adapter shall not create duplicate message records for it.
4. The Signal CLI Adapter shall ingest chats and messages using the same `chats`/`messages` conventions as the existing Beeper Signal backend so that either backend's output is indistinguishable to the query surfaces.
5. If a message cannot be associated with a known chat, the Signal CLI Adapter shall record enough chat context to still file the message under a coherent Signal chat rather than dropping it silently.

---

### Requirement 6: Image Attachment Ingestion and OCR

**Objective:** As an operator, I want Signal image attachments archived and made searchable, so that images shared on Signal are discoverable alongside text.

#### Acceptance Criteria

1. When a Signal message carries an image attachment that signal-cli has decrypted locally, the Signal CLI Adapter shall store the image in the shared media store and record its local path and, when available, its dimensions.
2. When an image attachment has been stored, the Signal CLI Adapter shall run OCR on it and store the extracted text so the image is discoverable through search.
3. The Signal CLI Adapter shall reuse the shared media-storage and OCR pipeline without modifying it.
4. If an image attachment cannot be downloaded, stored, or OCR-processed, the Signal CLI Adapter shall record the failure and continue processing the remaining messages without aborting the sync.
5. If an image attachment is unavailable because it has expired server-side (older than 45 days), the Signal CLI Adapter shall archive the message record without the image and shall not treat the missing media as a sync failure.

---

### Requirement 7: Sync Scope Guarantee and Backlog Limitation

**Objective:** As an operator, I want the guaranteed scope of signal-cli sync stated explicitly, so that I understand what is and is not captured and do not assume a complete history import.

#### Acceptance Criteria

1. The Signal CLI Adapter shall guarantee authoritative capture only for messages delivered to the linked device from link time forward.
2. The Signal CLI Adapter shall treat any pre-link back-history it receives at link time as best-effort and unverified, and shall not represent it as a guaranteed complete history.
3. The Signal CLI Adapter shall not guarantee recovery of encrypted media older than 45 days, because such media is deleted server-side and is unrecoverable through device linking.
4. Where signal-cli delivers pre-link history at link time, the Signal CLI Adapter shall ingest whatever it receives using the same conventions as live messages, without claiming completeness.
5. The Signal CLI Adapter shall not attempt to import a complete pre-link back-history from local Signal backups; that capability is explicitly deferred to a separate future spec.

---

### Requirement 8: Incremental Sync and Sync State

**Objective:** As an operator, I want repeated signal-cli syncs to ingest only messages queued since the last successful sync, so that syncs are fast and do not reprocess existing data.

#### Acceptance Criteria

1. When an incremental sync is triggered, the Signal CLI Adapter shall ingest only Signal messages queued for the linked device since the last recorded sync point.
2. When the Signal CLI Adapter successfully completes a sync, the sync point shall be recorded so the next incremental sync starts from there.
3. While no prior sync record exists, the Signal CLI Adapter shall treat the run as a first-time sync and ingest whatever the daemon delivers on connect.
4. When the operator runs a forced full re-read (`--force`), the Signal CLI Adapter shall re-ingest the messages the daemon can currently deliver and trigger reindexing.
5. When the background sync daemon polls Signal on the signal-cli backend, the Signal CLI Adapter shall ingest the messages the daemon delivers on each poll cycle via a bounded incremental drain (the daemon calls `syncIncremental`, not a continuous listener), so live-from-link-forward messages are captured across successive polls.

---

### Requirement 9: Query Parity via Existing Surfaces

**Objective:** As an operator, I want signal-cli-synced Signal messages queryable through the existing MCP tools, CLI, and Web UI without surface changes, so that Signal is a first-class archive citizen regardless of backend.

#### Acceptance Criteria

1. When Signal messages have been synced via signal-cli, the KhipuChat MCP Server shall return those chats in `list_chats` and `find_chat_by_name` results.
2. When Signal messages have been synced via signal-cli, the KhipuChat MCP Server shall return those messages in `list_messages` and `search_messages` results for the relevant chat.
3. When Signal messages have been synced via signal-cli, the KhipuChat CLI shall return those chats and messages for the same filters available to the MCP surface.
4. When Signal messages and image OCR text have been indexed, the KhipuChat Search Service shall include them in full-text and semantic search results.
5. When the operator browses the Web UI, the KhipuChat Web UI shall list and display signal-cli-synced Signal chats and messages with a Signal platform badge, alongside other platforms.

---

### Requirement 10: Graceful Degradation

**Objective:** As an operator, I want predictable behavior when signal-cli is unavailable or unlinked, so that a missing Signal dependency does not break the broader sync process.

#### Acceptance Criteria

1. If the signal-cli backend is selected but no device is yet linked, the Signal CLI Adapter shall guide the operator to complete linking rather than failing obscurely, and shall not write partial or corrupt data.
2. If the signal-cli daemon is not running during an all-platform sync, the KhipuChat Sync Service shall continue syncing the other platforms.
3. If the signal-cli daemon is not running when a single Signal sync is run explicitly, the KhipuChat Sync Service shall exit with a non-zero status code.
4. The KhipuChat Sync Service shall not produce an unhandled exception when the Signal CLI Adapter fails due to signal-cli unavailability.
5. While no messages are queued for the linked device, the Signal CLI Adapter shall complete as a clean no-op that writes no rows and reports that there was nothing new, without raising an error.

---

### Requirement 11: Test Coverage With Mocked Transport

**Objective:** As a maintainer, I want the signal-cli backend tested against a mocked JSON-RPC transport, so that behavior is verified deterministically without a real signal-cli daemon or Signal account.

#### Acceptance Criteria

1. The signal-direct test suite shall exercise the adapter against a mocked JSON-RPC transport and shall not require a running `signal-cli` daemon or a live Signal account.
2. The signal-direct test suite shall verify message and chat mapping, deduplication, direction attribution, and message-type classification from representative envelope fixtures.
3. The signal-direct test suite shall verify graceful behavior when the transport reports the daemon unreachable, not linked, or returning an error.
4. The signal-direct test suite shall verify that selecting the signal-cli backend does not alter the existing Beeper backend's behavior.
