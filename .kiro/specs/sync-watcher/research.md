# Research Log: sync-watcher

## Discovery Scope

Feature type: **Simple Addition** (new entry point, no changes to existing files except package.json scripts).
Discovery process: Light (integration-focused, no external dependency research required).

## Key Findings

### Codebase Analysis

- All platform adapters export a `PlatformAdapter`-conforming object with `runBackfill` and `startListener`. The `incremental-sync` spec adds optional `syncIncremental`.
- Credential availability is checked implicitly: adapters read env vars / config at the top of their module or inside sync functions. The lightest startup check is to inspect the env vars directly in `watch.ts` per platform (e.g., `process.env.TELEGRAM_SESSION` for Telegram, `process.env.DISCORD_TOKEN` for Discord).
- `initDb` must be called once before any DB operations; the DB handle is passed to adapter methods. Existing pattern used in all adapter `main()` functions.
- The `getPlatformLastSyncedAt` function (from `incremental-sync`) returns `number | null` (Unix seconds); `watch.ts` must convert to `Date` for `syncIncremental(db, since: Date)`.
- No adapter currently has a message-count return value from `runBackfill` or `syncIncremental`; logging "N new messages" requires either instrumenting the DB `insertMessage` call count before/after the cycle, or accepting "up to date" as the default log line unless the adapter explicitly surfaces a count.

### Design Decisions

1. **Generalization**: The poll-cycle pattern (check since → route → log → catch) is identical for all 7 platforms. Generalized into a single `pollCycle(adapter, db)` helper called by all `setInterval` callbacks.

2. **Build vs. Adopt**: No timer library needed. Node.js `setInterval` + `process.on('SIGINT'/'SIGTERM')` is sufficient and avoids new dependencies.

3. **Simplification**: Single file `src/watch.ts` ≤ 200 lines. No adapter registry class, no watcher state machine — just an array of `{ adapter, intervalMs }` entries built at startup. The shutdown drain uses a simple in-flight counter (`let inFlight = 0`) rather than a Promise queue.

4. **Message count logging**: Since adapters don't expose a count, the simplest correct approach is to wrap `db.insertMessage` in a counter for the duration of each poll cycle using a local proxy or by querying `db.getChats()` message counts before and after. Given the ≤200-line constraint, before/after count delta via a lightweight SQL query is preferred: `SELECT COUNT(*) FROM messages WHERE platform = ?` before and after.

5. **isConfigured per platform**: Rather than attempting a live connection (slow, side-effectful), check the known required env vars per platform at startup. Platform-specific env var names are well-known from existing configs. Platforms with no env var check (iMessage uses local file system) are considered always-configured.

### Risks

- **syncIncremental not yet implemented** (incremental-sync is still `[ ]` in roadmap): The watcher falls back to `runBackfill` automatically, so it is safe to develop and test before `incremental-sync` is merged. However, `runBackfill` on every 5-minute tick would be slow for large archives. This is acceptable during the transition period.
- **Shutdown drain race**: If a poll cycle is very long (e.g., Telegram full backfill), the 30-second drain timeout may force-exit mid-sync. This is an edge case and acceptable given the no-corruption guarantee of `sync_state.last_synced_at` (only written on success by the adapter).

---

# Gap Analysis: sync-watcher (2026-07-12)

## Analysis Summary

- **Primary gap**: No polling daemon exists. `sync-all.ts` is a one-shot subprocess spawner; a new `src/sync-watcher.ts` is the right vehicle for the daemon.
- **Strong reuse base**: `runAllAccountsSync` (error isolation + account iteration), `AccountRegistry` (skip-if-unconfigured via empty `listAccounts()`), `PlatformAdapter.syncIncremental?`, and `rebuildEmbeddings(platform)` are all in place.
- **WeChat factory gap**: Six of seven platforms export a `createXxxAdapter(account, creds)` factory; WeChat only exports a singleton `wechatAdapter`. A thin factory wrapper must be added or the watcher must special-case WeChat.
- **Message count gap**: `runPlatformSync` returns `void`. To log "synced N messages" and gate indexing, the watcher must count DB rows before/after each cycle.
- **Subprocess model is incompatible with daemon**: `sync-all.ts` spawns child processes; a long-running daemon needs in-process adapters with `setTimeout` loops per platform/account.

## Document Status

Full brownfield analysis: all relevant source files read, platform adapter exports enumerated, sync-runner contract reviewed.

## 1. Existing Assets (directly reusable)

| Asset | Location | Relevance |
|---|---|---|
| `runAllAccountsSync` | `src/sync-runner.ts:67` | Iterates accounts, catches errors per account, returns `AccountSyncOutcome[]`. Core per-cycle sync call. |
| `runPlatformSync` | `src/sync-runner.ts:29` | Handles incremental-vs-backfill selection, `sync_state` write-back. |
| `AccountRegistry.listAccounts(platform)` | `src/account-registry.ts` | Returns `[]` for unconfigured platforms — natural skip-if-unconfigured hook. |
| `PlatformAdapter.syncIncremental?` | `src/platforms/types.ts:11` | Optional; `runPlatformSync` already selects it when `sync_state` exists. |
| `rebuildEmbeddings(platform)` | `src/index-embeddings.ts:142` | Platform-scoped sweep over unindexed messages/chats. Call after cycles with new messages. |
| `getPlatformLastSyncedAt` | `src/db.ts:236` | Needed to compute "before" timestamp for new-message counting. |
| `AdapterFactory` type | `src/platforms/types.ts:15` | Contract for creating adapters from credentials. |

### AdapterFactory export status per platform

| Platform | Factory export | Notes |
|---|---|---|
| `discord` | `createDiscordAdapter` | `src/platforms/discord/sync.ts:126` |
| `telegram` | `createTelegramAdapter` | `src/platforms/telegram/sync.ts:276` |
| `slack` | `createSlackAdapter` | `src/platforms/slack/sync.ts:91` |
| `email` | `createEmailAdapter` | `src/platforms/email/sync.ts:97` |
| `imessage` | `createIMessageAdapter` | `src/platforms/imessage/sync.ts:201` |
| `whatsapp` | `createWhatsAppAdapter` | `src/platforms/whatsapp/sync.ts:128` |
| `wechat` | **None** | Only `wechatAdapter` singleton at `src/platforms/wechat/sync.ts:514`; no factory |

## 2. Implementation Gaps

### Gap 1: No polling daemon

`src/sync-watcher.ts` does not exist. No code implements per-platform `setTimeout` loops, interval configuration, or daemon process lifecycle.

**Options**:
- **A (recommended): New `src/sync-watcher.ts`** — standalone daemon, `khipu.ts` routes `sync all` there, `sync-all.ts` kept for `npm run sync` backward compat.
- **B: Extend `sync-all.ts`** — add daemon mode; `--once` exits after one pass. Avoids a new file but conflates one-shot and daemon.

### Gap 2: Subprocess model incompatible with daemon

`sync-all.ts` spawns each platform as a child process. A daemon needs in-process adapter invocations with independent `setTimeout` cycles. The watcher must use `runAllAccountsSync` directly, not subprocess spawning.

### Gap 3: WeChat has no AdapterFactory

`wechatAdapter` is a singleton (`src/platforms/wechat/sync.ts:514`); no factory exists. Options:
- **A (recommended)**: Add `createWechatAdapter` to `wechat/sync.ts` — trivial (WeChat is local-only, single-account, no credentials).
- **B**: Watcher special-cases WeChat by using the singleton directly.

### Gap 4: No new-message count from `runPlatformSync`

`runPlatformSync` returns `void`. For "synced N messages" logging and conditional indexing:
- **A (recommended)**: Count `SELECT COUNT(*) FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.platform=? AND m.account=? AND m.timestamp >= ?` before vs after sync. No change to `runPlatformSync`.
- **B**: Extend `runPlatformSync` to return `{ newMessages: number }` — cleaner long-term but more invasive.
- **C**: Always call `rebuildEmbeddings` (no conditional) — simpler but wastes cycles on idle polls.

### Gap 5: No `WATCH_INTERVAL_<PLATFORM>_MS` env var reading

Must be implemented from scratch: `` parseInt(process.env[`WATCH_INTERVAL_${platform.toUpperCase()}_MS`] ?? '', 10) || 300_000 ``.

### Gap 6: No graceful shutdown

No SIGINT/SIGTERM handler anywhere for this use case. Daemon must register handlers, set a shutdown flag, stop scheduling new cycles, and await in-progress syncs.

### Gap 7: No `--once` flag

Not present anywhere. Must be added to the new watcher's arg parsing.

### Gap 8: `npm run watch` script absent

`package.json` has no `"watch"` script. Must add `"watch": "tsx src/sync-watcher.ts"`.

### Gap 9: `khipu.ts` routing

Currently `resolveCommand` routes `sync all` to `sync-all.ts` (`src/khipu.ts:83`). If Option A (new file) is chosen, update route to `sync-watcher.ts`.

## 3. Skip-if-Unconfigured via Registry

`AccountRegistry.listAccounts(platform)` already returns `[]` for unconfigured env-var platforms. The watcher can skip platforms with empty account lists naturally. No new credential-check logic is needed beyond iterating `PLATFORMS` at startup and logging skipped ones.

## 4. Concurrency Model

Each platform/account needs its own independent polling timer:

```ts
async function pollLoop(platform, account, intervalMs) {
  while (!shutdown) {
    await runOneCycle(platform, account)
    await sleep(intervalMs)  // cancellable on shutdown
  }
}
await Promise.allSettled(loops)
```

`--once` mode: call `runOneCycle` once per account without a loop, then exit.

## 5. Files to Create / Modify

| File | Action | What |
|---|---|---|
| `src/sync-watcher.ts` | **Create** | Daemon: interval config, account iteration, polling loops, SIGINT handler, `--once` mode |
| `src/platforms/wechat/sync.ts` | **Small modify** | Add `createWechatAdapter` factory export |
| `package.json` | **Modify** | Add `"watch": "tsx src/sync-watcher.ts"` |
| `src/khipu.ts` | **Modify** | Update `sync all` route from `sync-all.ts` to `sync-watcher.ts` |

`src/sync-all.ts` is **not modified** (kept for `npm run sync` backward compat).
