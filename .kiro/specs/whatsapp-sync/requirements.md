# Requirements Document

## Introduction

WhatsApp Sync uses `whatsapp-web.js` to launch a headless WhatsApp Web session, fetch all DM and group chats, map messages to the shared archive schema under `platform = 'whatsapp'`, and store them. Session is persisted after the initial QR scan. `'whatsapp'` is already in the Platform union.

## Boundary Context

- **In scope**: `whatsapp-web.js` client, QR code display on first run, session persistence via `WHATSAPP_SESSION` env var, `npm run sync:whatsapp`, deduplication via `message.id._serialized`, tests with mocked client.
- **Out of scope**: Sending messages, media download, WhatsApp Business API, real-time listener beyond initial session.
- **Risk accepted**: `whatsapp-web.js` is an unofficial library that may break on WhatsApp updates. This risk is documented.
- **Adjacent expectations**: `'whatsapp'` is already in `Platform` union — no types.ts change.

## Requirements

### Requirement 1: Session Management

**Objective:** As a user, I want to authenticate once via QR code and have my session saved so I don't need to re-scan every time.

#### Acceptance Criteria

1. When `WHATSAPP_SESSION` is not set, the WhatsApp Sync shall display a QR code in the terminal and wait for the user to scan it.
2. After a successful QR scan, the WhatsApp Sync shall write the session string to a file or output it with instructions for setting `WHATSAPP_SESSION` in `.env`.
3. When `WHATSAPP_SESSION` is set, the WhatsApp Sync shall restore the session without requiring a QR scan.
4. If the session is expired or invalid, the WhatsApp Sync shall fall back to QR code display with a clear message that re-authentication is required.

---

### Requirement 2: Chat Discovery

**Objective:** As a user, I want all DM and group chats fetched automatically.

#### Acceptance Criteria

1. When the session is ready, the WhatsApp Sync shall retrieve all chats the user is a member of.
2. The WhatsApp Sync shall include both individual (DM) and group chats.

---

### Requirement 3: Message Backfill

**Objective:** As a user, I want all messages from each chat stored in the archive.

#### Acceptance Criteria

1. When processing a chat, the WhatsApp Sync shall fetch all available messages for that chat.
2. The WhatsApp Sync shall use `message.id._serialized` as `external_id`.
3. The WhatsApp Sync shall store the message author's push name or contact name as `sender_name`.
4. The WhatsApp Sync shall store all messages with `platform = 'whatsapp'`.
5. If a message has no text body (e.g. a media message), the WhatsApp Sync shall store it with `type = 'other'`.
6. The WhatsApp Sync shall set `is_sender = 1` for messages sent by the authenticated user.

---

### Requirement 4: Unofficial API Risk Documentation

**Objective:** As an operator, I want the risk of using an unofficial API clearly surfaced so I understand the stability trade-off.

#### Acceptance Criteria

1. If the WhatsApp client fails to connect or throws an unrecognised error, the WhatsApp Sync shall log a message noting that `whatsapp-web.js` may have broken due to a WhatsApp update and pointing to the project's GitHub for updates.

---

### Requirement 5: Idempotency and Sync Command

#### Acceptance Criteria

1. The WhatsApp Sync shall be executable via `npm run sync:whatsapp`.
2. When run multiple times, the WhatsApp Sync shall not create duplicate records.
3. When new messages have arrived, the WhatsApp Sync shall store only the new messages.
