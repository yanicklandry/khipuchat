# Research & Design Decisions

**Feature**: `discord-sync`
**Discovery Scope**: Extension — REST API adapter following Telegram pattern

**Key Findings**:
- Discord REST API uses snowflake IDs for pagination (`before` cursor); no new runtime dependencies needed (Node 18+ native fetch).
- `'discord'` is already in the `Platform` union — no types.ts change required.
- Rate limit: 50 req/s global; 429 responses include `Retry-After` header (seconds) or `X-RateLimit-Reset-After`.

## Design Decisions

### Decision: Native fetch, no Discord SDK
- Discord's REST API is simple enough to wrap directly with `globalThis.fetch` (Node 18+).
- Avoids adding `discord.js` (~10MB+) for a read-only backfill use case.
- Injectable `DiscordClient` interface makes tests straightforward without mocking a full SDK.

### Decision: Injectable client interface for testability
```typescript
interface DiscordClient {
  getDirectMessageChannels(): Promise<DiscordChannel[]>
  getGuildChannels(guildId: string): Promise<DiscordChannel[]>
  getGuilds(): Promise<{ id: string }[]>
  getMessages(channelId: string, before?: string): Promise<DiscordMessage[]>
}
```
Tests provide a mock implementation returning fixture data.

### Decision: Pagination via `before` snowflake cursor
- `GET /channels/{id}/messages?limit=100&before={oldest_id}` — continue until fewer than 100 messages returned.
- Stop condition for already-synced channels: stop when `external_id` of oldest fetched message is already in the DB.

## Risks & Mitigations
- **Bot scope**: bot must be invited to guilds; DMs only available if users initiated contact. Mitigation: document in error output when no channels found.
- **Rate limits**: 429 + Retry-After header handled explicitly. Global 50 req/s respected by spacing requests.
