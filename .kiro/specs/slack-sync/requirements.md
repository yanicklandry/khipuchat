# Requirements Document

## Introduction

Slack Sync fetches all DMs and joined channels via the Slack Web API using a personal user token, maps messages to the shared archive schema under `platform = 'slack'`, and is idempotent. `'slack'` is already in the Platform union.

## Boundary Context

- **In scope**: Slack Web API (`conversations.list`, `conversations.history`), cursor-based pagination, `SLACK_USER_TOKEN` env var, `npm run sync:slack`, deduplication via message `ts` as `external_id`, tests with mocked Slack API.
- **Out of scope**: Real-time event subscriptions, sending messages, file/attachment download, workspace admin features, slash commands.
- **Adjacent expectations**: `'slack'` is already in `Platform` union — no types.ts change needed.

## Requirements

### Requirement 1: User Token Configuration

**Objective:** As a user, I want to configure my Slack user token via environment variable so that credentials are never hardcoded.

#### Acceptance Criteria

1. The Slack Sync shall read the token exclusively from `SLACK_USER_TOKEN`.
2. If `SLACK_USER_TOKEN` is absent at startup, the Slack Sync shall exit with a clear error message.

---

### Requirement 2: Conversation Discovery

**Objective:** As a user, I want all DMs and joined channels discovered automatically.

#### Acceptance Criteria

1. When sync runs, the Slack Sync shall list all conversations the user is a member of using `conversations.list` with types `im,mpim,public_channel,private_channel`.
2. The Slack Sync shall paginate `conversations.list` results using the `next_cursor` field until all conversations are retrieved.
3. The Slack Sync shall skip archived conversations.

---

### Requirement 3: Message Backfill

**Objective:** As a user, I want all messages from discovered conversations fetched and stored.

#### Acceptance Criteria

1. When processing a conversation, the Slack Sync shall fetch all messages using `conversations.history` with cursor-based pagination until no more messages remain.
2. The Slack Sync shall use the message `ts` field as `external_id`.
3. The Slack Sync shall convert `ts` (Unix timestamp string, e.g. `"1512085950.000216"`) to an integer Unix timestamp in seconds.
4. The Slack Sync shall store the `user` field as `sender_id` and resolve the display name where available.
5. If a message has `subtype` set (service messages), the Slack Sync shall store it with `type = 'other'` rather than skipping it.
6. The Slack Sync shall store all messages with `platform = 'slack'`.

---

### Requirement 4: Rate Limit Compliance

**Objective:** As a user, I want the sync to respect Slack's rate limits.

#### Acceptance Criteria

1. When the Slack API returns a `429` response, the Slack Sync shall wait for the duration in the `Retry-After` header before retrying.
2. The Slack Sync shall not exceed Slack's Tier 3 rate limit (~50 requests/minute for history endpoints) under normal operation.

---

### Requirement 5: Idempotency and Sync Command

#### Acceptance Criteria

1. The Slack Sync shall be executable via `npm run sync:slack`.
2. When run multiple times, the Slack Sync shall not create duplicate records.
3. When new messages have arrived, the Slack Sync shall store only the new messages.
