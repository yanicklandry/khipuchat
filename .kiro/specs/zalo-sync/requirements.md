# Requirements Document

## Introduction

Zalo is the dominant messaging app in Vietnam. KhipuChat is a self-hosted, local-only message archive that already ingests nine platforms (telegram, imessage, discord, slack, whatsapp, email, signal, facebook) through the shared `PlatformAdapter` contract. A user with significant Zalo conversation history currently has no way to archive it into KhipuChat, leaving a blind spot in a tool whose whole premise is a unified local archive.

This feature adds a new `zalo` platform adapter built on the unofficial `zca-js` library, using a QR-code Zalo Web session. Once a Zalo direct-message conversation is captured, it becomes visible through the archive's existing surfaces (MCP, CLI, web, FTS, and semantic search) exactly like any other platform, with no changes required to those surfaces.

**Deliberately bounded fidelity.** `zca-js` is a live/listener-oriented client. It surfaces new messages through an event listener (`api.listener.on('message')`) and, when the listener connects, delivers a shallow **recent window** of undelivered messages as a per-account event stream. It does not expose a reliable per-thread full-history export. Therefore this feature delivers **authoritative live capture plus best-effort recent-window backfill**, NOT a complete historical mirror of past Zalo conversations. This limitation is a first-class requirement (Requirement 4) and must be surfaced to the user, not hidden.

## Boundary Context

- **In scope**: A `zalo` platform adapter (`src/platforms/zalo/`) covering QR-code session login with session persistence; live capture of direct-message (1:1) conversations via the message listener; best-effort recent-window backfill of messages delivered by the listener on connect; mapping Zalo threads and messages onto the shared `Chat`/`Message` model; ingestion through existing `src/db.ts` functions; registration of `zalo` across every platform-enumeration touchpoint; and tests that run entirely against a mocked `zca-js` client.
- **Out of scope**: Sending messages of any kind; Zalo groups and Official Account (OA) broadcast channels; complete deep-history export (not reliably retrievable via `zca-js`); image/attachment download and OCR (deferred to a future `zalo-image-sync` spec, reusing the shared media-storage + OCR pipeline); and any guarantee of account-ban safety.
- **Adjacent expectations**: The feature depends on the existing platform-abstraction (`PlatformAdapter` interface, `Platform` union), `src/db.ts` ingestion functions, the account registry, and the shared sync runner/watch daemon. It expects those to remain unchanged in contract. It does NOT own the database schema, the query surfaces (MCP/CLI/web), or the media pipeline, and must integrate without modifying them.

## Requirements

### Requirement 1: Zalo platform registration

**Objective:** As a KhipuChat operator, I want `zalo` recognized as a first-class platform everywhere platforms are enumerated, so that I can sync and query Zalo alongside every other platform through the same commands and surfaces.

#### Acceptance Criteria
1. The system shall recognize `zalo` as a valid value of the platform identifier used across chats, messages, sync state, and query filters.
2. When the operator runs the single-platform sync command for `zalo`, the system shall dispatch to the Zalo adapter.
3. When the operator runs the all-platform sync (daemon or single pass), the system shall include `zalo` in the set of platforms it iterates.
4. When the operator runs the account-scoped sync command for `zalo` with an account name, the system shall dispatch to the Zalo adapter for that account.
5. While no Zalo session credentials are available, the all-platform sync shall skip `zalo` with a human-readable "not configured" notice and continue with other platforms.
6. Where the web UI renders a platform badge, the system shall display a Zalo badge for chats and messages whose platform is `zalo`.

### Requirement 2: QR-code session login and persistence

**Objective:** As a Zalo user, I want to authenticate KhipuChat to my Zalo account by scanning a QR code once, so that subsequent syncs reconnect without re-scanning.

#### Acceptance Criteria
1. When a Zalo sync starts and no valid saved session exists, the system shall display a QR code in the terminal and wait for the user to scan it with the Zalo mobile app.
2. When the user successfully scans the QR code, the system shall establish an authenticated Zalo Web session and report success to the terminal.
3. When a Zalo session is successfully established, the system shall persist the session credentials to a local session location so that later syncs can reconnect without a new QR scan.
4. While a valid saved session exists, the system shall reconnect using the saved session and shall NOT display a QR code.
5. If the saved session is invalid or rejected by Zalo, the system shall report an actionable error instructing the user to remove the saved session and re-scan, and shall exit with a non-zero status for the explicit single-platform command.
6. The system shall store session credentials only on the local machine and shall never transmit them to any destination other than Zalo's own servers.

### Requirement 3: Live direct-message capture

**Objective:** As a Zalo user, I want my incoming and outgoing direct messages captured into the archive as they occur, so that my Zalo conversations accumulate locally like every other platform.

#### Acceptance Criteria
1. While a Zalo session is active, the system shall listen for message events from Zalo and process each direct-message event.
2. When a direct-message event is received, the system shall upsert the corresponding conversation and insert the message into the archive under platform `zalo`.
3. When a message event represents a group or Official Account (OA) conversation, the system shall ignore it and shall not insert it into the archive.
4. When a captured message is authored by the logged-in user, the system shall record it as a sent message; otherwise it shall record it as received with the sender's display name.
5. When the same message is delivered more than once (for example, replayed on reconnect), the system shall not create a duplicate archive entry for it.
6. When a message event carries non-text content (for example, an image, sticker, or attachment), the system shall record the message with a non-text type and shall not fail the capture session.
7. While capturing, the system shall persist each conversation's sync progress so that the shared incremental-sync machinery records that Zalo was synced.

### Requirement 4: Bounded fidelity and best-effort backfill

**Objective:** As a Zalo user, I want a clear and honest statement of what history is and is not retrievable, so that I do not mistake the archive for a complete mirror of my Zalo past.

#### Acceptance Criteria
1. When a Zalo session connects, the system shall capture the recent window of messages that Zalo delivers on connect as a best-effort backfill.
2. The system shall NOT attempt to retrieve complete per-thread message history, because `zca-js` does not reliably expose it.
3. Where a Zalo sync runs, the system shall communicate (in terminal output and project documentation) that Zalo capture is live plus best-effort recent-window only, not a full historical export.
4. When a backfilled message falls outside the requested incremental window (older than the last recorded sync point), the incremental sync path shall skip it so that only newer messages are added on incremental runs.

### Requirement 5: Message and conversation mapping

**Objective:** As a KhipuChat maintainer, I want Zalo threads and messages mapped onto the shared `Chat`/`Message` model consistently, so that Zalo data behaves identically to other platforms in queries and search.

#### Acceptance Criteria
1. When mapping a Zalo direct-message conversation, the system shall produce a chat record with the platform-native thread identifier as its external id, the contact's display name as its name, a private conversation type, and platform `zalo`.
2. When mapping a Zalo message, the system shall produce a message record with the platform-native message identifier as its external id, the conversation's archive id, the message text (when the content is textual), a Unix-second timestamp, a sent/received flag, and platform `zalo`.
3. When a message is authored by the logged-in user, the system shall record no sender id or sender name for it; otherwise it shall record the sender's platform id and display name.
4. When a message's content is textual, the system shall classify its type as text; otherwise it shall classify it as a non-text type.
5. The message and conversation mapping functions shall be pure (no input/output and no dependence on a live session) so they can be unit-tested without a Zalo login.

### Requirement 6: Query-surface parity

**Objective:** As a user of the archive, I want Zalo conversations to be queryable through every existing surface, so that Zalo has full parity with other platforms without new surface code.

#### Acceptance Criteria
1. When Zalo messages exist in the archive, the MCP chat-listing and message-listing tools shall return Zalo chats and messages, including when filtered by platform `zalo`.
2. When Zalo messages exist in the archive, full-text search shall return matching Zalo messages.
3. When Zalo messages have been indexed, semantic search shall be able to return Zalo chats and messages.
4. When the operator uses the CLI with a platform filter of `zalo`, the CLI shall return Zalo results consistent with the MCP surface.
5. The feature shall achieve query-surface parity without modifying MCP tool logic, CLI query logic, or web query logic.

### Requirement 7: Resilience and error handling

**Objective:** As an operator running unattended syncs, I want Zalo failures to be isolated and clearly reported, so that a Zalo problem never corrupts the archive or halts other platforms.

#### Acceptance Criteria
1. If the Zalo session fails to authenticate or the connection drops, the system shall report an actionable error naming Zalo and shall not leave a partially written duplicate state.
2. When the Zalo adapter runs under the all-platform daemon and encounters an error, the system shall log the error for `zalo` and continue polling the other platforms.
3. When the Zalo adapter runs as the explicit single-platform command and encounters a fatal error, the system shall exit with a non-zero status.
4. If processing a single message event fails, the system shall log the failure and continue capturing subsequent messages rather than aborting the whole session.
5. The system shall surface, in Zalo error output, that `zca-js` is an unofficial client that may break on Zalo updates and carries account-lock risk.

### Requirement 8: Local-only credential configuration

**Objective:** As a privacy-conscious operator, I want Zalo to require no cloud credentials and to be treated as a locally configured platform, so that it fits KhipuChat's self-hosted, local-only model.

#### Acceptance Criteria
1. The system shall treat `zalo` as a locally configured platform that requires no cloud API token to be considered configured, consistent with the existing QR-session platform.
2. While no account configuration file is present, the account registry shall expose a single default Zalo account so that legacy single-account installs work without configuration.
3. Where an optional session-location setting is provided, the system shall use it to locate and persist the Zalo session; otherwise it shall use a default local location.
