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

---

# Gap Analysis: sync-watcher (2026-07-13) — Post-Implementation Audit

## Analysis Summary

- **Most requirements are implemented**: `src/watch.ts` (182 lines) covers per-platform polling, error isolation, graceful shutdown, `--once` mode, embedding indexing, and interval configuration.
- **Signal adapter is entirely absent**: `ADAPTER_FACTORIES` in `watch.ts` has no `signal` entry; `isConfigured` also has no signal entry, causing the platform to be silently skipped on every startup.
- **Message counting is not account-scoped**: The `SELECT COUNT(*) FROM messages WHERE platform = ?` query tallies all accounts for a platform; multi-account setups will produce inflated or incorrect "N new messages" counts.
- **Startup log omits account name**: Requirement 1.1 specifies "listing each platform/account"; the log currently emits only `[platform] polling every Xms`.
- **All tasks show `[x]`**: The three gaps above are not covered by any existing task, so implementation must be added outside the current task list.

## Document Status

Post-implementation brownfield audit: `src/watch.ts` read in full, requirements cross-referenced line-by-line, all test files reviewed.

## 1. Requirement-to-Implementation Map

| Requirement | Status | Notes |
|---|---|---|
| 1.1 Startup log per platform/account + interval | Partial | Account name absent from log line |
| 1.2 Skip unconfigured with one-time log | Partial | Signal always skipped; no `isConfigured` or factory entry |
| 1.3 Immediate first poll | Done | `void pollCycle(adapter, db)` before setInterval |
| 1.4 `npm run watch` = `khipu sync all` | Done | `package.json` `watch` script present; `khipu.ts` routes `sync all` to `watch.ts` |
| 2.1 Per-platform independent polling interval | Done | `getIntervalMs` + `setInterval` per adapter |
| 2.2 Log N new messages | Partial | Count query not account-scoped |
| 2.3 Log up to date | Done | `console.log` in `pollCycle` |
| 2.4 Use `syncIncremental` when available | Done | `adapter.syncIncremental !== undefined && since !== null` |
| 2.5 Use backfill otherwise | Done | `adapter.runBackfill` fallback |
| 2.6 Iterate per-account via registry | Done | `registry.listAccounts(platform)` loop in `main()` |
| 3.1-3.3 Error isolation | Done | try/catch in `pollCycle`; `inFlight` counter unaffected |
| 4.1-4.2 Graceful shutdown | Done | SIGINT/SIGTERM handlers; 30s drain; exit log |
| 5.1-5.3 Interval configuration | Done | `WATCH_INTERVAL_<PLATFORM>_MS` env var |
| 6.1-6.3 Index after sync | Done | `rebuildEmbeddings` after new messages; isolated try/catch |
| 7.1-7.3 `--once` mode | Done | `Promise.all` one-pass then `process.exit(0)` |

## 2. Remaining Gaps

### Gap A: Signal adapter absent from `ADAPTER_FACTORIES` and `isConfigured`

**Location**: `src/watch.ts:37-44` (`REQUIRED_ENV_VARS`) and `src/watch.ts:121-129` (`ADAPTER_FACTORIES`)

`signal` is in `PLATFORMS` (from `sync-all.ts`) but:
- Not in `LOCAL_ONLY_PLATFORMS` and not in `REQUIRED_ENV_VARS`, so `isConfigured('signal')` always returns `false` (line 50: `if (vars === undefined) return false`).
- Not in `ADAPTER_FACTORIES`, so even if `isConfigured` were fixed, line 145 would assign `undefined` to `factory`, crashing the loop.

`src/platforms/signal/sync.ts` already exports `createSignalAdapter(account, credentials)` and checks for `BEEPER_ACCESS_TOKEN` internally.

**Options**:
- **A (recommended)**: Add `signal` to `REQUIRED_ENV_VARS` with `['BEEPER_ACCESS_TOKEN']`; add `createSignalAdapter` to `ADAPTER_FACTORIES`. One-line change each; no new logic.
- **B**: Add signal to `LOCAL_ONLY_PLATFORMS` (always "configured") + add factory. Simpler `isConfigured` but misleading for operators without Beeper.

### Gap B: Message count not account-scoped

**Location**: `src/watch.ts:61-68`

```ts
const countBefore = database.prepare('SELECT COUNT(*) FROM messages WHERE platform = ?').pluck().get(adapter.platform) as number
// ... sync ...
const countAfter = database.prepare('SELECT COUNT(*) FROM messages WHERE platform = ?').pluck().get(adapter.platform) as number
```

With multiple accounts for the same platform (e.g., two Discord accounts), both adapters run concurrently. The count query returns the total for the platform, not the account, so the delta `countAfter - countBefore` can over-count or under-count new messages.

**Options**:
- **A (recommended)**: Add `AND account = ?` to both queries, binding `adapter.account`. Zero risk, no schema change.
- **B**: Accept platform-level count as an approximation (not correct for multi-account scenarios).

### Gap C: Startup log missing account name

**Location**: `src/watch.ts:169`

```ts
console.log(`[${adapter.platform}] polling every ${intervalMs}ms`)
```

Requirement 1.1 says "listing each platform/account". With two Discord accounts both log the same line, making it impossible to distinguish which accounts are active.

**Options**:
- **A (recommended)**: `[${adapter.platform}/${adapter.account}] polling every ${intervalMs}ms`. Minimal change; consistent with `pollCycle` log format convention.
- **B**: Keep platform-only log (acceptable if multi-account is rare, but violates the requirement).

## 3. Files Requiring Change

| File | Action | What |
|---|---|---|
| `src/watch.ts` | Modify (3 spots) | Add signal to `REQUIRED_ENV_VARS` + `ADAPTER_FACTORIES`; fix count queries; fix startup log |
| `tests/watch.test.ts` | Modify | Add test cases for signal `isConfigured`; update count-query assertions for account scoping |

## 4. Effort and Risk

- **Effort**: S (half a day) — all three changes are mechanical: 2-line additions and 2-line query edits.
- **Risk**: Low — no new dependencies, no schema changes, no adapter internals touched.

## 5. Recommended Implementation Path

1. In `watch.ts`: add `signal: ['BEEPER_ACCESS_TOKEN']` to `REQUIRED_ENV_VARS`, add `createSignalAdapter` import + entry to `ADAPTER_FACTORIES` (Option A for Gap A).
2. In `watch.ts`: scope both count queries to `AND account = ?` bound to `adapter.account` (Option A for Gap B).
3. In `watch.ts`: update the startup log line to include `adapter.account` (Option A for Gap C).
4. In `watch.test.ts`: add/update tests to cover signal `isConfigured` and account-scoped counting.

---

# Gap Analysis: sync-watcher (2026-07-14) — Final Closure Audit

## Analysis Summary

- **All prior gaps closed**: The three gaps flagged in the 2026-07-13 audit (A: signal absent, B: count not account-scoped, C: startup log missing account) are all resolved in the current `src/watch.ts`.
- **Implementation is complete**: All 20 requirement acceptance criteria (1.1-7.3) map to working code in `src/watch.ts` (182 lines).
- **Tests are comprehensive**: `tests/watch.test.ts` covers `pollCycle`, `isConfigured`, `getIntervalMs`, startup adapter selection, error isolation, and `--once` mode.
- **No remaining gaps**: The spec is implementation-ready with no open issues.

## Document Status

Brownfield closure audit: `src/watch.ts` read line-by-line against the 2026-07-13 gap list and against all 20 acceptance criteria.

## Gap Resolution Verification

### Gap A: Signal adapter absent (CLOSED)

Current `src/watch.ts:45` includes `signal: ['BEEPER_ACCESS_TOKEN']` in `REQUIRED_ENV_VARS`.
Current `src/watch.ts:130` includes `signal: createSignalAdapter` in `ADAPTER_FACTORIES`.
Import at line 15 confirms `createSignalAdapter` is pulled from `src/platforms/signal/sync`.

### Gap B: Message count not account-scoped (CLOSED)

Current `src/watch.ts:63-64`:
```ts
database.prepare('SELECT COUNT(*) FROM messages WHERE platform = ? AND account = ?')
  .pluck().get(adapter.platform, adapter.account)
```
Both `platform` and `account` are bound; confirmed in `tests/watch.test.ts` lines 174-189.

### Gap C: Startup log missing account name (CLOSED)

Current `src/watch.ts:173`:
```ts
console.log(`[${adapter.platform}/${adapter.account}] polling every ${intervalMs}ms`)
```
Format is consistent with all other `pollCycle` log lines.

## Full Requirement Coverage

| Req | Status | Evidence |
|---|---|---|
| 1.1 Startup log per platform/account + interval | Done | `watch.ts:173` |
| 1.2 Skip unconfigured; one-time log | Done | `watch.ts:139-147` |
| 1.3 Immediate first poll | Done | `watch.ts:175 void pollCycle(adapter, db)` |
| 1.4 `npm run watch` = `khipu sync all` | Done | `package.json:27`, `khipu.ts:151-156` |
| 2.1-2.3 Per-interval polling + log | Done | `watch.ts:172-177`, `pollCycle` |
| 2.4-2.5 Incremental/backfill routing | Done | `watch.ts:65-68` |
| 2.6 Account registry iteration | Done | `watch.ts:136-153` |
| 3.1-3.3 Error isolation | Done | `watch.ts:85-89 try/catch` |
| 4.1-4.2 Graceful shutdown | Done | `watch.ts:101-115` |
| 5.1-5.3 Interval config via env | Done | `watch.ts:29-36` |
| 6.1-6.3 Index after sync | Done | `watch.ts:73-79` |
| 7.1-7.3 Single-pass `--once` | Done | `watch.ts:156-169` |

## Effort and Risk

- **Effort**: Done (0 remaining).
- **Risk**: None — feature is already live.

---

# Design Regeneration (2026-07-13)

## Trigger

`design.md` was regenerated because the original draft predated three approved requirements and named the wrong primary entry point. Synthesis outcomes applied to the rewrite:

- **Entry-point correction**: `khipu sync all` is the primary command (routed via `src/khipu.ts`); `npm run watch` is a thin wrapper. The original design named `npm run watch` as primary and omitted the `khipu.ts` routing change.
- **Account iteration (Req 2.6)**: design now reflects the `AccountRegistry` (`loadRegistry` -> `listAccounts` -> `credentialsFor`) loop and the per-platform `ADAPTER_FACTORIES` map, including the `wechat` singleton wrapper. The original design used a flat per-platform loop with no account concept.
- **Embedding indexing (Req 6.1–6.3)**: design now specifies the post-cycle `rebuildEmbeddings(platform)` call, gated on `newMessages > 0`, with its own error isolation. Absent from the original.
- **Single-pass `--once` (Req 7.1–7.3)**: design now specifies the `Promise.all` one-pass branch with per-adapter try/catch and completion log. Absent from the original.
- **Account-scoped correctness**: design specifies `COUNT(*) ... WHERE platform=? AND account=?` and a `[platform/account]` log prefix, resolving the multi-account count and startup-log gaps flagged in the 2026-07-13 audit (Gaps B and C). Signal is included in `ADAPTER_FACTORIES` / `REQUIRED_ENV_VARS`, resolving Gap A.

## Traceability

All 20 requirement IDs (1.1–7.3) now map to concrete components, interfaces, and flows in `design.md`. Design review gate passed (mechanical + judgment).
