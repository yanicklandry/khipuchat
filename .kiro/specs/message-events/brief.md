# Brief: message-events

## Problem
Nothing in khipuchat can react to a new message. The watch daemon only knows "the count went up", so a triage step cannot tell which rows are new, and a crash between sync and processing would silently drop messages.

## Current State
- `src/watch.ts` `pollCycle` takes `COUNT(*)` before and after a sync and, if it grew, calls `rebuildEmbeddings(platform)`. No callback, EventEmitter or post-sync hook exists.
- `insertMessage` (`src/db.ts`) returns void and does `ON CONFLICT(external_id, chat_id) DO UPDATE`, so inserts and updates are indistinguishable.
- Adapters call `embedNewMessages([chatId])` per chat themselves.

## Desired Outcome
Every newly inserted message (any platform, any account) produces exactly one durable event row. Consumers (first: triage-agent) read events after their own cursor and acknowledge them, so processing is at-least-once and survives restarts. Backfills / `--force` re-reads do not flood consumers.

## Approach
Make `insertMessage` report `inserted | updated | unchanged`. In the same transaction, an inserted row appends to a `message_events` table (`id`, `message_id`, `platform`, `account`, `chat_id`, `created_at`, `origin: 'live' | 'backfill'`). A `consumer_cursors` table stores the last processed event id per consumer name. A small `event-bus.ts` exposes `readEvents(consumer, limit)` and `ack(consumer, id)` plus an in-process notify so a consumer running inside the watch daemon wakes immediately after a cycle. Backfill and first-sync inserts are tagged `origin='backfill'` and are skipped by default by consumers. Retention: prune events older than N days once all consumers acked.

## Scope
- **In**: insert result reporting, `message_events` + `consumer_cursors` schema, event-bus API, backfill tagging, retention job, wiring into `pollCycle`, tests on `:memory:` DB.
- **Out**: what consumers do with events (triage-agent), cross-process brokers (Redis, MQTT), webhooks to third parties.

## Boundary Candidates
- DB layer: insert result + events table (db.ts boundary)
- Event bus API (read/ack/notify)
- Daemon wiring (watch.ts)

## Out of Boundary
- Importance decisions, notifications, LLM calls.

## Upstream / Downstream
- **Upstream**: platform-abstraction (schema), incremental-sync, sync-watcher.
- **Downstream**: triage-agent (first consumer); later: embeddings indexing could become a consumer too.

## Existing Spec Touchpoints
- **Extends**: platform-abstraction (`db.ts` insert contract), sync-watcher (`pollCycle`).
- **Adjacent**: semantic-search (`embedNewMessages` per-chat seam, leave unchanged).

## Constraints
- Synchronous better-sqlite3; event append in the same transaction as the insert.
- Adapters must not touch the events table directly; only `db.ts` exported functions.
- Must not change behavior of existing surfaces (parity tests stay green).
