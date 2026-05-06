# Design Document — discord-sync

## Overview

Discord Sync fetches DM and guild text channels via the Discord REST API and maps messages into the shared archive. It follows the Telegram adapter pattern: an injectable `DiscordClient` interface wraps native `fetch` calls; `runBackfillImpl(client)` drives the pagination loop; `discordAdapter` implements `PlatformAdapter`. No new runtime dependencies are needed (Node 18+ `fetch`). `'discord'` is already in the `Platform` union.

### Goals
- Backfill all DM and text-channel messages accessible to the configured bot token.
- Respect Discord rate limits; never hard-fail on a 429.
- Zero new runtime dependencies.

### Non-Goals
- Real-time Gateway listener.
- Sending messages.
- Media/embed download.
- Guild channels the bot has not been invited to.

## Boundary Commitments

### This Spec Owns
- `src/platforms/discord/` — client wrapper, mapper, backfill runner, adapter, entry point.
- `"sync:discord"` script in `package.json`.

### Out of Boundary
- `src/platforms/types.ts` — `'discord'` already present; no change.
- `src/db.ts` — consumed read-only.
- MCP tool changes.

### Allowed Dependencies
- `src/db.ts` — `upsertChat`, `insertMessage`, `initDb`.
- `src/platforms/types.ts` — `Platform`, `PlatformAdapter`.
- Node 18+ built-in `fetch`.
- `dotenv` (already in project).

### Revalidation Triggers
- Discord API version changes (currently v10).
- `Chat` or `Message` interface changes in `src/db.ts`.

## File Structure Plan

```
src/platforms/discord/
├── client.ts   # DiscordClient interface + FetchDiscordClient implementation
└── sync.ts     # Row types, mapChat, mapMessage, runBackfillImpl, discordAdapter, main()
tests/
└── discord.test.ts
```

**Modified**: `package.json` — add `"sync:discord"` script.

## Components and Interfaces

### Discord Client (`client.ts`)

```typescript
export interface DiscordChannel {
  id: string
  type: number          // 1=DM, 3=GroupDM, 0=GuildText
  name: string | null
  recipients?: Array<{ id: string; username: string }>
}

export interface DiscordMessage {
  id: string            // snowflake → external_id
  content: string
  author: { id: string; username: string }
  timestamp: string     // ISO 8601
  message_reference?: { message_id: string }
  type: number          // 0=DEFAULT; skip others for text content
}

export interface DiscordClient {
  getGuilds(): Promise<Array<{ id: string }>>
  getGuildChannels(guildId: string): Promise<DiscordChannel[]>
  getDirectMessageChannels(): Promise<DiscordChannel[]>
  getMessages(channelId: string, before?: string): Promise<DiscordMessage[]>
}

export function createDiscordClient(token: string): DiscordClient
// Wraps globalThis.fetch; sets Authorization: Bot {token} header.
// On 429: reads Retry-After header, awaits delay, retries once.
// Throws on non-2xx responses other than 429.
```

### Row Mappers and Backfill (`sync.ts`)

```typescript
export function mapChat(channel: DiscordChannel): Chat
// name: channel.name ?? recipients[0].username ?? channel.id
// type: channel.type === 0 ? 'user' : (recipients.length > 1 ? 'group' : 'private')
// platform: 'discord'
// id: hashStr(channel.id)  — FNV-1a applied to snowflake string

export function mapMessage(msg: DiscordMessage, chatId: number): Message
// external_id: msg.id
// timestamp: Math.floor(Date.parse(msg.timestamp) / 1000)
// text: msg.content || null
// type: msg.content ? 'text' : 'other'
// is_sender: 0  (bot receives; cannot determine "is current user" with bot token)
// reply_to_external_id: msg.message_reference?.message_id ?? null

export async function runBackfillImpl(client: DiscordClient): Promise<void>
// Discovers channels, paginates messages with `before` cursor, upserts all records.
```

**Idempotency**: `insertMessage` uses `INSERT OR IGNORE` on `UNIQUE(external_id, chat_id)`.

**Pagination stop**: continue fetching `before={oldest_message_id}` until response has fewer than 100 messages.

## Requirements Traceability

| Requirement | Component | Notes |
|-------------|-----------|-------|
| 1.1, 1.2 | sync.ts main() | Read `DISCORD_TOKEN`; exit with message if missing |
| 2.1–2.3 | client.ts + runBackfillImpl | getDirectMessageChannels + getGuildChannels; filter type |
| 3.1–3.5 | runBackfillImpl + mapMessage | Pagination loop; mapping; INSERT OR IGNORE |
| 4.1, 4.2 | client.ts | 429 retry; request pacing |
| 5.1–5.3 | sync.ts + db.ts | npm script; idempotency via INSERT OR IGNORE |

## Error Handling

| Error | Response |
|-------|----------|
| Missing `DISCORD_TOKEN` | stderr message; exit 1 |
| 429 response | Wait `Retry-After` seconds; retry |
| Other non-2xx | Throw; runBackfillImpl catches per-channel; logs warning; continues |

## Testing Strategy

- **Unit**: `mapChat` name/type derivation; `mapMessage` timestamp conversion, `is_sender`, `type=other` for empty content.
- **Integration**: `runBackfillImpl` with mock `DiscordClient` returning 2 channels, fixture messages → correct DB records; idempotency (run twice = no duplicates).
- **Error paths**: mock 429 response → client retries; missing token → exit 1.
