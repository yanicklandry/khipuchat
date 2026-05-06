# Design Document — email-sync

## Overview

Email Sync connects to an IMAP server via `imapflow`, fetches INBOX and Sent folders in batches of 200, maps each email to the shared schema, and resolves thread groups using `Message-ID` / `In-Reply-To` headers. `'email'` is added to the `Platform` union. The injectable `EmailClient` interface keeps tests free of real IMAP connections.

### Goals
- Sync both received and sent emails in one `npm run sync:email` run.
- Group replies into threads without a second DB pass.
- Handle large mailboxes (batch of 200) and out-of-order message delivery.

### Non-Goals
- HTML body rendering; attachments; calendar invites; IMAP IDLE.

## Boundary Commitments

### This Spec Owns
- `src/platforms/email/` — client interface, mapper, thread resolver, backfill runner, adapter.
- `'email'` addition to `Platform` union in `src/platforms/types.ts`.
- `"sync:email"` npm script; `imapflow` runtime dependency.

### Out of Boundary
- `src/db.ts` schema — consumed read-only.
- MCP tool changes.

### Allowed Dependencies
- `src/db.ts`, `src/platforms/types.ts`.
- `imapflow` (new runtime dependency).
- `dotenv`.

### Revalidation Triggers
- Changes to `Chat` or `Message` interfaces in `src/db.ts`.
- `Platform` union changes in `types.ts`.

## File Structure Plan

```
src/platforms/email/
├── client.ts   # EmailClient interface + ImapFlowClient implementation
└── sync.ts     # RawEmailMessage type, mapMessage, thread resolver, runBackfillImpl, emailAdapter, main()
tests/
└── email.test.ts
```

**Modified**: `src/platforms/types.ts` (add `'email'`), `package.json` (script + imapflow dep).

## Components and Interfaces

### Email Client (`client.ts`)

```typescript
export interface RawEmailMessage {
  messageId: string        // Message-ID header (without angle brackets)
  inReplyTo: string | null // In-Reply-To header value
  from: string             // Display name + address from From header
  subject: string
  date: Date
  text: string | null      // Plain-text body; null if not present
}

export interface EmailClient {
  fetchFolder(folder: string): AsyncGenerator<RawEmailMessage>
  listSpecialFolder(use: '\\Sent'): Promise<string | null>
}

export function createEmailClient(host: string, user: string, pass: string): EmailClient
// Uses imapflow; yields RawEmailMessage objects; batches internally.
```

### Thread Resolver and Mapper (`sync.ts`)

```typescript
export function hashStr(s: string): number  // FNV-1a (same as other adapters)

export function resolveThreadChatId(
  messageId: string,
  inReplyTo: string | null,
  threadMap: Map<string, number>,  // messageId → chatId (mutated)
): number
// If inReplyTo exists and is in threadMap: return that chatId.
// Otherwise: create new chatId = hashStr(messageId); add to map; return it.

export function mapMessage(raw: RawEmailMessage, chatId: number, userEmail: string): Message
// external_id: raw.messageId
// sender_name: display name parsed from raw.from
// is_sender: raw.from.includes(userEmail) ? 1 : 0
// text: raw.text
// type: raw.text ? 'text' : 'other'
// timestamp: Math.floor(raw.date.getTime() / 1000)
// reply_to_external_id: raw.inReplyTo

export async function runBackfillImpl(client: EmailClient, userEmail: string): Promise<void>
// Fetches INBOX, then Sent (via listSpecialFolder); resolves threads; upserts chats and messages.
```

**Chat record per thread root**: `upsertChat({ id: chatId, name: subject, type: 'user', platform: 'email' })` on first encounter of each root.

## Requirements Traceability

| Requirement | Component |
|-------------|-----------|
| 1.1, 1.2 | sync.ts main() |
| 2.1–2.3 | runBackfillImpl + client.ts batching |
| 3.1–3.6 | mapMessage + types.ts |
| 4.1–4.3 | resolveThreadChatId + upsertChat |
| 5.1–5.3 | npm script + INSERT OR IGNORE |

## Error Handling

| Error | Response |
|-------|----------|
| Missing env vars | List missing vars; exit 1 |
| Message with no Message-ID | Log warning; skip message |
| IMAP connection failure | Propagate error; exit 1 |
| Sent folder not found | Log warning; skip Sent folder; continue with INBOX |

## Testing Strategy

- **Unit**: `resolveThreadChatId` — root detection, reply lookup, unknown-parent creates new root; `mapMessage` — `is_sender` by email address, `type='other'` for null text, timestamp.
- **Integration**: `runBackfillImpl` with mock client yielding INBOX + Sent messages → correct thread grouping in archive DB; idempotency.
- **Error paths**: missing env vars → exit 1; message without `Message-ID` → skipped.
