# Research & Design Decisions

**Feature**: `email-sync`
**Discovery Scope**: Extension — new platform adapter using imapflow

**Key Findings**:
- `imapflow` provides a clean async API: `client.connect()`, `client.getMailboxLock(path)`, `client.fetch(range, { envelope: true, bodyStructure: true, source: true })` with UID-based ranges.
- `Message-ID` header is the natural deduplication key (external_id). `In-Reply-To` provides the parent link.
- Thread root identification: messages with no `In-Reply-To` header (or whose `In-Reply-To` value is not in the local DB) are thread roots; they own the chat record.
- `'email'` is NOT currently in the Platform union — must be added to `src/platforms/types.ts`.
- Chat ID: `hashStr(threadRootMessageId)` — stable, matches iMessage/WeChat/Discord pattern.

## Design Decisions

### Decision: Two-phase thread resolution
- Phase 1: fetch all messages from both folders, store all as individual records with `reply_to_external_id`.
- Phase 2: assign `chat_id` — group by thread root via a `Map<messageId, chatId>` built during insertion.
- Thread root detection: if `In-Reply-To` is absent, the message IS the root (`chatId = hashStr(messageId)`). If present, look up parent's chatId in the map; if parent not seen yet, treat this message as a new root (handles out-of-order fetch).
- This approach avoids a second DB pass and handles partial syncs correctly.

### Decision: imapflow UID range batching
- Use `'1:*'` range with `{ uid: true }` to get all UIDs, then slice into batches of 200.
- `imapflow`'s `client.fetch()` accepts a UID set or range string.

### Decision: Injectable IMAP client for testing
```typescript
interface EmailClient {
  fetchFolder(folder: string): AsyncIterable<RawEmailMessage>
}
```
Tests provide a mock returning fixture `RawEmailMessage` objects — no real IMAP connection in tests.

## Risks & Mitigations
- **Sent folder name varies** (Sent, Sent Items, Sent Messages): try common names; fall back to listing mailboxes and finding a folder with `\Sent` special-use flag.
- **Large mailboxes**: batch of 200 messages; memory is bounded.
- **Message-ID absent**: rare but possible; skip the message and log a warning.
