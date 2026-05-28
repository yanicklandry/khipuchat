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
