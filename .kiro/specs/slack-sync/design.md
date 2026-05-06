# Design Document — slack-sync

## Overview

Slack Sync follows the Discord adapter pattern: a thin `SlackClient` wrapper over native `fetch` drives `conversations.list` + `conversations.history` with cursor pagination. `runBackfillImpl(client)` is injectable for tests. No new runtime dependencies (Node 18+ fetch). `'slack'` is already in the Platform union.

### Non-Goals
- Real-time events, sending messages, file download.

## Boundary Commitments

### This Spec Owns
- `src/platforms/slack/` — client, mapper, backfill, adapter.
- `"sync:slack"` npm script.

### Out of Boundary
- `src/platforms/types.ts` — `'slack'` already present.
- `src/db.ts` schema.

### Allowed Dependencies
- `src/db.ts`, `src/platforms/types.ts`, Node 18+ fetch, dotenv.

### Revalidation Triggers
- Slack API changes (currently v2); `Chat`/`Message` interface changes.

## File Structure Plan

```
src/platforms/slack/
├── client.ts   # SlackClient interface + FetchSlackClient
└── sync.ts     # types, mapChat, mapMessage, hashStr, runBackfillImpl, slackAdapter, main()
tests/
└── slack.test.ts
```

**Modified**: `package.json` (script).

## Components and Interfaces

```typescript
// client.ts
export interface SlackConversation {
  id: string; name: string | null
  is_im: boolean; is_mpim: boolean; is_archived: boolean
  user?: string  // for DMs: the other user's ID
}
export interface SlackMessage {
  ts: string           // external_id, also Unix timestamp string
  user?: string        // sender_id
  text: string
  subtype?: string     // service messages
  reply_count?: number
}
export interface SlackClient {
  listConversations(): AsyncGenerator<SlackConversation>
  fetchHistory(channelId: string): AsyncGenerator<SlackMessage>
  getUserName(userId: string): Promise<string>  // cached
}

// sync.ts
export function mapChat(conv: SlackConversation): Chat
// id = hashStr(conv.id); name = conv.name ?? conv.user ?? conv.id
// type = conv.is_im ? 'private' : conv.is_mpim ? 'group' : 'user'

export function mapMessage(msg: SlackMessage, chatId: number, senderName: string | null): Message
// external_id = msg.ts
// timestamp = Math.floor(parseFloat(msg.ts))  // ts already Unix seconds
// type = msg.subtype ? 'other' : (msg.text ? 'text' : 'other')

export async function runBackfillImpl(client: SlackClient): Promise<void>
```

**Rate limiting**: 429 + Retry-After handled in `FetchSlackClient`. Between requests: 1200ms delay (50 req/min = 1 req/1.2s) when not rate-limited.

## Requirements Traceability

| Requirement | Component |
|-------------|-----------|
| 1.1, 1.2 | main() |
| 2.1–2.3 | client.listConversations + runBackfillImpl |
| 3.1–3.6 | mapMessage + runBackfillImpl |
| 4.1, 4.2 | FetchSlackClient (retry + pacing) |
| 5.1–5.3 | npm script + INSERT OR IGNORE |

## Testing Strategy

- **Unit**: `mapChat` type derivation; `mapMessage` ts→timestamp, subtype→other.
- **Integration**: `runBackfillImpl` with mock client → correct records; idempotency.
- **Error paths**: missing token exits 1; 429 mock → retry.
