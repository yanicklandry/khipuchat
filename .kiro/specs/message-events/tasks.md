# Implementation Plan

> Ownership: 1.2 creates `src/event-schema.ts` (`applyEventSchema`, DDL only) and `src/schema-registry.ts`; 3.6 creates `src/daemon-wiring.ts` (light: `DaemonSharedWiring`, `composeSharedWiring`) and `src/daemon-services.ts`; 3.2 registers the event retention service in it. Ownership of `src/event-store.ts` (DML only): 2.1 creates it with `appendEvent`; 2.4 adds `selectEventsAfter`, `highestAssignedId`, the cursor functions, and `listConsumerStatus`; 2.5 adds `deleteEligibleEvents`. Do not write the whole module in one task.
>
> Note: `npm run typecheck` is broken repo-wide (pre-existing). "Compiles" below means `tsc --noEmit` reports no errors for the new or changed files (filtered output) and vitest loads them.

- [ ] 1. Foundation: shared contracts, schema, and origin scope
- [ ] 1.1 Declare the shared event stream contracts
  - Declare, exactly as specified in design.md (EventTypes): the origin and insert outcome unions, the insert result, the event row shape, read options and batch, registration options, consumer status, the recorded-events signal, ingest stats and ingest outcome, the event bus error with its codes, and the consumer name pattern.
  - Strict TypeScript, no `any`; the only runtime code is the error class and the name pattern.
  - Observable completion: filtered `tsc --noEmit` output shows no errors in the new types module, and a test in `tests/event-bus.test.ts` confirms the name pattern accepts `triage-agent` and rejects an empty name, an uppercase name, a name starting with a digit, and a 65-character name.
  - _Requirements: 2.5, 4.3_

- [ ] 1.2 Add the event stream tables to every archive on open through the shared schema registry
  - Create the DDL-only event schema module: the events table (never-reused increasing ids, one event per message, cascade on message delete, origin restricted to live or backfill), the consumer positions table, and the creation-time index, exactly as in the design's physical data model; it imports nothing but the better-sqlite3 type.
  - Create the schema registry exactly as in design.md (SchemaRegistry): the ordered module list with the event schema as its first entry, and the apply function that applies each module in order and rethrows a failure with the module's name.
  - Make archive open call the registry exactly once, right after the existing migrations; archive open names no feature schema function directly.
  - Add `tests/event-migration.test.ts`: build a temp-file archive with the pre-feature schema and some messages, open it, and check both tables exist, existing chats, messages, sync state, and full-text search results are unchanged, and no events exist; a second open raises no error and changes nothing.
  - Add `tests/schema-registry.test.ts`: the first entry is `message-events`; fake modules apply in order exactly once per call; a throwing module fails with its name in the message; the static imports of the registry and the event schema module are limited to schema modules and type or better-sqlite3 imports (the DDL-only rule other specs' isolation tests rely on).
  - Observable completion: the migration and registry tests pass and the existing database tests still pass.
  - _Requirements: 2.4, 2.6, 4.6, 9.1, 9.2, 9.3, 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ] 1.3 (P) Build the async-scoped origin context
  - Requires 1.1 (uses its insert result, ingest stats, and ingest outcome types); can run in parallel with 1.2 only.
  - Provide the scope runner that runs an async function under a given origin, collects per-scope stats, closes the scope when the function settles, and resolves (never rejects) with success or the error plus stats.
  - Report the current origin as the open scope's origin, or backfill when there is no scope or the scope is closed; record insert results into the open scope and every still-open enclosing scope.
  - A scope opened inside an open scope (Slack backfill inside a daemon cycle) uses its own origin until it closes, then the outer origin applies again; its stats roll up into the outer scope; an inner failure leaves the outer scope open.
  - No database access and no logging in this module.
  - Observable completion: `tests/ingest-context.test.ts` shows backfill with no scope, live preserved across awaits and timers, two concurrent scopes with different origins never crossing, a callback that fires after its scope closed seeing backfill, correct counts and newest event id in stats, a failing function resolving with the error and stats, and a backfill scope nested in a live scope tagging inner inserts backfill, restoring live afterwards, and rolling its counts and newest event id into the outer stats.
  - _Requirements: 3.3, 3.4, 3.5, 3.7_
  - _Boundary: IngestContext_
  - _Depends: 1.1_

- [ ] 2. Core: insert outcome, wake-up signal, consumer API, retention
- [ ] 2.1 Report the insert outcome and append the event atomically
  - Create the event store (data statements only; table creation stays in the event schema module) with its append function, which takes platform and account from the chat row (falling back to the message platform and `default`) and records the message timestamp, origin, and recording time in unix seconds.
  - Replace the single upsert with the design's insert-or-skip, conditional sender upgrade, and lookup sequence inside one transaction, so stored data and conflict behavior are identical to today; on a new message append one event with the current origin, and record the result into the origin scope after the transaction.
  - Make the archive's public insert function return the result; do not expose any event-writing function to adapters.
  - `tests/message-insert.test.ts` on an in-memory archive covers: inserted with ids and exactly one event; unchanged on re-insert with no event; updated when the sender flag goes from 0 to 1 and unchanged when it goes from 1 to 0; stored rows identical to the old behavior for a table of inputs; event fields correct; a missing chat row still stores the message; an event append failure rolls back the message and the error propagates.
  - Observable completion: the new insert tests and every existing database and adapter test pass.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 7.5, 9.6_
  - _Depends: 1.2, 1.3_

- [ ] 2.2 Add the stored-message lookup by archive id
  - Add the archive lookup that returns a stored message by its archive id, or nothing when absent.
  - Observable completion: tests in `tests/message-insert.test.ts` show the lookup returns the row stored by an insert and returns nothing for an unknown id.
  - _Requirements: 1.5_

- [ ] 2.3 (P) Build the in-process wake-up signal
  - Provide subscribe (returning an unsubscribe), notify (synchronous fan-out with each listener isolated and failures logged), and wait-for-events with a timeout and an optional abort signal that resolves signalled, timeout, or aborted and always cleans up.
  - Observable completion: `tests/event-signal.test.ts` shows every subscribed listener receives one signal, a throwing listener does not stop the others, an unsubscribed listener receives nothing, and the wait resolves signalled, timeout (with fake timers), and aborted (including when already aborted).
  - _Requirements: 6.3, 6.4, 6.5, 6.6_
  - _Boundary: EventSignal_
  - _Depends: 1.1_

- [ ] 2.4 Provide consumer registration, reading, acknowledging, and status
  - Requires 2.1 (tests produce events through the real insert function) and 2.3 (re-exports the signal functions).
  - In the event store add the select-after, highest assigned id, cursor, and status functions; in the consumer module register a consumer idempotently with a start position after the newest assigned event (default) or at the beginning, reject invalid names and unknown consumers with the documented error codes, and remove a consumer.
  - Read events after the consumer's position in ascending order, bounding examined rows by the clamped limit, leaving out backfill unless asked, and returning the acknowledge position covering every examined row; reading never writes.
  - Acknowledge monotonically, rejecting negative, non-integer, or beyond-newest values without writing; report per-consumer position, live lag, and last acknowledgement time.
  - Re-export the signal functions and the public types from the consumer module so consumers import a single module.
  - Observable completion: `tests/event-bus.test.ts` on an in-memory archive covers every rule above, including an all-backfill batch with no events but a non-null acknowledge position, the same events returned again when not acknowledged, and ids never reused after events are deleted.
  - _Requirements: 2.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_
  - _Depends: 2.1, 2.3_

- [ ] 2.5 Provide event retention
  - Requires 2.4 (cursors and consumer removal); extends the same consumer module, event store, and test file. Owns `pruneEvents`, `resolveRetentionDays`, `DEFAULT_RETENTION_DAYS`, and the store's `deleteEligibleEvents`.
  - Delete events older than the retention period whose id is at or below every registered consumer's position, or every old event when no consumer is registered; never delete recent or not-yet-passed events.
  - Resolve the retention period from the operator's setting: default 7 days, whole days of at least 1, default plus a warning when the value is present but invalid.
  - Observable completion: tests with a fixed clock show the eligibility rules for zero, one, and several consumers, a removed consumer no longer holding back deletion, and the configuration resolution for missing, valid, and invalid values.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 3. Integration: daemon, one-shot sync, and Telegram listener
- [ ] 3.1 Wire origin scopes and wake-up signals into the watch daemon cycle
  - Requires 2.1, 2.3, and 2.4. Creates the daemon wiring module with the cycle runner and the cycle report.
  - The cycle runner looks up the platform account sync time itself, chooses live for the incremental path and backfill for the full path exactly as the cycle does today, runs the adapter call inside the origin scope, logs and signals when events were recorded, and rethrows an adapter failure after signalling.
  - Replace the cycle's inline sync time lookup and incremental-or-full branch with that runner, leaving the message-count logic, embedding trigger, and log lines untouched.
  - Add a mock of the consumer module to `tests/watch.test.ts` and add the sync time setter to its existing db mock so the new imports resolve; its assertions stay unchanged.
  - `tests/watch-events.test.ts` on an in-memory archive with a fake adapter covers: live and backfill tagging, exactly one signal with correct counts and newest id, no signal when nothing was inserted, a signal plus rethrow when the adapter inserts then fails (events still readable afterwards), and the event count log line.
  - Observable completion: the new integration tests and the unchanged watch tests pass.
  - _Requirements: 3.1, 3.2, 6.1, 6.2, 6.6, 7.1, 7.3, 7.4_
  - _Depends: 2.1, 2.3, 2.4_

- [ ] 3.2 Provide event retention as the first daemon service
  - Requires 3.1, 2.5, and 3.6; extends the daemon wiring module and the daemon service registry.
  - Add the retention runner (reads the operator setting from the given environment, logs the warning, prunes, logs the deleted count, catches and logs any error).
  - Add the event retention service exactly as in design.md (WatchEvents): it runs retention on start, runs it hourly in watch mode, clears its interval on stop, and never declines to start; its drain branches on the run mode: in watch mode (signal shutdown) it starts no new run and resolves immediately, in single-pass mode (drained first in forward order) it runs retention once and resolves. Register it as the first daemon service entry.
  - The daemon's own retention calls and timer are not added to `watch.ts`; retention reaches the daemon only through the service registry wired in 3.6.
  - Observable completion: tests in `tests/watch-events.test.ts` show the runner logs pruned counts and logs and survives a forced failure, and the service runs retention on start, fires at the hourly interval under fake timers in watch mode, runs once on drain in single-pass mode, resolves its watch-mode drain without running retention, and stops its interval; a test in `tests/daemon-services.test.ts` shows the first registry entry is `event-retention`; the watch tests still pass.
  - _Requirements: 8.4, 8.5, 8.6, 8.7, 11.2, 11.6, 11.9_
  - _Depends: 2.5, 3.1, 3.6_

- [ ] 3.3 (P) Tag one-shot sync runs with their origin
  - Run the chosen adapter call of a one-shot sync inside a live scope in incremental mode and a backfill scope in full or forced mode, rethrowing a failed run's error; sync state and forced rebuild behavior unchanged; no signal sent.
  - The existing sync runner tests use their own local database handle, not the archive singleton, so the new tests have the fake adapter capture the current origin during its call and assert on it.
  - Observable completion: tests in `tests/sync-runner.test.ts` show the adapter sees live in incremental mode and backfill on first sync and forced runs, and the existing sync runner tests pass.
  - _Requirements: 7.2_
  - _Boundary: SyncRunner wiring_
  - _Depends: 1.3_

- [ ] 3.4 (P) Mark the standalone Telegram live listener's messages live
  - Run the body of the standalone listener's new-message handler inside a live scope, rethrowing any failure so error behavior is unchanged; the adapter object's no-op listener is untouched.
  - New `tests/telegram-listener.test.ts`: a fake client captures the registered handler; the image and embedding modules are mocked; the handler is invoked with a text message against an in-memory archive.
  - Observable completion: the test shows the message is stored with exactly one live event, and the existing Telegram tests pass.
  - _Requirements: 3.6_
  - _Boundary: Telegram listener wiring_
  - _Depends: 2.1_

- [ ] 3.5 Record the daemon sync time when the cycle's adapter call resolves
  - Requires 3.1; extends the cycle runner in the daemon wiring module. Absorbs roadmap candidate `watch-lastsync` (decision D1).
  - Capture the cycle start time in unix seconds before the adapter call; when the adapter call resolves write it as the platform account sync time; when it rejects leave the sync time unchanged. "Resolves" is the whole rule: an adapter that logs a problem but resolves (Slack's auth-failed cycle) still advances it. No other daemon code writes the sync time.
  - Observable completion: tests in `tests/watch-events.test.ts` on a fresh in-memory archive with a fake adapter that defines both paths show two consecutive daemon cycles: the first takes the full path and tags its events backfill, the second takes the incremental path and tags its events live, and the stored sync time equals the first cycle's start time from an injected clock; a cycle whose adapter call rejects leaves the sync time unchanged and the next cycle repeats the full path; a cycle whose adapter call resolves after logging a problem advances the sync time; the watch tests still pass.
  - _Requirements: 7.3, 7.6, 7.7, 9.6_
  - _Boundary: WatchEvents_
  - _Depends: 3.1_

- [ ] 3.6 (P) Build the shared wiring module and the daemon service registry, and wire them into the watch daemon
  - Requires 1.1 only; can run in parallel with 3.3 and 3.4. Creates the light shared wiring module exactly as in design.md (DaemonWiring): the shared wiring type, created empty (triage-agent and notifier each add their one optional field with its type-only import, as the design says), and the composition function, which returns an empty wiring in this spec. The module imports only types and composition functions, never a service runtime, the service registry, the daemon cycle module, the consumer module, or the archive.
  - Creates the daemon service registry module exactly as in design.md (DaemonServices): run mode type, service handle with the documented watch versus once drain contract, service context with exactly archive handle, environment, run mode, and shared wiring (no logger, no top-level catalog or offer), the ordered service list (empty until 3.2 adds event retention), the one overall shutdown deadline constant of 25 seconds, the single-pass per-service bound constant of 120 seconds, start, signal-shutdown stop, and single pass. It imports the wiring module and re-exports the shared wiring type.
  - Start builds the shared wiring once, calls each service once in order with one shared context, skips and logs a service that declines, and logs and skips a service that fails to start.
  - Signal-shutdown stop walks started services in reverse order under one overall deadline for all of them: each drain gets only the remaining budget, a service reached after the budget is spent is not drained but is still stopped and the skip is logged, every service is stopped, failures are logged and skipped, and it never rejects.
  - Single pass drains started services in forward order (each drain awaited before the next starts, each given the 120 second per-service bound as its timeout), logging and continuing past a failing drain, then stops every service in reverse order; it never rejects.
  - In the watch daemon, start the services once after the adapters are built (run mode from the once flag); on interrupt or terminate, after clearing poll timers and waiting at most 15 seconds for in-flight cycles (the cycle drain timeout constant, down from 30 seconds), run signal-shutdown stop before exit, so the worst case is 15 + 25 = 40 seconds, below the 45 second stop grace period; after a single-pass run, run the single pass before exit. Mock the registry module in `tests/watch.test.ts` (start, stop, and single pass) so its existing assertions stay unchanged.
  - Document in the module headers the one-entry convention, the fixed order (event retention, triage-agent, notifier, action-runner), reverse order on shutdown and forward order in a single pass, the one 25 second deadline (cloud-deployment's 45 second stop grace period must exceed the 15 second cycle wait plus it), that each service body reads the shared wiring itself, that action-runner only fills the composition function and adds its own entry, and that the triage and notify CLI entries are the sanctioned outside consumers of the wiring module.
  - Observable completion: `tests/daemon-services.test.ts` with fake services shows in-order start with the same context holding exactly the four fields and an empty shared wiring, a declining service skipped and logged, a throwing start logged with later services still started, reverse-order drain then stop, two never-resolving drains ending together within one deadline under fake timers with the second given only the remaining budget, a service past the spent budget stopped without being drained and the skip logged, a throwing drain or stop logged without rejecting, a single pass draining in forward order one at a time with the 120 second per-service bound as timeout and then stopping in reverse order, and the wiring module's static import closure limited to type-only and composition imports; the watch tests still pass.
  - _Requirements: 11.1, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11_
  - _Boundary: DaemonServices, DaemonWiring_
  - _Depends: 1.1_

- [ ] 4. Validation
- [ ] 4.1 End-to-end consumer flow across cycles and restarts
  - New `tests/message-events-e2e.test.ts` on a temp-file archive (so a restart can reopen the same archive).
  - Two fake adapters run concurrently through the daemon cycle runner: a first cycle without a sync point produces backfill events, the second cycle reaches the incremental path only through the sync time the first cycle recorded (no manual seeding) and produces live events, and the two adapters' origins never mix.
  - A registered consumer waiting for events is woken by the cycle signal, reads only the live events, and acknowledges. A second consumer reads without acknowledging; the test then simulates a restart by resetting modules and reopening the same archive file, and that consumer receives the same events again. Retention then deletes only events every consumer has passed.
  - Observable completion: the end-to-end test passes and demonstrates the consumer loop contract from design.md.
  - _Requirements: 2.1, 3.1, 3.2, 3.4, 5.2, 5.4, 5.7, 6.1, 6.6, 7.6, 8.1_

- [ ] 4.2 Full regression and constraint check
  - Run the full test suite under Node 24, including the surface-parity, database, watch, sync runner, and every adapter test.
  - Confirm no dependency was added, source changes are limited to the design's file plan (new test files allowed), and every new source file stays under 200 lines.
  - Observable completion: the full suite passes with zero failures and the dependency list is unchanged.
  - _Requirements: 7.3, 9.4, 9.5_
