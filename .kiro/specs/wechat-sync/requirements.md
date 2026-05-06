# Requirements Document

## Introduction

WeChat Sync reads the WeChat Mac app's local SQLite message databases, maps conversations and messages to the shared archive schema, and stores them under `platform = 'wechat'`. The sync is idempotent and follows the same structural pattern established by the iMessage adapter. macOS only; no cloud involvement; read-only access to WeChat files.

## Boundary Context

- **In scope**: Locating WeChat message database files, extracting text messages, resolving contact display names from the WeChat contacts database, storing records under `platform = 'wechat'`, providing `npm run sync:wechat`, surfacing Full Disk Access guidance on access errors, tests using in-memory mock databases, encrypted database handling with clear error messaging.
- **Out of scope**: Sending messages, media/image/audio extraction, WeChat Moments, WeChat Pay records, Windows WeChat support, changes to the MCP tool definitions, changes to the shared DB schema.
- **Adjacent expectations**: The shared platform-abstraction layer (`src/platforms/types.ts`) must recognise `'wechat'` as a valid platform value. The shared DB functions (`upsertChat`, `insertMessage`) and the `PlatformAdapter` interface are consumed by this feature, not owned by it. The MCP server's platform-scoped search will expose WeChat messages automatically once they are stored.

## Requirements

### Requirement 1: WeChat Database Discovery

**Objective:** As a user, I want the sync tool to automatically locate all WeChat message databases so that I do not need to manually configure any file paths.

#### Acceptance Criteria

1. When `sync:wechat` runs on macOS, the WeChat Sync shall locate all per-contact and per-group message database files under the WeChat Mac container directory (`~/Library/Containers/com.tencent.xinWeChat/`).
2. If the WeChat container directory does not exist at the expected path, the WeChat Sync shall exit with an error message stating that WeChat for Mac must be installed.
3. If access to the WeChat container directory is denied by the OS, the WeChat Sync shall display a human-readable message instructing the user to grant Full Disk Access to Terminal in System Settings → Privacy & Security, and then exit with a non-zero status code.
4. If an individual message database file cannot be opened, the WeChat Sync shall log a warning identifying the file and continue processing the remaining files.

---

### Requirement 2: Message Extraction and Mapping

**Objective:** As a user, I want all WeChat text messages extracted and stored in the shared archive so that I can search and retrieve them alongside messages from other platforms.

#### Acceptance Criteria

1. When processing each discovered message database file, the WeChat Sync shall extract all message records it contains.
2. The WeChat Sync shall map each message to the shared message schema, preserving: a unique message identifier, timestamp in Unix seconds, message text content, and message direction (sent vs. received).
3. The WeChat Sync shall store all extracted messages with `platform = 'wechat'` in the shared messages table.
4. The WeChat Sync shall create one chat record per discovered message database file using a stable identifier derived from the file.
5. If a message record has no text content (e.g., a media-only or unsupported-type message), the WeChat Sync shall store it with message type `other` rather than omitting it.

---

### Requirement 3: Contact Name Resolution

**Objective:** As a user, I want conversations and sender names displayed as human-readable names rather than internal identifiers so that I can understand who sent each message.

#### Acceptance Criteria

1. When resolving names, the WeChat Sync shall read contact display names from the WeChat contacts database located in the WeChat container directory.
2. If the contacts database is unavailable or unreadable, the WeChat Sync shall fall back to using the raw contact identifier as the display name rather than failing.
3. The WeChat Sync shall use the resolved display name as the `sender_name` on each message and as the `name` on each direct-message chat record.

---

### Requirement 4: Sync Command and Idempotency

**Objective:** As a user, I want `npm run sync:wechat` to be safe to run repeatedly so that I can re-run it as new messages arrive without producing duplicate records.

#### Acceptance Criteria

1. The WeChat Sync shall be executable via `npm run sync:wechat`.
2. When `sync:wechat` is run multiple times against the same databases, the WeChat Sync shall not create duplicate message or chat records.
3. When new messages have arrived since the last sync, the WeChat Sync shall store only the new messages without modifying or deleting previously stored records.
4. When `sync:wechat` completes successfully, the WeChat Sync shall have stored messages that are queryable via the existing MCP search tools using `platform = 'wechat'` as a filter.

---

### Requirement 5: Encrypted Database Handling

**Objective:** As a user, I want the sync tool to attempt to open encrypted WeChat databases and to clearly report when it cannot, so that I am never left wondering why data is missing.

#### Acceptance Criteria

1. Where WeChat message databases are encrypted, the WeChat Sync shall attempt to open them using a decryption key derived locally from the user's WeChat installation, without transmitting any key material or credential to any external service or network endpoint.
2. If a database cannot be opened because decryption fails, the WeChat Sync shall display a clear message identifying the affected file and explaining that the locally derived key could not decrypt it.
3. The WeChat Sync shall never write to or modify any WeChat database file.
