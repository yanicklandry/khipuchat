# Design Document: discord-sync

## Overview

Discord Sync fetches DM and guild text channels via the Discord REST API and maps messages into the shared archive under `platform = 'discord'`. It follows the platform adapter pattern: an injectable `DiscordClient` interface wraps native `fetch`; `runBackfillImpl` / `runIncrementalImpl` drive the pagination loops; `createDiscordAdapter` produces a `PlatformAdapter` that `runPlatformSync` orchestrates. No new runtime dependencies are needed (Node 18+ `fetch`). `'discord'` is already in the `Platform` union.

### Goals
- Backfill all DM and text-channel messages accessible to the configured bot token.
- Support incremental re-sync (only messages newer than the last run) without duplicating records.
- Respect Discord rate limits; never hard-fail on a single 429.
- Zero new runtime dependencies.

### Non-Goals
- Real-time Gateway listener (`startListener` is a no-op).
- Sending messages.
- Media / embed / attachment download.
- Guild channels the bot has not been invited to.

## Boundary Commitments

### This Spec Owns
- `src/platforms/discord/client.ts`: `DiscordClient` interface + `createDiscordClient` fetch implementation.
- `src/platforms/discord/sync.ts`: row mappers, backfill/incremental runners, adapter factory, entry point.
- `"sync:discord"` script in `package.json`.

### Out of Boundary
- `src/platforms/types.ts`: `'discord'` and `PlatformAdapter` already present; consumed read-only.
- `src/db.ts`, `src/sync-runner.ts`, `src/account-registry.ts`, `src/vec-db.ts`, `src/index-embeddings.ts`: consumed read-only.
- MCP / CLI / Web UI tool changes.

### Allowed Dependencies
- `src/db.ts`: `initDb`, `upsertChat`, `insertMessage`, types `Chat`, `Message`.
- `src/sync-runner.ts`: `runPlatformSync` (backfill-vs-incremental orchestration + last-synced bookkeeping).
- `src/account-registry.ts`: `AccountCredentials`.
- `src/vec-db.ts`: `isIndexed`; `src/index-embeddings.ts`: `embedNewMessages`, `embedNewChats`.
- `src/platforms/types.ts`: `Platform`, `PlatformAdapter`.
- Node 18+ built-in `fetch`.

### Revalidation Triggers
- Discord API version changes (currently v10).
- `Chat` / `Message` / `PlatformAdapter` interface changes.
- `runPlatformSync` mode-selection contract changes.

## File Structure Plan

```
src/platforms/discord/
├── client.ts   # DiscordChannel/DiscordMessage/DiscordClient + createDiscordClient (fetch, 429 retry)
└── sync.ts     # hashStr, mapChat, mapMessage, dateToDiscordSnowflake,
                # runBackfillImpl, runIncrementalImpl, createDiscordAdapter, discordAdapter, main()
tests/
└── discord.test.ts
```

**Modified**: `package.json`: `"sync:discord"` script (already wired).

## Components and Interfaces

### Discord Client (`client.ts`)

```typescript
export interface DiscordChannel {
  id: string
  type: number          // 0=GuildText, 1=DM, 3=GroupDM (others skipped)
  name: string | null
  recipients?: Array<{ id: string; username: string }>
}

export interface DiscordMessage {
  id: string            // snowflake => external_id
  content: string
  author: { id: string; username: string }
  timestamp: string     // ISO 8601
  message_reference?: { message_id: string }
  type: number
}

export interface DiscordClient {
  getGuilds(): Promise<Array<{ id: string }>>
  getGuildChannels(guildId: string): Promise<DiscordChannel[]>
  getDirectMessageChannels(): Promise<DiscordChannel[]>
  getMessages(channelId: string, before?: string, after?: string): Promise<DiscordMessage[]>
}

export function createDiscordClient(token: string): DiscordClient
// Base https://discord.com/api/v10, Authorization: `Bot {token}`.
// getMessages uses limit=100 and optional before/after snowflake cursors.
// discordFetch: on 429 reads Retry-After (seconds, default 1), awaits, retries once;
//   throws on non-2xx (including a second 429).
```

### Row Mappers (`sync.ts`)

```typescript
export function hashStr(s: string): number
// FNV-1a over the string, never returns 0. Exported/tested; not called by the runners.

export function mapChat(channel: DiscordChannel, account = 'default'): Chat
// external_id: channel.id
// account:     account
// name:        channel.name ?? recipients[0].username ?? channel.id
// type:        (channel.type === 0 || channel.type === 3) ? 'group' : 'private'
// username:    null
// platform:    'discord'

export function mapMessage(msg: DiscordMessage, chatId: number): Message
// external_id:          msg.id
// chat_id:              chatId
// sender_id:            msg.author.id
// sender_name:          msg.author.username
// text:                 msg.content || null
// type:                 msg.content ? 'text' : 'other'
// timestamp:            Math.floor(Date.parse(msg.timestamp) / 1000)
// is_sender:            0        (bot token cannot determine "current user")
// reply_to_external_id: msg.message_reference?.message_id ?? null
// platform:             'discord'

export function dateToDiscordSnowflake(date: Date): string
// (BigInt(ms) - Discord epoch 1420070400000) << 22, as string. Used as the `after` cursor.
```

### Backfill and Incremental Runners (`sync.ts`)

```typescript
export async function runBackfillImpl(client: DiscordClient, account = 'default'): Promise<void>
export async function runIncrementalImpl(client: DiscordClient, since: Date, account = 'default'): Promise<void>
```

Both discover channels the same way: `getDirectMessageChannels()` plus, for every guild from `getGuilds()`, `getGuildChannels(guild.id)`, keeping only `ALLOWED_TYPES = {0, 1, 3}`. For each channel they `upsertChat(mapChat(...))`, page through messages calling `insertMessage(mapMessage(...))`, then trigger embeddings for that chat when its index exists (`isIndexed('messages')` => `embedNewMessages([chatId])`; `isIndexed('chats')` => `embedNewChats([chatId])`). Each logs a completion summary.

- **Backfill** pages backward with the `before` cursor (`before = last message id`), stopping when a page returns 0 messages or fewer than 100.
- **Incremental** pages forward with an `after` cursor seeded from `dateToDiscordSnowflake(since)`, advancing `after = last message id`, stopping on the same conditions. This fetches only messages newer than the previous run.

**Idempotency**: `insertMessage` is `INSERT OR IGNORE` on the message uniqueness constraint, so both runners are safe to repeat and never modify existing rows.

### Adapter and Entry Point (`sync.ts`)

```typescript
export function createDiscordAdapter(account: string, credentials: AccountCredentials): PlatformAdapter
```

Returns a `PlatformAdapter`:
- `platform: 'discord'`, `account`.
- `runBackfill(db)`: reads `credentials.fields['DISCORD_TOKEN']`; if empty, writes a message to stderr and `process.exit(1)`; else `runBackfillImpl(createDiscordClient(token), account)`.
- `syncIncremental(db, since)`: same token guard; else `runIncrementalImpl(createDiscordClient(token), since, account)`.
- `startListener(db)`: no-op (REST-only scope).

`discordAdapter` is the default-account instance built from `process.env.DISCORD_TOKEN`. `main()` calls `initDb('./khipuchat.db')` then `runPlatformSync(discordAdapter, db, process.argv)`, which selects backfill vs. incremental from the stored last-synced timestamp and records the new one. `main()` runs only when the module is the entry point.

## Requirements Traceability

| Requirement | Component | Notes |
|-------------|-----------|-------|
| 1.1, 1.2 | `createDiscordAdapter` token guard | Reads `DISCORD_TOKEN`; stderr message + exit 1 when missing |
| 2.1, 2.2 | runners + client | `getDirectMessageChannels` + per-guild `getGuildChannels` |
| 2.3 | `ALLOWED_TYPES = {0,1,3}` | Announcement/voice/forum/other types skipped |
| 3.1 | runners | `before`/`after` pagination until a short/empty page |
| 3.2 | `mapMessage` | snowflake, author, content, ISO=>Unix seconds, reply reference |
| 3.3 | `mapChat` / `mapMessage` | `platform: 'discord'` on every row |
| 3.4 | `upsertChat(mapChat(...))` | one chat per discovered channel |
| 3.5 | `mapMessage` | empty content => `type = 'other'` |
| 4.1 | `discordFetch` | 429 => wait `Retry-After` seconds, retry once |
| 4.2 | client request shape | limit=100 paging; reactive (429-driven) pacing, no proactive cap |
| 5.1 | `main` + `package.json` | `npm run sync:discord` |
| 5.2 | `insertMessage` INSERT OR IGNORE | no duplicate rows on repeat |
| 5.3 | `runIncrementalImpl` + `runPlatformSync` | incremental `after` cursor stores only new messages |

## Error Handling

| Error | Response |
|-------|----------|
| Missing `DISCORD_TOKEN` | stderr message; `process.exit(1)` |
| 429 response | Wait `Retry-After` seconds; retry once |
| Second 429 on retry, or other non-2xx | Throw `Discord API {status} at {url}: {message}`; propagates to `main` catch (exit 1) |
| `main()` rejection | Logged to stderr; `process.exit(1)` |

**Known limitation**: retry handles a single 429; a second consecutive 429 throws. Consistent with the other adapters and acceptable for typical channel counts. Rate limiting is reactive only (no proactive 50 req/s throttle).

## Testing Strategy

- **Unit (`mapChat`)**: name fallback chain (channel.name => recipient username => id); `type` group-vs-private derivation for types 0/1/3.
- **Unit (`mapMessage`)**: ISO=>Unix-seconds conversion; `is_sender = 0`; empty content => `type = 'other'`; reply reference extraction.
- **Unit (`hashStr`, `dateToDiscordSnowflake`)**: FNV-1a never-zero property; snowflake epoch/shift math for the `after` cursor.
- **Integration (`runBackfillImpl`)**: mock `DiscordClient` with DM + guild channels and fixture messages produces the expected chat/message rows; channel-type filtering excludes disallowed types.
- **Integration (`runIncrementalImpl`)**: `after` cursor derived from `since` fetches only newer messages; forward paging advances the cursor.
- **Idempotency**: running a backfill twice yields no duplicate rows (INSERT OR IGNORE).
- **Rate limit**: mock 429 with `Retry-After` triggers exactly one retry and then succeeds.
