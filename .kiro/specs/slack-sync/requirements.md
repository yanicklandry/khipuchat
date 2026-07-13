# Requirements Document

## Introduction

Slack Sync fetches all DMs and joined channels via the Slack Web API using a personal user token, maps messages to the shared archive schema under `platform = 'slack'`, and is idempotent. `'slack'` is already in the Platform union.

## Boundary Context

- **In scope**: Slack Web API (`conversations.list`, `conversations.history`), cursor-based pagination, `SLACK_USER_TOKEN` env var, `npm run sync:slack`, deduplication by message timestamp, tests with mocked Slack API.
- **Out of scope**: Real-time event subscriptions, sending messages, file/attachment download, workspace admin features, slash commands.
- **Adjacent expectations**: `'slack'` is already in the `Platform` union -- no schema changes needed.

## Requirements

### Requirement 1: User Token Configuration

**Objective:** As a user, I want to configure my Slack user token via environment variable so that credentials are never hardcoded.

#### Acceptance Criteria

1. The Slack Sync shall read the Slack user token exclusively from the `SLACK_USER_TOKEN` environment variable.
2. If `SLACK_USER_TOKEN` is absent at startup, the Slack Sync shall exit with a clear error message.

---

### Requirement 2: Conversation Discovery

**Objective:** As a user, I want all my DMs and joined channels discovered automatically so I don't have to list them manually.

#### Acceptance Criteria

1. When sync runs, the Slack Sync shall discover all conversations the user is a member of, including DMs, group DMs, public channels, and private channels.
2. The Slack Sync shall retrieve all conversations without page limits.
3. The Slack Sync shall skip archived conversations.

---

### Requirement 3: Message Backfill

**Objective:** As a user, I want all messages from discovered conversations fetched and stored in the local archive.

#### Acceptance Criteria

1. When processing a conversation, the Slack Sync shall fetch all messages in that conversation without page limits.
2. The Slack Sync shall use each message's timestamp as a stable unique identifier for deduplication.
3. The Slack Sync shall store each message's sender identifier and resolve the display name where available.
4. If a message is a service or system message (e.g., a user joined the channel), the Slack Sync shall archive it with type `other` rather than discarding it.
5. The Slack Sync shall store all messages with `platform = 'slack'`.

---

### Requirement 4: Rate Limit Compliance

**Objective:** As a user, I want the sync to complete without triggering Slack API errors from over-requesting.

#### Acceptance Criteria

1. When the Slack API signals that the request rate is exceeded, the Slack Sync shall pause for the indicated back-off duration before retrying.
2. The Slack Sync shall not exceed Slack's published rate limit for history endpoints under normal operation.

---

### Requirement 5: Idempotency and Sync Command

**Objective:** As a user, I want to run the sync command repeatedly without creating duplicate records.

#### Acceptance Criteria

1. The Slack Sync shall be executable via `npm run sync:slack`.
2. When run multiple times, the Slack Sync shall not create duplicate records.
3. When new messages have arrived since the last sync, the Slack Sync shall store only the new messages.
