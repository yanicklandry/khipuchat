# Requirements Document

## Introduction

Email Sync connects to an IMAP mailbox, fetches all messages from the INBOX and Sent folders, maps them to the shared archive schema under `platform = 'email'`, and groups replies into threads using standard email headers. The sync is one-shot and idempotent.

## Boundary Context

- **In scope**: IMAP connection via imapflow, INBOX + Sent folder sync, `Message-ID` deduplication, `In-Reply-To` thread linking, plain-text body extraction, `EMAIL_IMAP_HOST` / `EMAIL_IMAP_USER` / `EMAIL_IMAP_PASS` env vars, `npm run sync:email`, batch pagination (200 messages), tests with mocked IMAP client.
- **Out of scope**: Sending email, HTML body rendering (store plain text only; skip messages with no plain-text part), attachment download, calendar invite handling, real-time IMAP IDLE, `'email'` addition to Platform union in types.ts (owned here).
- **Adjacent expectations**: `src/db.ts` consumed read-only; `src/platforms/types.ts` must be updated to add `'email'` to the `Platform` union.

## Requirements

### Requirement 1: IMAP Credentials Configuration

**Objective:** As a user, I want to configure IMAP credentials via environment variables so that credentials are never hardcoded.

#### Acceptance Criteria

1. The Email Sync shall read IMAP credentials exclusively from `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, and `EMAIL_IMAP_PASS` environment variables.
2. If any of the three required environment variables is absent at startup, the Email Sync shall exit with a clear error message listing which variables are missing.

---

### Requirement 2: Folder Sync

**Objective:** As a user, I want both received (INBOX) and sent email messages synced so that full conversation context is available.

#### Acceptance Criteria

1. When sync runs, the Email Sync shall fetch all messages from the INBOX folder.
2. When sync runs, the Email Sync shall fetch all messages from the Sent folder (or its equivalent on the server).
3. The Email Sync shall process messages in batches of at most 200 at a time to handle large mailboxes without exhausting memory.

---

### Requirement 3: Message Mapping

**Objective:** As a user, I want each email stored with the correct fields so that sender, subject, body, and thread relationships are preserved.

#### Acceptance Criteria

1. The Email Sync shall use the `Message-ID` header value as `external_id`.
2. The Email Sync shall store the display name from the `From` header as `sender_name`.
3. The Email Sync shall store the plain-text body as `text`; if a message has no plain-text part, the Email Sync shall skip it without error.
4. The Email Sync shall store the `In-Reply-To` header value as `reply_to_external_id` when present.
5. The Email Sync shall store all messages with `platform = 'email'`.
6. Messages originating from the configured user's email address (`EMAIL_IMAP_USER`) shall have `is_sender = 1`; all others shall have `is_sender = 0`.

---

### Requirement 4: Thread Grouping

**Objective:** As a user, I want email replies grouped so I can trace conversation threads in the archive.

#### Acceptance Criteria

1. The Email Sync shall store one chat record per unique email thread root (the original message with no `In-Reply-To`).
2. All replies in the same thread shall be stored under the same `chat_id`.
3. The chat name shall be derived from the email subject of the thread root.

---

### Requirement 5: Idempotency and Sync Command

**Objective:** As a user, I want `npm run sync:email` to be safe to run repeatedly without duplicating records.

#### Acceptance Criteria

1. The Email Sync shall be executable via `npm run sync:email`.
2. When run multiple times against the same mailbox, the Email Sync shall not create duplicate message records.
3. When new emails have arrived since the last sync, the Email Sync shall store only the new messages.
