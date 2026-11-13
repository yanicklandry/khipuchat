# Requirements Document

## Project Description (Input)
**Who has the problem**: the khipuchat operator who wants something (first: the triage-agent) to react to new messages as they arrive, on any platform and any account, while khipuchat runs unattended on a server.

**Current situation**: nothing in khipuchat can react to a new message. The watch daemon only knows "the message count went up" for a platform/account, so a downstream step cannot tell which rows are new. Storing a message does not distinguish a brand-new message from a re-read of one already in the archive. A crash between sync and processing would silently drop messages, and a first sync, a `--force` re-read, or a history import would look exactly like a flood of new messages.

**What should change**: every newly stored message (any platform, any account) produces exactly one durable "new message" event, recorded together with the message itself. Named consumers read events after their own position and acknowledge them, so processing is at-least-once and survives restarts. Each event says whether it came from live syncing or from a backfill; backfill events are skipped by consumers by default so history re-reads do not flood them. A consumer running inside the watch daemon is woken right after a sync cycle that produced events. Old, fully processed events are pruned automatically. What consumers do with events (triage, notification, actions) is out of scope.

## Introduction
This feature gives khipuchat a durable "new message" event stream. It is the foundation of Phase 5 (important-message alerting): the triage-agent is its first consumer, and later consumers (for example embedding indexing) can attach without touching platform adapters. The stream lives in the existing local archive, requires no external service, and must not change any existing query, sync, or indexing behavior.

## Boundary Context
- **In scope**: reporting whether storing a message created, changed, or left it unchanged; recording one event per newly stored message; classifying events as live or backfill; named consumer positions with read and acknowledge; an in-process wake-up signal after a sync cycle; automatic retention of processed events; wiring into the watch daemon and the one-shot sync runner; recording the platform account sync time after each successful daemon cycle (absorbs the former roadmap candidate `watch-lastsync`); the shared schema registry that creates every feature's tables on archive open; the shared daemon service registry that starts, drains, and stops in-daemon services under one shutdown deadline, together with the light shared wiring module through which one service's collaborators reach other services and the command-line entries; automatic upgrade of existing archives.
- **Out of scope**: deciding importance, building LLM context, sending notifications, running actions (triage-agent, notifier, action-runner); cross-process brokers or message queues; webhooks or delivery to third parties; any new CLI, MCP, or web surface for browsing events; changing how embeddings are indexed today.
- **Adjacent expectations**: platform adapters keep storing messages only through the shared archive functions and never record events themselves; the triage-agent registers itself as a consumer, polls on its own fallback interval, and is idempotent per event (delivery is at-least-once); cloud-deployment runs the watch daemon that hosts in-process consumers; zalo-full-history and any other history importer store messages outside a live sync cycle and therefore produce backfill events; slack-all-workspaces opens backfill scopes inside a daemon cycle and relies on this feature to record the daemon sync time (it does not record it itself); every other Phase 5 spec (triage-agent, notifier, action-runner, ingress and others) adds its tables with one entry in the schema registry and its in-daemon service with one entry in the daemon service registry, and never edits the watch daemon for schema creation or service start and stop; the triage-agent and notifier own thin command-line entry scripts that obtain the shared collaborators from the shared wiring module; cloud-deployment sets the container stop grace period above the daemon's 25 second service shutdown deadline plus the sync cycle drain.

## Requirements

### Requirement 1: Message storage outcome reporting
**Objective:** As a developer of a sync path or consumer, I want storing a message to report whether it was new, so that new messages can be told apart from re-reads.

#### Acceptance Criteria
1. When a message whose identity (external id within its chat) is not yet in the archive is stored, the Message Archive shall report the outcome `inserted` together with the archive id of the stored message.
2. When a message whose identity already exists is stored and the stored row changes, the Message Archive shall report the outcome `updated` together with the archive id of the existing message.
3. When a message whose identity already exists is stored and nothing in the stored row changes, the Message Archive shall report the outcome `unchanged` together with the archive id of the existing message.
4. The Message Archive shall store exactly the same message data, and apply exactly the same conflict rules, as it did before this feature, so that existing sync paths that ignore the outcome behave identically.
5. The Message Archive shall provide a lookup that returns a stored message by its archive id, or nothing when no such message exists.

### Requirement 2: Durable new-message events
**Objective:** As a consumer author, I want exactly one durable event per newly stored message, so that no new message is missed or duplicated by the stream itself.

#### Acceptance Criteria
1. When a message is stored with outcome `inserted`, the Message Event Stream shall record exactly one event for that message.
2. When a message is stored with outcome `updated` or `unchanged`, the Message Event Stream shall not record an event.
3. The Message Event Stream shall record the event in the same atomic unit as the message itself, so that after any crash either both the message and its event exist or neither does.
4. The Message Event Stream shall give each event a unique, strictly increasing numeric id that is never reused, including after old events are pruned.
5. The Message Event Stream shall record, for each event, the archive id of the message, its platform, its account, its chat, the message timestamp, the time the event was recorded, and its origin (`live` or `backfill`).
6. The Message Event Stream shall never hold more than one event for the same message.
7. The Message Event Stream shall record events only as a consequence of storing a message; platform adapters shall have no separate way to create, change, or delete events.

### Requirement 3: Live versus backfill origin
**Objective:** As a consumer author, I want each event to say whether it comes from live syncing or from history re-reading, so that first syncs, forced re-reads, and imports do not flood consumers.

#### Acceptance Criteria
1. When a message is newly stored during an incremental sync of a platform account that has a previous successful sync point, the Message Event Stream shall mark its event `live`.
2. When a message is newly stored during a full re-read of a platform account (first sync without a previous sync point, or a forced re-read), the Message Event Stream shall mark its event `backfill`.
3. If a message is newly stored outside any sync cycle that declared an origin (for example a history importer or a test), then the Message Event Stream shall mark its event `backfill`.
4. While several platform accounts sync at the same time, the Message Event Stream shall mark each account's events with that account's own sync origin, without one sync's origin leaking into another.
5. When a sync cycle has finished, the Message Event Stream shall stop applying that cycle's origin to messages stored afterwards by callbacks that outlive the cycle, and shall mark such late messages `backfill`.
6. When the standalone Telegram live listener stores a newly received message, the Message Event Stream shall mark its event `live`.
7. When a sync scope is opened inside another open sync scope (for example a Slack workspace backfill run inside a daemon cycle), the Message Event Stream shall mark messages stored inside the inner scope with the inner scope's origin and shall also count them in the outer scope's statistics, so that the outer cycle reports and signals every event recorded during it.

### Requirement 4: Named consumers and positions
**Objective:** As a consumer author, I want a named, persistent position in the stream, so that my consumer resumes where it left off after a restart.

#### Acceptance Criteria
1. When a consumer is registered with a name that is not yet known, the Message Event Stream shall create a persistent position for it, starting after the newest existing event by default, or before the oldest retained event when the consumer asks to start from the beginning.
2. When a consumer is registered with a name that is already known, the Message Event Stream shall keep that consumer's existing position unchanged.
3. If a consumer name is empty, longer than 64 characters, or contains characters other than lowercase letters, digits, and hyphens (starting with a letter), then the Message Event Stream shall reject it with a descriptive error.
4. If events are read or acknowledged for a consumer name that has not been registered, then the Message Event Stream shall reject the call with a descriptive error naming the consumer.
5. When a consumer is removed, the Message Event Stream shall delete its position so that it no longer holds back retention.
6. The Message Event Stream shall keep consumer positions across process restarts.

### Requirement 5: Reading and acknowledging events
**Objective:** As a consumer author, I want to read events after my position and acknowledge what I processed, so that processing is at-least-once and survives crashes.

#### Acceptance Criteria
1. When a consumer reads events, the Message Event Stream shall return events with ids greater than the consumer's position, in ascending id order, up to the requested limit (default 100, maximum 1000).
2. While a consumer has not asked to include backfill events, the Message Event Stream shall leave `backfill` events out of what it returns to that consumer.
3. Where a consumer asks to include backfill events, the Message Event Stream shall return both `live` and `backfill` events.
4. When a consumer reads events, the Message Event Stream shall also return the position to acknowledge after processing the batch, which covers every event examined in that read including skipped backfill events, so that a run of backfill events never blocks a consumer.
5. When a consumer acknowledges a position, the Message Event Stream shall persist the consumer's position as the larger of its current position and the acknowledged one.
6. If a consumer acknowledges a position greater than the newest recorded event id, then the Message Event Stream shall reject it with a descriptive error and leave the position unchanged.
7. If a consumer reads events and does not acknowledge them before the process stops, then the Message Event Stream shall return the same events again on the consumer's next read.
8. The Message Event Stream shall not change any consumer's position as a side effect of reading.
9. The Message Event Stream shall report, for each registered consumer, its position, the number of retained live events after that position, and the time of its last acknowledgement.

### Requirement 6: In-process wake-up signal
**Objective:** As a consumer running inside the watch daemon, I want to be woken right after a sync cycle that produced events, so that new messages are processed within seconds instead of waiting for my own polling interval.

#### Acceptance Criteria
1. When a watch daemon sync cycle for a platform account finishes and recorded one or more events, the Message Event Stream shall signal every subscribed in-process listener once, with the platform, account, number of live and backfill events, and the newest event id from that cycle.
2. When a watch daemon sync cycle finishes without recording any events, the Message Event Stream shall not signal listeners.
3. If a subscribed listener fails while handling a signal, then the Message Event Stream shall log the failure and continue signalling the remaining listeners, and the sync cycle shall complete normally.
4. When a listener unsubscribes, the Message Event Stream shall stop signalling it.
5. When a consumer waits for new events with a timeout, the Message Event Stream shall resolve as soon as a signal arrives or the timeout elapses, and shall report which of the two happened.
6. The Message Event Stream shall treat the signal as a latency hint only: events recorded by another process, or recorded while no listener was subscribed, shall still be returned by the next read.

### Requirement 7: Sync path integration
**Objective:** As the operator, I want the watch daemon and the one-shot sync command to feed the event stream, so that every configured platform and account produces events with the right origin.

#### Acceptance Criteria
1. When the watch daemon runs a sync cycle for a platform account, the Watch Daemon shall run it with origin `live` when it uses the incremental path and with origin `backfill` when it uses the full re-read path.
2. When the one-shot sync command runs for a platform account, the Sync Runner shall run it with origin `live` in incremental mode and with origin `backfill` in full or forced mode.
3. Apart from recording the sync time (7.6), the Watch Daemon shall keep its existing per-cycle behavior unchanged: the same message-count based "synced N new messages" and "up to date" log lines, and the same embedding rebuild trigger.
4. When a watch daemon sync cycle recorded events, the Watch Daemon shall log the number of live and backfill events recorded for that platform account.
5. If recording an event fails, then the Message Archive shall fail the store of that message the same way any other storage failure fails it, so that the existing per-message and per-cycle error handling applies and no message is stored without its event.
6. When the adapter call of a watch daemon sync cycle for a platform account resolves, the Watch Daemon shall record that platform account's last sync time as the time the cycle started, so that the next cycle for that account takes the incremental path and its new messages are marked `live`.
7. If the adapter call of a watch daemon sync cycle for a platform account rejects, then the Watch Daemon shall leave that platform account's last sync time unchanged.

### Requirement 8: Event retention
**Objective:** As the operator, I want old, fully processed events pruned automatically, so that the event stream does not grow without bound on a long-running server.

#### Acceptance Criteria
1. When retention runs, the Message Event Stream shall delete events that are older than the retention period and whose id is at or below the position of every registered consumer.
2. When retention runs and no consumer is registered, the Message Event Stream shall delete every event older than the retention period.
3. The Message Event Stream shall never delete an event that is newer than the retention period, or that some registered consumer has not yet passed.
4. The Message Event Stream shall use a retention period of 7 days by default, configurable by the operator in whole days.
5. If the configured retention period is missing, not a whole number, or below 1, then the Message Event Stream shall use the default and log a warning when the value was present but invalid.
6. While the watch daemon is running, the Watch Daemon shall run retention once at startup and then at least once per hour, and once at the end of a single-pass run.
7. When retention deletes events, the Watch Daemon shall log how many were deleted.

### Requirement 9: Compatibility and non-regression
**Objective:** As the operator, I want existing archives and surfaces to keep working unchanged, so that adopting the event stream carries no migration risk.

#### Acceptance Criteria
1. When an existing archive without the event stream is opened, the Message Archive shall add the event stream storage automatically, without changing or losing any existing chat, message, sync state, search, or embedding data.
2. When an archive that already has the event stream is opened again, the Message Archive shall leave it unchanged and raise no error.
3. When the event stream is first added to an existing archive, the Message Event Stream shall not create events for messages that were already stored.
4. The Message Archive shall keep every existing query, search, MCP, CLI, and web result identical to before this feature, as verified by the existing surface-parity tests.
5. The Message Event Stream shall work entirely within the local archive, with no external service, network call, or new third-party dependency, and with no Beeper dependency.
6. The Message Event Stream shall record every time it stores (event recording time, message timestamp copy, consumer position times, retention cutoff, and the daemon sync time) in unix seconds.

### Requirement 10: Shared schema registry
**Objective:** As a developer of any Phase 5 feature, I want one ordered place where every feature's tables are created on archive open, so that schema creation is predictable and no feature creates tables lazily on first use.

#### Acceptance Criteria
1. When an archive is opened, the Message Archive shall apply every registered schema module exactly once, in registry order, after the existing migrations.
2. The Message Archive shall register the event stream's tables as the first schema module.
3. The Message Archive shall require every registered schema module to contain only idempotent table and index definitions, with no dependency on any other application module, so that applying it on an archive that already has its tables changes nothing and raises no error.
4. If a registered schema module fails while being applied, then the Message Archive shall fail the archive open with an error that names the failing module.
5. The Message Archive shall let another feature add its tables by adding exactly one schema module and one registry entry, without changing the archive open procedure.

### Requirement 11: Shared daemon service registry
**Objective:** As a developer of any Phase 5 feature that runs inside the watch daemon, I want one ordered registry of in-daemon services that the daemon starts and stops for me, so that no feature edits the daemon to start or stop its work.

#### Acceptance Criteria
1. When the watch daemon starts, the Watch Daemon shall start every registered daemon service exactly once, in registry order, passing each the shared daemon context.
2. The Watch Daemon shall register event retention as the first daemon service; later services are, in order, triage-agent, notifier, and action-runner.
3. When a daemon service declines to start (for example because it is not configured), the Watch Daemon shall skip it and continue starting the remaining services.
4. If a daemon service fails while starting, then the Watch Daemon shall log the failure naming the service and continue starting the remaining services.
5. When the watch daemon receives an interrupt or terminate signal, the Watch Daemon shall wait at most 15 seconds for in-flight sync cycles and then drain and then stop every started service in reverse registry order under one overall shutdown deadline of 25 seconds for all services together (not per service), where each drain starts no new work and only awaits work already in flight, and shall log and continue past a service whose drain or stop fails or whose drain the deadline cuts short, stopping every started service in all cases, so that the worst-case shutdown (15 + 25 = 40 seconds) stays below the container's 45 second stop grace period.
6. When a single-pass run has finished its sync cycles, the Watch Daemon shall drain every started service in forward registry order (producers before consumers), each processing its pending work until none remains or the per-service bound of 120 seconds that the daemon gives it is reached, and shall then stop every started service in reverse registry order before exiting.
7. The Watch Daemon shall provide, through the shared daemon context, the archive handle, the process environment, the run mode, and a shared wiring slot through which one service's collaborators (for example the action-runner's action catalog and approval offer) are handed to other services (triage-agent and notifier).
8. The Watch Daemon shall let another feature add its in-daemon service by adding exactly one registry entry, without changing the daemon's startup or shutdown procedure.
9. The Watch Daemon shall give every service the run mode (`watch` or `once`) through the shared daemon context, so that each service decides its drain behavior from it: in-flight work only on signal shutdown, pending work until none remains in a single-pass run.
10. The Watch Daemon shall compose the shared wiring in a light module that imports only composition functions and types and never a service runtime, so that command-line entries outside the daemon can obtain the same collaborators (the action catalog and the approval offer) without starting or importing any daemon service.
11. Each daemon service shall read the shared collaborators it needs from the shared wiring itself; a feature that provides a shared collaborator shall only populate the shared wiring and add its own registry entry, and shall never edit another feature's registry entry.
