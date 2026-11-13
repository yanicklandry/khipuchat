# Research & Design Decisions

## Summary
- **Feature**: `message-events`
- **Discovery Scope**: Extension (light discovery). Integrates into `src/db.ts` (insert contract), `src/watch.ts` (`pollCycle`), and `src/sync-runner.ts` (`runPlatformSync`). No new third-party library.
- **Key Findings**:
  - `insertMessage` is called directly by every adapter (telegram, imessage, discord, slack, email, whatsapp, signal beeper + signal-cli, facebook, zalo; about 25 call sites) and returns `void`. Its upsert only ever changes `is_sender` (0 to 1), so "updated" has exactly one meaning today.
  - Adapters receive a `Database` handle but `insertMessage` uses the module singleton in `db.ts`. Origin therefore cannot be passed through the adapter call chain without touching all adapters; an ambient, async-scoped context is the only change-free path.
  - Sync cycles for different platform accounts run concurrently in the daemon (`Promise.all` in `--once`, independent `setInterval` timers otherwise), so a module-global "current origin" would race. `node:async_hooks` `AsyncLocalStorage` (built into Node 24) isolates them.

## Research Log

### Insert outcome detection in SQLite
- **Context**: Requirement 1 needs `inserted | updated | unchanged` without changing stored data.
- **Sources Consulted**: SQLite UPSERT and RETURNING documentation (sqlite.org/lang_upsert.html, sqlite.org/lang_returning.html); existing `upsertChat` already uses `RETURNING id`, proving the bundled SQLite is >= 3.35.
- **Findings**:
  - `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` returns a row in both the insert and the update case, so it cannot tell them apart; `changes()` is 1 in both cases too.
  - `INSERT ... ON CONFLICT(external_id, chat_id) DO NOTHING RETURNING id` returns a row only when a row was actually inserted.
  - The existing conflict rule (`is_sender = CASE WHEN excluded.is_sender = 1 THEN 1 ELSE messages.is_sender END`) is equivalent to a follow-up `UPDATE ... SET is_sender = 1 WHERE external_id = ? AND chat_id = ? AND is_sender = 0` executed only when the incoming `is_sender` is 1. That update changing a row means `updated`; otherwise `unchanged`.
  - The FTS triggers are `AFTER INSERT` and `AFTER UPDATE OF ocr_text`; neither path above changes which triggers fire compared with today.
- **Implications**: two statements inside one `better-sqlite3` transaction reproduce today's semantics exactly and expose the outcome. The event append joins that same transaction.

### Transaction nesting in better-sqlite3
- **Context**: Requirement 2.3 needs message and event in one atomic unit, even if an adapter already wraps writes in its own transaction.
- **Sources Consulted**: better-sqlite3 API docs (`Database#transaction`): nested transaction functions become SAVEPOINTs.
- **Findings**: wrapping the insert in `database.transaction(fn)` is safe both standalone (BEGIN/COMMIT) and nested (SAVEPOINT/RELEASE). Today each `insertMessage` is an autocommit statement, so the commit count per message is unchanged.
- **Implications**: no throughput regression for adapters that insert one message at a time; adapters with their own outer transaction keep their semantics.

### Async-scoped origin context
- **Context**: Requirement 3 needs per-sync-cycle origin without changing adapter signatures.
- **Sources Consulted**: Node.js `AsyncLocalStorage` documentation (stable since Node 16, built into Node 24).
- **Findings**:
  - `als.run(store, fn)` propagates `store` through every promise continuation and timer created inside `fn`, and isolates concurrent runs.
  - Long-lived resources (sockets, emitters) created inside a run keep that run's store for callbacks that fire after the run ended. Example risk: an SDK client created during a first-sync (`backfill`) cycle that later emits live messages.
- **Implications**: the store carries an `open` flag that is cleared when the cycle ends; a closed store is treated as "no context" and yields `backfill` (Requirement 3.5). This is conservative: a late callback never produces a false `live` event.

### Adapter ingestion paths reviewed
- **Context**: confirm every path that stores messages goes through `insertMessage`.
- **Findings**:
  - `grep` shows no `INSERT INTO messages` outside `src/db.ts` (FTS triggers only). All adapters import `insertMessage` from `src/db.ts`.
  - Zalo creates its client per capture session inside the adapter call, so its `onMessage` callbacks fire while the cycle is open.
  - Telegram's standalone script (`src/platforms/telegram/sync.ts` `startListener(client)`) inserts from a GramJS event handler outside any sync cycle; it needs an explicit `live` scope per received message (Requirement 3.6).
  - signal-cli's adapter drains queued notifications inside `syncIncremental`; covered by the cycle scope.
  - The zalo-full-history importer (in progress) will store messages outside a cycle and thus emit `backfill` events by default, which is the intended behavior for a history import.

### Existing daemon behavior to preserve
- **Context**: Requirement 7.3.
- **Findings**: `pollCycle` computes `COUNT(*)` before and after the adapter call, calls `rebuildEmbeddings(platform)` when the count grew, and logs `synced N new messages` or `up to date`. `tests/watch.test.ts` mocks `../src/db` with only `initDb` and `getPlatformLastSyncedAt` and asserts on these behaviors.
- **Implications**: the count logic stays as is; only the adapter call is wrapped. Because `watch.ts` will import new modules that touch `getDb`, `tests/watch.test.ts` must mock the event bus module (or the db mock must grow), otherwise the retention service started through the daemon service registry would hit a missing mock export; the registry module itself is mocked too.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Transactional outbox table + consumer cursors (selected) | Event row appended in the same SQLite transaction as the message; consumers keep a persisted high-water mark | Atomic, durable, at-least-once, zero new dependencies, survives restarts | Single-node only; polling or in-process hint needed for latency | Matches synchronous better-sqlite3 constraint and self-hosted posture |
| SQLite trigger `AFTER INSERT ON messages` writes the event | Event creation fully inside the schema | Impossible to bypass | Trigger cannot see the async origin context; account requires a join anyway; hidden logic | Rejected: origin is a runtime fact |
| Post-sync diff (compare max message id before and after) | No insert change | Very small | Concurrent cycles interleave ids, cannot tell new from re-read rows across accounts, not crash-safe | Rejected: does not meet Req 2.3 |
| In-memory EventEmitter only | Emit on insert | Lowest latency | Not durable, lost on crash, no cross-process | Kept only as the latency hint (Req 6) |
| External broker (Redis, MQTT, NATS) | Standard pub/sub | Cross-process | New service, violates scope and self-hosted default | Out of scope per brief |

## Design Decisions

### Decision: `ackId` covers skipped backfill events
- **Context**: consumers skip `backfill` events by default, but a position that only advances on live events would rescan large backfill runs forever and block retention.
- **Alternatives Considered**:
  1. Read silently advances the position past leading backfill events: surprising mutation on read, breaks Requirement 5.8.
  2. Limit counts returned events only: a read could scan an unbounded number of backfill rows.
  3. Limit counts examined rows; the batch returns `ackId` = id of the last examined row.
- **Selected Approach**: option 3.
- **Rationale**: reads stay side-effect free, cost is bounded by `limit`, and a consumer that acks `ackId` moves past backfill runs naturally.
- **Trade-offs**: a batch may contain zero events but a non-null `ackId`; the consumer loop must ack and continue rather than sleep. Documented in the consumer loop contract.

### Decision: explicit consumer registration, default start "now"
- **Context**: a new consumer must not replay the whole retained history by accident, and a typo in a consumer name must not silently create a fresh cursor.
- **Selected Approach**: `registerConsumer(name, { startFrom })` is idempotent; `readEvents` and `ack` reject unknown names.
- **Trade-offs**: one extra call at consumer startup.

### Decision: AUTOINCREMENT ids and `sqlite_sequence` as the ack upper bound
- **Context**: positions are ids; ids must never be reused after pruning (Req 2.4), and acks beyond the newest event must be rejected (Req 5.6) even if that newest event was already pruned.
- **Selected Approach**: `INTEGER PRIMARY KEY AUTOINCREMENT`; the upper bound is `sqlite_sequence.seq` for `message_events` (0 when absent).

### Decision: origin default is `backfill`
- **Context**: inserts with no declared origin come from importers, tests, standalone scripts, or late callbacks.
- **Selected Approach**: default `backfill`, so the stream errs toward silence rather than floods. The only non-cycle live path (Telegram standalone listener) declares `live` explicitly.

### Generalization (synthesis)
- The wake-up signal, the daemon, and the one-shot sync runner all need "run this sync with origin X and tell me what was stored". One primitive, `runIngest(origin, fn)` returning per-scope stats, serves all three plus the Telegram listener.
- The event row is message-agnostic beyond a reference (`message_id`) plus routing fields (platform, account, chat, timestamps). Later consumers (embedding indexer) can use the same stream unchanged.

### Build vs adopt (synthesis)
- Adopted: SQLite transactions, AUTOINCREMENT, `AsyncLocalStorage`. Nothing to install.
- Rejected adopting a job-queue library (for example a SQLite-backed queue package): adds a dependency for roughly 150 lines of SQL, and none integrates with the existing singleton DB and `better-sqlite3-multiple-ciphers` encryption.

### Simplification (synthesis)
- No per-consumer filter configuration stored in the DB: filtering by origin is a read option; any other filtering (platform, chat) is the consumer's own logic.
- No event types beyond "message inserted": updates do not produce events (Req 2.2).
- No CLI or MCP surface for events in this spec; `getConsumerStatus()` is the observability hook a later surface can call.

### Decision: one overall service shutdown deadline, mode-dependent drain (decision D13)
- **Context**: the first draft gave each daemon service its own 30 s drain timeout. With four services a signal shutdown could take two minutes, longer than any container stop grace period, and "drain" meant different things on shutdown and at the end of a `--once` pass.
- **Alternatives Considered**:
  1. Per-service timeout (first draft): simple, but the total is unbounded as services are added.
  2. One overall deadline shared by all services, reverse order; a single pass drains forward.
- **Selected Approach**: option 2. `SERVICE_SHUTDOWN_DEADLINE_MS = 25_000` total. In `watch` mode a drain starts no new work and only awaits in-flight work, receiving the remaining budget; in `once` mode `runSinglePass` drains forward (producers before consumers) so each consumer sees what the producers before it produced in the same pass, then stops all in reverse.
- **Trade-offs**: a slow early service (action-runner drains first on shutdown) can consume budget meant for later ones; per-service limits (triage 10 s, action-runner 15 s) keep that bounded, and later services are still stopped. Event retention drains first in a single pass, so it prunes only events consumers had passed before the drain; later runs catch up.

### Decision: light shared wiring module (decisions D12, D14)
- **Context**: triage-agent and notifier need action-runner's catalog and offer both in the daemon and in their CLIs, but their feature directories must never import action-runner or the daemon, and the CLIs must not load service runtimes.
- **Selected Approach**: `src/daemon-wiring.ts` holds `DaemonSharedWiring` (optional `actionCatalog`, `approvalOffer`, type-only imports) and `composeSharedWiring(env)`, and imports only types and composition functions. `daemon-services.ts` imports it to build `ctx.shared`; thin entry scripts in `src/cli-entries/` (owned by triage-agent and notifier) import it for the CLIs. Service bodies read `ctx.shared.*` themselves, so action-runner never edits another spec's registry entry.
- **Trade-offs**: one more tiny module and one entry script per CLI, in exchange for a clean import graph that the isolation tests can enforce.

## Risks & Mitigations
- Large first syncs create many `backfill` event rows (one per message) that sit until retention: bounded by the 7-day default; rows are small (about 100 bytes with indexes); consumers that skip backfill still advance past them, so retention is never blocked by them.
- A stale registered consumer blocks retention indefinitely: `getConsumerStatus()` exposes lag; `removeConsumer()` frees retention. Documented for the operator.
- Late SDK callbacks after a cycle closed are tagged `backfill` and therefore skipped by default consumers: conservative by design; adapters that need true live capture outside cycles must open their own `live` scope (as the Telegram listener does).
- Wake-up signal counts may overcount if an adapter's own outer transaction rolls back after `insertMessage` returned: the signal is a hint only; reads are authoritative.
- `tests/watch.test.ts` mocks `../src/db`: new imports require mock updates; called out as an explicit task.

## References
- [SQLite UPSERT](https://www.sqlite.org/lang_upsert.html): DO NOTHING vs DO UPDATE semantics.
- [SQLite RETURNING](https://www.sqlite.org/lang_returning.html): rows returned only for actually inserted or updated rows.
- [SQLite AUTOINCREMENT](https://www.sqlite.org/autoinc.html): monotonic, never reused ids via `sqlite_sequence`.
- [better-sqlite3 transactions](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function): nested transactions become savepoints.
- [Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage): async-scoped context propagation.
- Transactional outbox pattern (microservices.io/patterns/data/transactional-outbox.html): event recorded atomically with the state change.
