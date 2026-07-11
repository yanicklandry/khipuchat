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

---

# Gap Analysis (2026-07-11)

## Summary

- The adapter layer (all 7 platforms) and DB infrastructure are **complete**. The main remaining work is the CLI wiring layer.
- All 7 adapter objects implement `syncIncremental`. DB schema, `getPlatformLastSyncedAt`, and `setPlatformLastSyncedAt` exist and work.
- Every `main()` entry point still hardcodes `runBackfill` — none of them parse `--force`, read `sync_state`, or call `setPlatformLastSyncedAt` on clean completion (telegram has a partial but broken implementation in `runSync`).
- The aggregate `npm run sync` script only covers 2 of 7 platforms and uses the wrong flag.
- Recommended approach: introduce `src/sync-runner.ts` (~60 lines) containing a shared `runPlatformSync` function; each `main()` becomes a 3-line call.

---

## 1. What Already Exists

### DB Layer (`src/db.ts`)

| Item | Status |
|---|---|
| `sync_state` table (schema, `createSchema`) | Complete |
| `getPlatformLastSyncedAt(platform)` | Complete — returns `number \| null` |
| `setPlatformLastSyncedAt(platform, timestamp)` | Complete — `INSERT OR REPLACE` |
| `rebuildFtsIndex()` | Complete — available for `--force` post-sync |

Note: requirements name these `getLastSyncedAt`/`setLastSyncedAt`. Current names use the `Platform` prefix; design phase should decide whether to rename.

### PlatformAdapter Interface (`src/platforms/types.ts`)

`syncIncremental?(db, since: Date): Promise<void>` is already declared as optional (line 10).

### All 7 Adapter Implementations

Every platform has a working `syncIncremental` on its adapter object:

| Platform | Adapter implements `syncIncremental` | Incremental strategy |
|---|---|---|
| telegram | Yes | Skip dialogs with `date <= sinceTs`; paginate forward from last message ID |
| imessage | Yes | Cocoa nanosecond threshold `WHERE date > cocoaThreshold` on `chat.db` |
| wechat | Yes | `WHERE timeCol > sinceTs` per-table (handles V3 + V4 schema) |
| discord | Yes | `after` snowflake derived from `since` via `dateToDiscordSnowflake` |
| slack | Yes | `oldest` parameter to `fetchHistory` (Unix float seconds) |
| email | Yes | Delegates to `runBackfillImpl` with `{ since }` (IMAP `SINCE` filter) |
| whatsapp | Yes | Client-side filter `msg.timestamp > sinceTs` with logged caveat |

---

## 2. Gaps

### Gap A — CLI `main()` functions do not wire incremental mode (CRITICAL)

Every `main()` calls `runBackfill` unconditionally. For example, `discord/sync.ts` line 148:

```typescript
async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  try { await discordAdapter.runBackfill(db) } catch { process.exit(1) }
}
```

Telegram is partial but broken. Its `runSync` function logs "incremental" when `since` is non-null but still calls `syncFn(client)` which defaults to `runBackfill` — the incremental path is never executed.

Each `main()` is missing:
- `--force` / `--backfill` flag parsing
- `getPlatformLastSyncedAt(platform)` call
- Mode routing (`syncIncremental` vs `runBackfill`)
- `console.log('incremental' | 'backfill')` before sync (Req 4.7)
- `setPlatformLastSyncedAt` only on clean completion (Req 5)

### Gap B — `--force` flag not parsed anywhere (HIGH)

No `main()` recognises `--force`. Telegram reads `--backfill` (deprecated) and `--backfill-only` (internal daemon flag, controls whether the listener loop starts — orthogonal to sync mode).

### Gap C — Semantic search index rebuild on `--force` not wired (MEDIUM)

Req 4.4: sync runner shall rebuild the semantic search index after a `--force` run.

Per-chat `embedNewMessages`/`embedNewChats` are already called inside each incremental impl. The full index rebuild (equivalent to `npm run index:embeddings`) is not triggered from any sync script. There is no exported `rebuildAllEmbeddings` function — the batch loop lives inside `index-embeddings.ts::main()`. Design needs to either extract a function or call the script programmatically.

### Gap D — `npm run sync` aggregate script is incomplete (MEDIUM)

Current `package.json`:
```
"sync": "tsx src/platforms/telegram/sync.ts --backfill-only && tsx src/platforms/imessage/sync.ts"
```

Issues: only 2 of 7 platforms; uses `--backfill-only` (wrong flag); does not forward `--force` (Req 4.6).

### Gap E — `sync_state` per-(platform, account) keying (LOW — future)

Current schema uses `platform TEXT NOT NULL PRIMARY KEY`. Req 6 asks for composite (platform, account) key with migration of existing rows to account `"default"`. This is explicitly tied to the `multi-account` spec and safe to defer. The single-account schema fully satisfies Reqs 1–5.

---

## 3. Implementation Approaches

### Option A: Shared sync runner (Recommended)

Create `src/sync-runner.ts`:

```typescript
export async function runPlatformSync(
  adapter: PlatformAdapter,
  db: Database.Database,
  argv: string[],
): Promise<void>
```

Logic:
1. Parse `force = argv.includes('--force') || argv.includes('--backfill')`
2. `const sinceTs = force ? null : getPlatformLastSyncedAt(adapter.platform)`
3. Print `incremental` or `backfill`
4. Try: call `adapter.syncIncremental(db, new Date(sinceTs * 1000))` if sinceTs non-null and method exists; else `adapter.runBackfill(db)`
5. On success: `setPlatformLastSyncedAt(adapter.platform, now)`
6. On `--force`: trigger full embeddings rebuild

Each `main()` becomes:
```typescript
async function main(): Promise<void> {
  const db = initDb('./khipuchat.db')
  await runPlatformSync(discordAdapter, db, process.argv)
}
```

**Pros**: Single source of truth for all requirements; easy to unit-test; no adapter changes needed.
**Cons**: One new file (~60 lines).

### Option B: Inline mode selection in each `main()`

Duplicate ~20 lines of flag-parsing + routing into 7 files.

**Pros**: No new abstraction.
**Cons**: 7-way duplication; any requirement change requires 7 edits.

**Recommendation**: Option A. It maps directly to the spec's "sync runner" concept and is far easier to maintain.

---

## 4. Integration Points

| Point | File | Notes |
|---|---|---|
| DB helpers | `src/db.ts` | `getPlatformLastSyncedAt`, `setPlatformLastSyncedAt` already exported |
| Embeddings rebuild | `src/index-embeddings.ts` | Extract `rebuildAllEmbeddings()` or dynamically import `main` |
| Telegram daemon flag | `src/platforms/telegram/sync.ts` | Keep `--backfill-only` — controls listener loop, orthogonal to sync mode |
| Aggregate script | `package.json` | Replace `sync` script; add all 7 platforms; forward `$npm_config_args` or inline flag check |
| FTS rebuild | `src/db.ts::rebuildFtsIndex()` | Already exists; call inside `--force` path |

---

## 5. Open Questions for Design Phase

1. **Embeddings rebuild scope**: On `--force`, rebuild all messages or only the just-synced platform? Req 4.4 says "for the affected messages" — per-platform scope is faster and sufficient.
2. **Aggregate `sync` serial vs. parallel**: Current script is serial. `--force` mode may be slow for all 7 platforms in sequence; parallel execution risks wechat decryption resource contention.
3. **Telegram `--backfill-only` flag**: This controls whether the listener loop starts after sync. Keep separate from `--force` or consolidate?
4. **Function naming**: `getLastSyncedAt`/`setLastSyncedAt` (spec) vs. `getPlatformLastSyncedAt`/`setPlatformLastSyncedAt` (code). Recommend keeping current names — the `Platform` prefix aids readability.
5. **Error granularity for Req 5**: If 499/500 Telegram dialogs succeed and one throws, should `setPlatformLastSyncedAt` be written? Current adapter implementations silently skip errored chats; the try/catch in `runSync` would need to distinguish "some chats failed" from "sync crashed entirely."

---

## 6. Verdict

Implementation is approximately 60% complete. The hardest parts (adapter incremental logic, DB schema, interface contract) are done. The remaining work is:

- One new `src/sync-runner.ts` file (~60 lines)
- Update 7 `main()` functions (3–5 lines each)
- Update `package.json` sync script
- Extract `rebuildAllEmbeddings()` from `index-embeddings.ts`

**Risk**: Low. No adapter logic needs changing. `runBackfill` signature is untouched. All changes are in entry points and wiring.
