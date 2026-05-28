# Research & Design Decisions

---
**Feature**: `incremental-sync`
**Discovery Scope**: Extension (existing system)
**Key Findings**:
- All five non-telegram adapters already implement incremental logic via `chats.last_synced_at` — this spec formalises and elevates that to a platform-level `sync_state` table.
- Telegram and iMessage adapters already contain significant incremental logic; wechat has per-chat timestamp filtering built in. The main gap is the CLI `--backfill` flag and a platform-level timestamp.
- WhatsApp Web.js does not expose server-side time filtering; client-side post-fetch filtering is the only option.
- The `sync_state` table must be separate from `chats.last_synced_at` — `chats` tracks per-chat currency, `sync_state` tracks per-platform run completion.

---

## Research Log

### Existing incremental logic in adapters

- **Context**: Brief says "no per-platform last-sync timestamp is stored anywhere," but codebase inspection shows per-chat `last_synced_at` in `chats` table already used by Telegram, iMessage, and WeChat.
- **Findings**:
  - `db.ts` already has `setLastSyncedAt(chatId, timestamp)` updating `chats.last_synced_at`.
  - Telegram `runBackfill` reads `chats WHERE platform = 'telegram' AND last_synced_at IS NOT NULL` and skips dialogs with `dialogDate <= chatLastSync`.
  - iMessage `runBackfillImpl` reads `chats WHERE platform = 'imessage' AND last_synced_at IS NOT NULL` and applies `WHERE date > <cocoaThreshold>`.
  - WeChat `runBackfillImpl` similarly reads per-chat `last_synced_at` and applies `WHERE create_time > chatLastSync`.
  - Discord, Slack, Email, WhatsApp: their `runBackfillImpl` functions do NOT yet read `last_synced_at`.
- **Implications**: The spec's `syncIncremental(db, since: Date)` method formalises what Telegram/iMessage/WeChat already do ad-hoc. The `sync_state` table adds a true platform-level "last clean run" marker distinct from per-chat tracking.

### sync_state table vs chats.last_synced_at

- **Context**: Need to decide whether to reuse `chats.last_synced_at` or add a new table.
- **Alternatives**:
  - Reuse: Query `MIN(last_synced_at)` over all chats for a platform. Risk: one never-synced chat poisons the min.
  - New table: Simple `platform → last_synced_at` lookup, written atomically on clean completion.
- **Selected**: New `sync_state` table. Semantics are different: per-chat tracks individual chat currency; platform-level tracks "the last time a full sweep completed cleanly."

### Discord incremental approach

- **Context**: Discord adapter's `runBackfillImpl` uses a `DiscordClient` abstraction; need to understand how to pass `after` snowflake.
- **Findings**: Discord REST API `GET /channels/{id}/messages?after={snowflake}` uses snowflake IDs, not timestamps. To convert a `Date` to a snowflake: `(ms - DISCORD_EPOCH) << 22`.
- **Implications**: `syncIncremental` for Discord converts `since` to a snowflake and passes `after` to the messages API.

### Slack incremental approach

- **Context**: Slack `conversations.history` accepts `oldest` (float, Unix seconds with decimal) parameter.
- **Findings**: `oldest` is inclusive. Passing `last_synced_at` directly works; Slack paginates via `cursor`.
- **Implications**: Straightforward — pass `oldest: since.getTime() / 1000` to the Slack client.

### Email incremental approach

- **Context**: IMAP via imapflow supports search criteria.
- **Findings**: `imapflow` `search()` accepts `{ since: Date }` which maps to IMAP `SINCE` criterion. Works on any IMAP server.
- **Implications**: Pass `since` directly to `client.search({ since })`.

### WhatsApp incremental approach

- **Context**: whatsapp-web.js `getChats()` / `fetchMessages()` does not expose a time-filter parameter.
- **Findings**: `fetchMessages` returns all messages up to a limit; no `after` or `since` filter exists in whatsapp-web.js API.
- **Implications**: Client-side post-fetch filter: only insert messages with `timestamp > since`. This is less efficient but correct. Log a warning that full message fetch still occurs.

### --backfill flag propagation

- **Context**: `package.json` shows each `sync:*` script is a direct `tsx` invocation. There's no shared runner script.
- **Findings**: Each adapter's `main()` function reads `process.argv`. Adding `--backfill` check to each `main()` is the simplest approach; the aggregate `sync` script can pass `$@` or check `process.argv` in its own sequence.
- **Implications**: The `sync` aggregate script in `package.json` needs updating to pass `--backfill` through. Alternatively, a new `src/sync.ts` runner can orchestrate all platforms.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations |
|--------|-------------|-----------|---------------------|
| Optional method on PlatformAdapter | Add `syncIncremental?` to interface; runner checks presence | Minimal interface change, backward-compatible | Adapters must opt-in explicitly |
| Runner reads sync_state and decides | Runner always calls syncIncremental with `since`; adapter ignores if no filter | Cleaner runner logic | Adapters must still handle `since=epoch` as "fetch all" |
| Separate IncrementalAdapter interface | New interface extends PlatformAdapter | Explicit capability declaration | Extra interface complexity for small gain |

**Selected**: Optional method on `PlatformAdapter`. Matches brief's approach, minimal change, backward-compatible.

## Design Decisions

### Decision: sync_state table separate from chats.last_synced_at

- **Context**: Two different semantics — per-chat currency vs. platform-level clean-run marker.
- **Selected Approach**: New `sync_state` table with `(platform TEXT PRIMARY KEY, last_synced_at INTEGER)`.
- **Rationale**: A single failed chat in a 500-dialog Telegram sync should not block the platform timestamp from advancing for all the chats that succeeded. The platform-level timestamp means "I completed a full sweep up to this time."
- **Trade-offs**: Adds a table; queries are trivial.

### Decision: syncIncremental receives a Date, not a Unix integer

- **Context**: Discord needs milliseconds for snowflake conversion; IMAP needs a Date object; others need seconds.
- **Selected Approach**: `since: Date` in the interface; each adapter converts internally.
- **Rationale**: `Date` is the lingua franca; avoids callers needing to know each adapter's epoch conventions.

### Decision: WhatsApp falls back to full fetch + client-side filter

- **Context**: whatsapp-web.js API has no server-side time filter.
- **Selected Approach**: Fetch all messages (up to existing limit), filter client-side to `msg.timestamp > since`, insert only new ones.
- **Rationale**: Preserves correctness; performance cost is accepted since WhatsApp message counts are typically small.
- **Trade-offs**: Still downloads all messages per chat on each run. Logged as a warning.

## Risks & Mitigations

- **Partial run corruption**: If process is killed mid-sync, some chats updated, others not. Mitigation: `sync_state.last_synced_at` is only written after ALL chats complete cleanly; per-chat `chats.last_synced_at` is still written per-chat (fine — idempotent re-inserts catch anything missed).
- **Clock skew**: If the machine clock jumps back, new messages with future timestamps could be missed. Mitigation: Out of scope; acceptable for self-hosted use case.
- **Discord snowflake overflow**: 64-bit snowflake uses BigInt arithmetic. Mitigation: Use BigInt in conversion helper.

## References

- Discord snowflake epoch: https://discord.com/developers/docs/reference#snowflakes
- Slack conversations.history `oldest`: https://api.slack.com/methods/conversations.history
- imapflow search options: https://imapflow.com/module-imapflow-ImapFlow.html
- better-sqlite3 synchronous ops: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
