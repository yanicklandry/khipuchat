# Implementation Plan

> Prerequisites (upstream specs, implemented first): triage-agent (`src/triage/outbox.ts`, `src/triage/feedback.ts`, `src/triage/types.ts`), presence-context (`src/presence/snapshot.ts`, `src/presence/types.ts`), message-events (`src/event-types.ts` for `CONSUMER_NAME_PATTERN`, `src/schema-registry.ts` with `SCHEMA_MODULES`, `src/daemon-services.ts` with `DAEMON_SERVICES`, `DaemonServiceContext` (including `mode`), `startDaemonServices`, `stopDaemonServices`, and `runSinglePass`, `src/daemon-wiring.ts` with `DaemonSharedWiring` and `composeSharedWiring`; the optional `approvalOffer` field is added by this plan in task 2.1, D17), cloud-deployment (`src/ingress/types.ts` with `IngressModule.capabilityPaths?` and `IngressContext.env`, `src/ingress/capability.ts` with `signCapability` / `verifyCapability` / `capabilityFromLocals` / `readSigningKey`, `src/ingress/modules.ts`, `src/secret-files.ts` with the notifier secrets already allowlisted, `src/db-path.ts` with `resolveDbPath` and `resolveDataFile`), and slack-all-workspaces (`src/account-health.ts` with unix-second times, `src/platforms/slack/state-store.ts`; compile-time imports for system alerts (7.2) and Slack Open links (3.2)). Task 1.1 confirms these.
>
> Upstream contracts: signed capability paths (D3), the secret `_FILE` allowlist (D2), `IngressContext.env` (D4), and `resolveDataFile` (D5) are owned and implemented by cloud-deployment; the schema registry (D6), daemon services list (D7), shutdown and single-pass semantics (D13), and shared wiring `src/daemon-wiring.ts` (D12, D14) are owned by message-events. This plan never edits their files beyond adding one entry to `src/schema-registry.ts`, `src/daemon-services.ts`, and `src/ingress/modules.ts`, plus one `OPERATIONAL_SCRIPTS` entry in `src/khipu.ts`, and the one-line `approvalOffer?` field with its type-only import on `DaemonSharedWiring` in `src/daemon-wiring.ts` (task 2.1, D17); it creates its own thin CLI entry `src/cli-entries/notify-cli.ts` (D14).
>
> Note: `npm run typecheck` is broken repo-wide (pre-existing). "Compiles" below means `tsc --noEmit` reports no errors for the new or changed files (filtered output) and vitest loads them.
>
> Ownership: 2.4 creates `src/notify/schema.ts` (DDL only) and its `SCHEMA_MODULES` entry, plus `callback-store.ts` and `state.ts`; 2.5 creates `store.ts`; later tasks only call them (2.5 adds functions only when its own bullets say so). 2.6 creates `tests/fixtures/notify-fixtures.ts` (including fake clock and time-zone helpers); 5.1 adds the fake fetch helpers to it. Test files are per task: 4.1 `notify-requests.test.ts`, 4.2 `notify-approvals.test.ts`, 5.1 `notify-channels-http.test.ts`, 5.2 `notify-channels-ntfy.test.ts`, 5.3 `notify-channels-pushover.test.ts`, 5.4 `notify-channels-telegram.test.ts`, 5.5 `notify-channels-registry.test.ts`. `.env.example`: 8.5 adds only the `KHIPU_NOTIFY*` settings (the secret names are cloud-deployment's). 7.7 creates the service-entry file `src/notify/service.ts` (`notifierService`) and adds the `DAEMON_SERVICES` entry. 8.3 creates `src/notify/cli.ts`; 8.4 creates `src/cli-entries/notify-cli.ts` and points the `notify` entry of `OPERATIONAL_SCRIPTS` in `src/khipu.ts` at it (one line).

- [ ] 1. Upstream prerequisites
- [ ] 1.1 Confirm upstream modules and contracts
  - Confirm the verdict feed (register, read, ack, consumer status), feedback recording, presence snapshot reader and presence types, the message-events consumer name pattern, schema registry, daemon services list (with `ctx.mode`, `stopDaemonServices`, `runSinglePass`), and the shared wiring module (`DaemonSharedWiring`, `composeSharedWiring`; the `approvalOffer` field is not required yet, task 2.1 adds it), the ingress module types (including the optional capability path declaration and the env field on the ingress context) and registry, the DB path resolver and data-file resolver, the account health store and the Slack state store exist and export the names the design imports; if any is missing, stop and report which spec must be implemented first.
  - Presence check for cloud-deployment's signed capability paths: `src/ingress/capability.ts` exports `signCapability`, `verifyCapability`, `capabilityFromLocals`, and `readSigningKey`, and a token signed for module `notify` verifies with that module id; the secret-file allowlist contains `INGRESS_SIGNING_KEY`, `NTFY_TOKEN`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`, and `TELEGRAM_NOTIFY_BOT_TOKEN`. This plan implements none of them; if any is missing, stop and report it as a cloud-deployment gap.
  - Confirm the account health times are unix seconds.
  - Observable completion: a short written check result in the task report listing each upstream export and allowlisted secret name as present or missing.
  - _Requirements: 1.1, 4.1, 9.1, 9.9, 10.1, 14.3_

- [ ] 2. Foundation: types, configuration, schema, stores, fixtures
- [ ] 2.1 Declare the notifier vocabulary and the approval offer injection point
  - Declare every type and constant listed in design.md (NotifyTypes), including the urgency to channel priority table.
  - Declare the approval offer interface, the never-offer value, and the default that returns it; the default stays empty permanently (action-runner injects its own offer through the daemon-services wiring and never edits this file); a throwing offer is treated as false by callers.
  - In the same task, add to message-events' `src/daemon-wiring.ts` the type-only import of the approval offer contract and the one optional `approvalOffer` field on the shared wiring type, exactly as in design.md (Modified Files); this is notifier's only sanctioned edit of that file (D17). If the field already exists (added as action-runner's fallback), leave it unchanged.
  - Observable completion: filtered `tsc --noEmit` shows no errors in the new modules and in `src/daemon-wiring.ts` (which now declares the optional `approvalOffer` field through a type-only import), and `tests/notify-approval-offer.test.ts` shows the default never offers.
  - _Requirements: 2.2, 8.3, 11.7_

- [ ] 2.2 Validate the notifier configuration file
  - Accept the version 1 format from the design's file format table: targets keyed by id per channel, routes (critical, default by presence state, per-urgency overrides), quiet hours, collapse limits, redaction default and patterns, callback lifetime, staleness limit, system alert settings, Open link templates, and default time zone, applying every default.
  - Collect every problem with its setting path, including unknown keys, bad ids, out-of-range numbers, invalid time zones, invalid patterns, disallowed link schemes, group Telegram chats without allowed users, and route entries naming missing targets; never throw.
  - Observable completion: `tests/notify-config.test.ts` (file block) shows a complete expedition-style file normalizes with defaults, each invalid field yields a named problem, and a file with several errors reports all of them.
  - _Requirements: 4.7, 14.1, 14.2_

- [ ] 2.3 Resolve settings, secrets presence, and availability
  - Read the enable switch, config path (`resolveDataFile('khipu.notify.json', 'KHIPU_NOTIFY_CONFIG', { env })` on the env passed in, which already lets the env var win, so no separate env check and no `process.env` read), tick interval, health interval, and retention days with defaults and ranges; invalid numbers fall back with a warning naming the setting.
  - Read channel secrets from the given environment only and resolve the signing key with cloud-deployment's `readSigningKey(env)`; mark targets unavailable when their secrets are missing; compute callback availability with its reason (public address missing, signing key missing, signing key too short).
  - Return disabled, invalid, or ok states as specified; secrets never appear in warnings or problems. Provide the file-only loader for the ingress process that takes an env object and reads no secret names.
  - Observable completion: `tests/notify-config.test.ts` (resolve block) shows disabled by switch and by missing file, invalid with problems, each target's availability and reason, every callback reason (including a missing and a too-short signing key, both via `readSigningKey`), the default config path next to the archive regardless of the working directory, the file-only loader reading only the env object passed in, and identical results for local and server deployment profiles.
  - _Requirements: 1.8, 8.5, 14.3, 14.4, 14.5, 14.6_

- [ ] 2.4 Create the notifier tables and the callback and state stores
  - Define the five tables and indexes from design.md (Physical Data Model) in the DDL-only `src/notify/schema.ts` (imports nothing but better-sqlite3 types), idempotent, and register it with one import and one entry in `src/schema-registry.ts`; no lazy schema creation anywhere in the notifier and no change to `src/db.ts`.
  - Implement callback insert, lookup by nonce hash, mark used, and delete per notification; implement the key-value state get, set, and delete.
  - Observable completion: `tests/notify-store.test.ts` (schema block) shows all tables and indexes exist after `initDb` on an in-memory archive through the registry, a second apply changes nothing, callback rows cascade when their notification is deleted, and state values persist.
  - _Requirements: 9.1, 10.5, 12.1_

- [ ] 2.5 Implement the notification store
  - Insert with ignore on duplicate source reference returning whether a row was created; read by id; list by status, due rows (critical first), and due buckets; apply status transitions with an update time; compute the gate counts exactly as defined; reset interrupted sends at startup; prune by retention, keeping in-flight statuses.
  - Observable completion: `tests/notify-store.test.ts` (store block) shows duplicate inserts create nothing, gate counts match hand-computed fixtures for dedupe, burst, and hourly windows, merged rows keep their summary link, and pruning removes only old finished rows and old approvals.
  - _Requirements: 1.4, 6.5, 12.1, 12.4_

- [ ] 2.6 Build shared notifier test fixtures
  - Provide helpers that open an in-memory archive with the schema registry applied, a fake clock with time-zone helpers for quiet-hours tests, and insert important decisions with sources (including the `#08-expedition` Slack scenario, a missing source, and an old decision), insert account health rows (unix-second times), build valid configurations from compact literals, and supply a fake presence reader (together, apart, unknown, throwing).
  - Observable completion: a smoke test seeds the expedition decision and reads it back through the verdict feed as consumer `notifier`.
  - _Requirements: 1.1_

- [ ] 3. Core: pure domain
- [ ] 3.1 (P) Render notification content with redaction and limits
  - Build content for verdicts, health problems and resolutions (with the Slack remedy command), summaries (flattened counts, up to 5 items), tests, and missing sources.
  - Render titles with urgency prefixes and bodies in the documented line order; apply patterns, level rules, the 280-character excerpt cap, and channel limits with the documented shortening order and ellipsis; compute the effective level per target and the response page level.
  - Observable completion: `tests/notify-content.test.ts` shows exact titles and bodies for each urgency and level, pattern replacement in every field, truncation order at each channel limit, the minimal details-link line, and health and summary content.
  - _Requirements: 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 10.2, 10.3_
  - _Boundary: Redactor, ContentBuilder_

- [ ] 3.2 (P) Resolve Open links
  - Build Slack permalinks from the stored workspace URL, channel id, and message timestamp; apply per-platform templates with URL-encoded placeholders; enforce allowed schemes and length; return null on any error, missing source, or missing Slack identity for the account.
  - Observable completion: `tests/notify-open-links.test.ts` shows the expedition permalink, a template result for another platform, a template overriding the Slack default, null for disallowed schemes, missing rows, and a Slack account without a stored identity.
  - _Requirements: 1.7, 8.1_
  - _Boundary: OpenLinks_

- [ ] 3.3 (P) Choose routes from urgency and presence
  - Map the presence snapshot to together, apart, or unknown (errors and null as unknown); choose the critical route regardless of presence, a per-urgency override when configured, else the default route for the presence state; filter out unavailable targets.
  - Observable completion: `tests/notify-routing.test.ts` covers every urgency and presence combination, overrides, a throwing presence reader, and an all-unavailable route.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 14.4_
  - _Boundary: Router_

- [ ] 3.4 (P) Evaluate quiet hours and the delivery gate
  - Resolve the quiet-hours zone (presence, configured, server), evaluate same-day and cross-midnight windows with weekday limits and DST-safe wall-clock times, and return the current window end.
  - Decide queue, suppress as duplicate, or defer to the quiet, burst, or hourly bucket with its release time, in the documented order with test, released-row, and critical exemptions.
  - Observable completion: `tests/notify-gate.test.ts` shows each window shape including a DST change day, zone fallback order, and every gate branch with exact bucket names and release times.
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 6.1, 6.2, 6.3, 6.4_
  - _Boundary: QuietHours, Gate_

- [ ] 3.5 Release deferred buckets into originals or summaries
  - For each due bucket, return a single member to pending as released, or create one summary row (highest urgency with critical lowered to high, shared Open link only when identical, no action buttons) and mark members merged with the summary link, in one transaction protected by the summary's unique source reference.
  - Observable completion: `tests/notify-collapse.test.ts` shows single-member release, a three-member burst summary, a quiet summary that flattens an earlier summary, the critical-to-high rule, the shared-link rule, and that a repeated release creates no second summary.
  - _Requirements: 5.4, 6.2, 6.3, 6.4, 6.5, 6.6_

- [ ] 4. Core: public interfaces for other modules
- [ ] 4.1 (P) Accept notification requests from other modules
  - Validate origin, key, urgency, title, body, Open link, collapse key, and approval subject, returning the documented error codes without throwing; insert a pending request row; return the existing row for a repeated origin and key.
  - Observable completion: `tests/notify-requests.test.ts` shows each error code, idempotent repeats, a stored approval subject, and that the function works on a database handle passed explicitly from another process-style setup.
  - _Requirements: 2.5, 11.1, 11.2, 11.3_
  - _Boundary: NotificationRequests_

- [ ] 4.2 (P) Publish the approval feed
  - Implement consumer register (now or beginning), remove, read with limit clamping, monotonic ack with range checks, status with pending counts, and the internal one-per-notification approval insert, mirroring the verdict feed's semantics and error codes.
  - Observable completion: `tests/notify-approvals.test.ts` shows registration positions, ordered reads, ack errors, a second approval for the same notification rejected, and consumer status lag.
  - _Requirements: 11.5, 11.6_
  - _Boundary: ApprovalFeed_

- [ ] 5. Core: delivery channels
- [ ] 5.1 Provide the HTTP port with timeouts and failure classification
  - Wrap fetch with a 10-second timeout, HTTPS-only (loopback allowed), JSON and form bodies, retry-after extraction, and transient versus permanent classification; failure details carry only status or network codes.
  - Add fake fetch helpers (scripted responses, captured requests) to the shared fixtures.
  - Observable completion: `tests/notify-channels-http.test.ts` shows classification of network errors, timeouts, 5xx, 429 with retry-after, 4xx, and a non-HTTPS rejection, and that no body or header value appears in details.
  - _Requirements: 3.5, 7.5, 7.6, 7.7_

- [ ] 5.2 (P) Send through ntfy
  - Publish JSON to the server root with topic, title, message, priority, tags, click, and up to three actions (Open as a view action, Do it and Not important as POST http actions that clear on success), optional bearer token, and the cache opt-out header; return the message id.
  - Observable completion: `tests/notify-channels-ntfy.test.ts` shows the exact request for each urgency, with and without buttons, token, and cache opt-out.
  - _Requirements: 2.2, 7.1_
  - _Boundary: NtfyAdapter_
  - _Depends: 5.1_

- [ ] 5.3 (P) Send through Pushover and track emergency receipts
  - Send form requests with title, message, priority, supplementary link and label, device, sound, and tag; add retry and expiry for critical; treat quota rejection as permanent and server errors as transient with a minimum 5-second delay; warn once a day on low remaining quota.
  - Poll receipts and cancel receipts as documented.
  - Observable completion: `tests/notify-channels-pushover.test.ts` shows normal and emergency requests, the returned receipt, receipt acknowledged and expired parsing, cancel, and the quota rule.
  - _Requirements: 2.2, 7.2, 7.3, 7.9_
  - _Boundary: PushoverAdapter_
  - _Depends: 5.1_

- [ ] 5.4 (P) Send through the Telegram bot
  - Implement send message (plain text, disabled link previews, silent for low urgency, inline keyboard), get updates (long poll, callback queries only, conflict detection), answer callback query, and replace reply markup, using only the dedicated bot token; never log the token URL.
  - Observable completion: `tests/notify-channels-telegram.test.ts` shows the exact requests, keyboard layout, retry-after handling, the conflict result, and that no file under the notifier imports the Telegram sync client.
  - _Requirements: 2.2, 7.4_
  - _Boundary: TelegramApi, TelegramAdapter_
  - _Depends: 5.1_

- [ ] 5.5 Assemble the channel set from configuration
  - Create adapters only for channels with available targets, exposing the Pushover receipt functions and the Telegram API when present.
  - Observable completion: `tests/notify-channels-registry.test.ts` shows the set for each combination of available secrets.
  - _Requirements: 7.1, 7.2, 7.4, 14.4_

- [ ] 6. Core: callbacks
- [ ] 6.1 Mint callback tokens and plan buttons per send
  - Decide offered actions per kind (verdict with the injected approval offer, request with an approval subject, test, none for health and summary); mint Telegram callback data or link capabilities signed with cloud-deployment's `signCapability` (not reimplemented here) with the configured lifetime, storing only nonce hashes; build action URLs, the menu URL, and the Open button; omit link buttons when callbacks are unavailable; order ntfy buttons and choose the Pushover link.
  - Observable completion: `tests/notify-callbacks.test.ts` (plan block) shows button sets for each kind and channel, Do it absent by default and present with an injected offer and for request approvals, unavailable-callback degradation, Telegram data within 64 bytes, and URLs that verify with the ingress capability helper.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1_
  - _Depends: 1.1_

- [ ] 6.2 Redeem button presses exactly once
  - Apply the documented transaction: lookup, expiry, offered check, per-notification exclusivity, mark used, approval insert for Do it, receipt cancel scheduling; after commit record "not important" feedback with source `notifier`; map a pruned decision to feedback unavailable; test rows only acknowledge; provide the read-only peek for pages.
  - Observable completion: `tests/notify-callbacks.test.ts` (redeem block) shows feedback recorded in the triage decision, one approval for Do it, a second press from another channel reporting the taken action, rejections that write nothing, the cancel follow-up flag, and test acknowledgment without feedback or approval.
  - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.7, 11.6, 13.4_
  - _Depends: 4.2_

- [ ] 7. Integration: orchestration
- [ ] 7.1 Turn verdicts into notification rows
  - Read the feed as consumer `notifier`, suppress stale verdicts, build content and the Open link, insert pending rows, and acknowledge only after the inserts commit; an error leaves the batch unacknowledged.
  - Observable completion: `tests/notify-intake.test.ts` (verdict block) shows first registration starting at the newest decision, exactly one row per decision under redelivery, ack position after insert, stale suppression, the missing-source row, and no ack after an injected insert failure.
  - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7_

- [ ] 7.2 Turn account health changes into system alerts
  - On first run alert for every account in an alerted status and store the highest sequence; afterwards alert on changes into alerted statuses, send resolved alerts at low urgency when enabled, ignore other statuses, and persist the position with each insert; treat the health store's times as unix seconds with no conversion.
  - Observable completion: `tests/notify-intake.test.ts` (health block) shows first-run alerts, a needs-reauth transition, a resolution, resolved alerts turned off, no repeats after a simulated restart, and alert creation times consistent with unix-second health rows.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

- [ ] 7.3 Deliver a queued row along its route
  - On the first attempt record presence state, route, and position; per target plan buttons, render, mark sending, and send; on success record target, channel, reference, rendered text, send time, and the receipt follow-up; retry transient failures with the documented delays up to 3 attempts per target; move on after permanent failures or exhaustion, deleting that attempt's callbacks; record failure with targets tried; support a forced target for tests.
  - Observable completion: `tests/notify-dispatch.test.ts` (deliver block) shows a sent row with presence and target recorded, fallback after a permanent failure, fallback after three transient failures with the right next-attempt times, a fully failed row and its log line, and that only configured hosts were called.
  - _Requirements: 3.4, 4.1, 4.3, 4.5, 4.6, 7.6, 7.7, 7.8_

- [ ] 7.4 Track Pushover acknowledgments and cancellations
  - Poll open receipts every 30 seconds and record acknowledgment time and channel or expiry; cancel receipts flagged after an action elsewhere; keep one request in flight.
  - Observable completion: `tests/notify-dispatch.test.ts` (followups block) shows acknowledgment recorded within one poll, expiry clearing the follow-up, and a cancel request after a Not important press.
  - _Requirements: 7.9, 9.7_

- [ ] 7.5 Process Telegram button presses by polling the bot
  - Long-poll updates from the stored offset, accept presses only from allowed users in the target chat, redeem, answer the press, replace the keyboard with the outcome, persist the offset per update, back off on failures, and log a webhook conflict once.
  - Observable completion: `tests/notify-telegram-poller.test.ts` shows an accepted press with feedback recorded, a rejected foreign user, a repeated press answered as already handled, offset persistence across restarts, and the conflict log line.
  - _Requirements: 9.8, 9.9_

- [ ] 7.6 Run the dispatcher tick
  - In order: verdict intake, one presence read, bucket release, gating of pending rows with counts and quiet state, and sequential delivery of up to 10 due rows, critical first; never overlap ticks; pick up request rows queued by other processes.
  - Observable completion: `tests/notify-dispatch.test.ts` (tick block) shows a verdict sent within one tick, quiet-hour hold and release as one original and as a summary, burst and hourly summaries with merged links, duplicate suppression, and a request row from a separate connection delivered.
  - _Requirements: 1.3, 5.2, 5.4, 6.1, 6.2, 6.3, 11.4_

- [ ] 7.7 Start and stop the notifier with the sync daemon
  - Resolve configuration and log disabled or invalid states; requeue interrupted sends (tables already exist through the schema registry), log target and callback availability, register the verdict consumer, prune at start and hourly, and start the tick, health, follow-up, and Telegram loops; provide drain with a timeout and stop, matching the daemon service handle shape. Drain branches on the context mode: in mode `'watch'` (signal shutdown through `stopDaemonServices`) it starts no new tick or other loop iteration and awaits only the in-flight dispatcher tick, bounded by its timeout; in mode `'once'` (single pass through `runSinglePass`) it dispatches pending work tick after tick until none remains or its timeout bound (the 120 s `timeoutMs` given by `runSinglePass`) is reached.
  - Add one `notifier` entry to `DAEMON_SERVICES` in `src/daemon-services.ts`, after `triage-agent` (and before `action-runner` when present), whose start calls `notifierService({ env: ctx.env, mode: ctx.mode, shared: ctx.shared })`; `notifierService` lives in the service-entry file `src/notify/service.ts`, takes `DaemonSharedWiring` by its message-events type name through `import type` from `src/daemon-services.ts` (D16; no runtime import), and reads `shared.approvalOffer` (default offer when the field is absent); the entry reads no `ctx.approvalOffer` or `ctx.log`; do not edit `src/watch.ts`, and do not edit `src/daemon-wiring.ts` beyond the field added in 2.1.
  - Observable completion: `tests/notify-runtime.test.ts` shows disabled and invalid startup log lines with no feed registration, a valid start registering `notifier`, a mode `'once'` drain delivering several seeded verdicts through a fake channel over multiple ticks and stopping at its bound when work keeps arriving, a mode `'watch'` drain starting no new tick (a seeded pending verdict stays unsent) while awaiting an in-flight tick and returning within its timeout, stop leaving no timers, the entry ordered after `triage-agent`, and the entry started with a `DaemonServiceContext` whose `shared.approvalOffer` is set producing a Do it button while a context without it produces none; existing watch daemon and daemon-services tests still pass.
  - _Requirements: 1.1, 1.8, 10.1, 11.7, 12.4, 14.5, 14.6_

- [ ] 8. Integration: surfaces and docs
- [ ] 8.1 Render the response pages
  - Render menu, confirm, and result pages with HTML-escaped content at the page redaction level, the Open link, one POST form per offered action, and the strict security headers from the design.
  - Observable completion: `tests/notify-ingress.test.ts` (page block) shows escaped hostile content, standard-level details for a minimal target, the forms per offered action, and every required header.
  - _Requirements: 3.6, 8.6, 9.6_

- [ ] 8.2 Mount the notify ingress module
  - Declare the module with its id, body limit, and capability path declaration (the cloud-deployment contract); register GET menu, GET confirm, and POST action routes reading the verified capability through `capabilityFromLocals`, with the documented status codes, JSON or HTML responses, and content-free log lines; read settings only from the ingress context env through the file-only loader; register it in the ingress module list.
  - Observable completion: `tests/notify-ingress.test.ts` (routes block, with the real ingress app) shows GET pages changing nothing, POST recording feedback and approval, 400, 404, and 410 cases, an ingress 401 for tampered and expired capabilities, the config path taken from the ingress context env, and the cloud-deployment isolation test passing with the module registered.
  - _Requirements: 3.5, 9.5, 9.6, 9.9_
  - _Depends: 1.1_

- [ ] 8.3 Add `khipu notify status` and `khipu notify log`
  - Route the `notify` subcommand from the khipu entry point; implement status (enabled state, targets with credential presence, callback availability, feed lag, 24-hour counts, last failure per target, approval consumers) and log (newest first, status filter, limit, optional rendered text).
  - Observable completion: `tests/notify-cli.test.ts` (status and log blocks) shows the expected output for a seeded database, the disabled-callback reason, filters and limits, and no secret value anywhere in the output.
  - _Requirements: 8.5, 12.2, 12.3_

- [ ] 8.4 Add `khipu notify test`
  - Create the thin entry `src/cli-entries/notify-cli.ts`, which calls `composeSharedWiring(process.env)` and then `runNotifyCli(argv, { offer: shared.approvalOffer })`, sets `process.exitCode` from the exit code `runNotifyCli` resolves to (`Promise<number>`, like `runTriageCli`), and holds no other logic, and point the `notify` entry of `OPERATIONAL_SCRIPTS` in `src/khipu.ts` at it with the value `'cli-entries/notify-cli.ts'` (relative to `src/`); `runNotifyCli` uses the default offer when none is passed; no file under `src/notify/` imports `src/daemon-wiring.ts`, `src/daemon-services.ts`, or action-runner modules.
  - Print every configuration problem and exit 1 when invalid; dry-run prints presence, route, and each target's rendered title, body, and buttons without inserting; send mode inserts a test row, delivers it directly through the route or the forced target bypassing the gate, prints the outcome, and exits by result.
  - Observable completion: `tests/notify-cli.test.ts` (test block) shows dry-run output with nothing stored, a sent test through a fake channel during quiet hours, the forced target, exit code 1 on failure and on invalid configuration, that pressing the test button only acknowledges, and that the CLI entry passes the wiring's `approvalOffer` to `runNotifyCli` (Do it present with a stubbed wiring offer) and `khipu.ts` routes `notify` to it.
  - _Requirements: 11.7, 13.1, 13.2, 13.3, 13.4, 13.5_

- [ ] 8.5 Write the operator guide and environment template entries
  - Write `docs/NOTIFY.md` with the sections listed in the design (channels, privacy per relay, full expedition configuration example, callback links, test walkthrough, approval hand-off note) and add only the `KHIPU_NOTIFY*` settings (no values) to `.env.example`, verifying that the five secret names listed by cloud-deployment are present (verification only, no edit to them). The guide states that callback links need `INGRESS_SIGNING_KEY` and that without it ntfy and Pushover carry the Open link only.
  - Observable completion: the guide contains every listed section and a configuration example that `parseNotifyFile` accepts (asserted by a test that extracts and parses the example), and the deploy configuration test passes.
  - _Requirements: 15.1, 15.2, 15.3, 15.4_

- [ ] 9. Validation
- [ ] 9.1 Enforce isolation and log hygiene
  - Add a static test that follows imports from the ingress module, the request API, and the approval feed and fails on channel, runtime, dispatcher, delivery, presence runtime, or LLM imports (allowing DDL-only `*/schema.ts` modules and `src/schema-registry.ts`); fails on any notifier import of platform sync clients, Beeper packages, action-runner modules, `src/daemon-services.ts`, or `src/watch.ts`, or on any runtime import of `src/daemon-wiring.ts` from `src/notify/**`; `import type` from `src/daemon-services.ts` is allowed in `src/notify/service.ts` only (D16), and synthetic cases show a type-only import elsewhere and a value import in `service.ts` both failing; fails when a file reached from the ingress module reads `process.env`.
  - The import checker takes an injectable list of entry files and forbidden patterns, so it can be exercised with synthetic input.
  - Add `tests/notify-log-hygiene.test.ts` that drives a verdict through dispatch, a callback redemption, and an ingress press with captured logs and asserts that no message text, rendered text, nonce, capability, or secret appears (without editing other tasks' test files).
  - Observable completion: `tests/notify-isolation.test.ts` passes on the real tree and includes a case where a synthetic forbidden import makes the checker fail; `tests/notify-log-hygiene.test.ts` passes.
  - _Requirements: 3.4, 3.5, 7.4, 11.7_

- [ ] 9.2 Verify the expedition scenario end to end
  - Seed a `#08-expedition` important verdict with a suggested action; with presence apart, start the runtime in mode `'once'`, drain it, and assert the phone ntfy target received it with three buttons; POST Not important through the real ingress app and assert triage feedback; repeat with a critical verdict delivered by Pushover and an acknowledged receipt; with an injected approval offer, press Do it and read one approval as a fake `action-runner` consumer; check the delivery log rows.
  - Observable completion: `tests/notify-e2e.test.ts` passes with fake fetch only, and the full `npm test` suite passes under Node 24.
  - _Requirements: 1.1, 4.1, 4.6, 7.3, 7.9, 9.2, 9.3, 11.5, 12.1, 14.6_
