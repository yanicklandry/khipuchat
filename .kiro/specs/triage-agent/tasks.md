# Implementation Plan

> Prerequisite (hard): message-events, llm-provider, presence-context, and cloud-deployment must be implemented first (their modules `src/event-bus.ts`, `src/schema-registry.ts`, `src/daemon-services.ts`, `src/llm-factory.ts`, `src/presence/views.ts`, and `src/db-path.ts` with `resolveDbPath` and `resolveDataFile` are absent today). cloud-deployment is needed by the settings (task 1.2, `resolveDataFile`) and the CLI entry (task 6.2, `resolveDbPath`).
> Prerequisite (soft): slack-all-workspaces is needed only for the rules lint (task 6.1); everything else works without it.
> Task 1.1 confirms these exist before any other work.
>
> Cross-spec decisions (phase5-cross-spec-decisions.md): triage tables live in a DDL-only `src/triage/schema.ts` registered in message-events' `src/schema-registry.ts` (D6); triage starts as one entry in message-events' `src/daemon-services.ts`, and `src/watch.ts` is not edited (D7); `defaultActionCatalog()` stays empty and action-runner's catalog arrives through `ctx.shared.actionCatalog` (set by `composeSharedWiring` in message-events' `src/daemon-wiring.ts`), which the triage entry forwards as `startTriage({ env: ctx.env, actionCatalog: ctx.shared.actionCatalog })`, so action-runner never edits triage files (D7, D12); triage adds the `actionCatalog?` field to `DaemonSharedWiring` in task 1.1 (D17); `ctx.mode` decides drain behaviour: `'once'` evaluates pending events until none remain or the bound (`timeoutMs` given by `runSinglePass`, 120 s, D17), `'watch'` starts nothing new and awaits the in-flight evaluation within the 10 s grace (D13); `khipu triage` runs through the thin entry `src/cli-entries/triage-cli.ts`, and no file under `src/triage/` imports `src/daemon-wiring.ts`, `src/daemon-services.ts` (beyond `service.ts`'s type-only import), or `src/actions/` (D14); the rules path is `resolveDataFile('khipu.triage.json', 'KHIPU_TRIAGE_CONFIG')` (D5); local-only rules work with a compose Ollama via llm-provider's `KHIPU_LLM_LOCAL_HOSTS` (D10).
>
> Note: `npm run typecheck` is broken repo-wide (pre-existing). "Compiles" below means `tsc --noEmit` reports no errors for the new or changed files (filtered output) and vitest loads them.
>
> Ownership of `tests/triage-judge.test.ts`: 4.4 creates it (budget block) and 4.5 adds the judge block. Ownership of `src/triage/decision-store.ts`: 3.1 writes the whole module; 3.2 and 3.3 only call it. Ownership of `src/triage/cli.ts` and `src/triage/cli-format.ts`: 6.2 creates both; 6.3 and 6.4 register their subcommands with one line each and only add formatters. Test files: 6.1 creates `tests/triage-cli.test.ts` (lint block) and 6.2, 6.3, 6.4 add their own describe blocks; 1.1 creates `tests/triage-action-mapping.test.ts` (catalog block) and 2.4 adds the mapping block; 1.4 creates `tests/fixtures/triage-fixtures.ts` and 4.1 and 4.5 add the fake presence provider and fake judge to it.

- [ ] 1. Foundation: contracts, settings, schema, fixtures
- [ ] 1.1 Declare the shared triage vocabulary and the action catalog contract
  - Confirm `src/event-bus.ts`, `src/schema-registry.ts` (`SCHEMA_MODULES`), `src/daemon-services.ts` (`DAEMON_SERVICES`, `DaemonService`, `DaemonServiceContext` with `mode` and `shared`, `ServiceHandle`), `src/daemon-wiring.ts` (`composeSharedWiring`, `DaemonSharedWiring`), `src/llm-factory.ts`, `src/presence/views.ts`, and `src/db-path.ts` (`resolveDbPath`, `resolveDataFile`) exist and export the names this design imports; if any is missing, stop and report which spec must be implemented first. Only report (do not stop) when the Slack settings resolver is missing; 6.1 re-checks it.
  - Declare, exactly as specified in design.md (TriageTypes): urgency, policy, routing, failure behavior, JSON value, suggested action, the verdict, decision kind, outcome, skip reason, judge failure, served model info, decision draft, stored decision, feedback value and source, and the normalized rule, identity, rule set, match input, and chat info shapes.
  - Declare the action descriptor and catalog interfaces, the empty catalog, the permanently empty default catalog (`defaultActionCatalog()`, never edited by action-runner; its catalog arrives by injection), and the snapshot helper that drops descriptors with a bad id, duplicate id, empty description, or non-object root schema and turns a throwing catalog into an empty list with a problem.
  - In the same task, add to message-events' `src/daemon-wiring.ts` the type-only import of the catalog contract and the one optional `actionCatalog` field on the shared wiring type, exactly as in design.md (Modified Files); this is triage's only sanctioned edit of that file (D17). If the field already exists (added as action-runner's fallback), leave it unchanged.
  - Observable completion: filtered `tsc --noEmit` shows no errors in the new modules and in `src/daemon-wiring.ts` (which now declares the optional `actionCatalog` field through a type-only import), and `tests/triage-action-mapping.test.ts` (catalog block) shows the default catalog is empty and the snapshot drops each invalid descriptor kind and survives a throw.
  - _Requirements: 6.1, 6.7, 8.6_

- [ ] 1.2 Resolve triage settings with safe defaults
  - Read the disable switch, rules path (`KHIPU_TRIAGE_CONFIG`, default from `resolveDataFile('khipu.triage.json', 'KHIPU_TRIAGE_CONFIG')`, so it sits next to the archive regardless of the working directory; `KHIPU_TRIAGE_RULES` is not read), fallback poll, maximum message age, context size, hourly model budget, global local-only switch, and retention days, with the defaults and ranges from the design's settings table.
  - Out-of-range or unparseable values fall back to the default and produce a warning naming the setting; nothing is fatal.
  - Observable completion: `tests/triage-config.test.ts` shows every default, each valid override, `KHIPU_TRIAGE_CONFIG` winning over the default, the default resolving next to the archive path and not to the working directory, and one warning per invalid value naming the setting.
  - _Requirements: 1.4, 1.12, 1.13, 2.1, 5.3, 7.3, 7.6, 9.5_

- [ ] 1.3 Add the decision tables to every archive on open
  - Create the DDL-only module `src/triage/schema.ts` exporting `applyTriageSchema(db)` (importing nothing but database types) that creates the decisions table (never-reused increasing ids, checks on kind, outcome, policy, urgency, feedback), the partial unique index on event id for event decisions, the message and creation-time indexes, and the downstream cursor table, exactly as in the design's physical data model.
  - Register it in message-events' `src/schema-registry.ts` with one import and one `SCHEMA_MODULES` entry after the event stream schema, idempotently; do not edit `src/db.ts` and add no lazy schema creation on first use.
  - Observable completion: `tests/triage-decision-store.test.ts` (schema block) shows both tables and indexes exist after opening an in-memory archive through `initDb`, a second open changes nothing, the registry lists the triage entry after the event schema, and existing database tests still pass.
  - _Requirements: 9.1, 9.6, 9.7_

- [ ] 1.4 Build shared triage test fixtures
  - Provide helpers that seed chats and messages (including replies, OCR text, own messages, and old timestamps), record live and backfill events through the event stream's origin scope, build rule sets from compact literals, and supply a fake catalog (including an `adv-report` action with a strict params schema). The fake presence provider and scripted fake judge are added later by 4.1 and 4.5, once their interfaces exist.
  - Observable completion: a smoke test seeds the expedition scenario (Slack account `work`, chat `#08-expedition`, a transaction message) and reads back one live event for it.
  - _Requirements: 3.1, 5.1_

- [ ] 2. Core: rules domain
- [ ] 2.1 (P) Parse and validate the rules file
  - Accept the version 1 format from the design's file format table, normalizing single strings to lists, lowercasing names and keywords, stripping a leading `#` from chat names, recognizing `id:<n>` chat entries, and compiling the regular expression with its flags and length cap.
  - Apply defaults for default policy, default routing, default failure behavior, and default urgency, and resolve each rule's failure behavior from its urgency when unset.
  - Collect every problem with a path naming the rule position and id and the field, rejecting unknown keys, duplicate ids, bad ids, bad enums, and invalid patterns; never throw.
  - Observable completion: `tests/triage-rules-parse.test.ts` shows a valid expedition file normalizes as documented, each invalid field yields a named problem, and a file with several errors reports all of them in one result.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7, 2.9, 8.3_
  - _Boundary: RulesParser_

- [ ] 2.2 (P) Match messages against rules deterministically
  - Evaluate rules in file order and return the first match with its policy, routing, failure behavior, urgency, and named captures, or the default policy when none matches.
  - Implement every condition from the design (platform, account, chat by name or platform id or archive id, chat type, sender by name or id, keywords, regex, direct message to the user, mention of the user) with OR within a list, AND across conditions, empty conditions matching everything, case-insensitive comparisons, and text plus OCR text capped at 10 000 characters.
  - Observable completion: `tests/triage-rules-match.test.ts` covers each condition alone and combined, first-match ordering, default fallback, mention by `@name` and by platform id, direct-message detection, and capture extraction, with no network or database access.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.10_
  - _Boundary: RuleMatcher_

- [ ] 2.3 Load, fingerprint, and hot-reload the rules file
  - Load the file, compute the 12-character content fingerprint, and report missing versus invalid distinctly.
  - Provide a rules source that re-checks the file modification time on each use, switches to a changed valid file, and keeps the last valid rules with one log line per change when the new file is invalid or missing.
  - Observable completion: `tests/triage-rules-source.test.ts` with injected file reads shows the fingerprint changes with content, a valid edit takes effect on the next use, and an invalid edit keeps the previous version and logs once.
  - _Requirements: 2.5, 2.6, 2.8_
  - _Depends: 2.1_

- [ ] 2.4 (P) Resolve rule-mapped suggested actions
  - Substitute `${name}` placeholders from regex captures plus the built-in message id and chat id, recursively in arrays and objects.
  - Return a note instead of an action when the action id is not in the catalog snapshot or a placeholder cannot be resolved.
  - Observable completion: `tests/triage-action-mapping.test.ts` shows nested substitution, a missing capture note, and an unknown action id note.
  - _Requirements: 4.4, 4.5, 4.6_
  - _Boundary: ActionMapping_

- [ ] 3. Core: decision data and downstream entry points
- [ ] 3.1 Store, read, and prune decisions
  - Insert a draft with JSON columns for action params, presence view, and notes, truncating the accepted model answer to 4000 characters, returning no id when an event decision already exists.
  - Provide event existence checks, lookup by id, latest event decision for a message, newest-first listing with important-only, rule, and limit filters, 24-hour counts by outcome, highest assigned id, feedback update returning the previous value, and pruning by age that keeps important event decisions not yet passed by every registered downstream consumer.
  - Map rows back with type guards; an unreadable JSON column becomes empty plus a note, never an exception.
  - Observable completion: `tests/triage-decision-store.test.ts` shows a draft round-trips field for field, a second insert for the same event returns no id, ids are not reused after pruning, and pruning honors cursor positions, kind, and importance.
  - _Requirements: 1.6, 2.8, 9.1, 9.2, 9.3, 9.5, 9.6, 11.2, 11.3_

- [ ] 3.2 (P) Provide the hand-off feed for notifier and action-runner
  - Implement consumer registration (idempotent, start after the newest decision by default or from the beginning on request), removal, reading in id order with an examined-row limit and an ack id that also passes skipped rows, monotonic acknowledgement with range checks, and per-consumer status with pending important count.
  - Return only important event decisions, each with the full verdict and the source joined from the message and chat (excerpt of at most 280 characters, one line), or no source when the message is gone.
  - Reject invalid names, unknown consumers, and invalid or out-of-range acknowledgements with the categorized feed error and no state change.
  - Observable completion: `tests/triage-outbox.test.ts` shows replays and not-important decisions never appear, unacknowledged records are returned again, the ack id passes skipped rows, every error code, and the status counts.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_
  - _Boundary: VerdictOutbox_
  - _Depends: 3.1_

- [ ] 3.3 Record user feedback on decisions
  - Accept `not_important` or `important` from `notifier` or `cli` for a decision id, store value, source, and time, report the previous value, and keep only the latest value.
  - Return categorized errors for unknown decisions, unaccepted values, and unaccepted sources without changing anything; never touch other columns.
  - Observable completion: `tests/triage-feedback.test.ts` shows first and repeated feedback, each error code, and that verdict fields and feed contents are unchanged afterward.
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - _Boundary: Feedback_
  - _Depends: 3.1, 3.2_

- [ ] 4. Core: judgment context and model call
- [ ] 4.1 (P) Read conversation context and presence for a judgment
  - Read chat info by archive id, the newest N messages strictly before the evaluated message returned oldest first, and the parent message of a reply.
  - Assemble the judgment context with the documented truncation limits, times rendered in the presence time zone when known, `me` for the user's own messages, the matched rule's description, hint, and preferred action, the presence view, and the available actions.
  - Provide the presence provider that passes only the LLM-bound presence view and returns none on any error, and add a fake presence provider to the shared triage fixtures.
  - Observable completion: `tests/triage-context.test.ts` on an in-memory archive shows 10 preceding messages oldest first, the parent of a reply, truncation at each limit, and an unavailable presence when the presence settings are invalid; no raw coordinates appear in the context.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - _Boundary: ArchiveReads, ContextBuilder_

- [ ] 4.2 Build the judgment prompt
  - Produce the system turn (role, urgency scale, untrusted-content instruction, choose only listed actions or none, presence guidance, JSON-only output) and the delimited user turn with rule, presence, actions, conversation, and message blocks; export the prompt version.
  - Observable completion: `tests/triage-context.test.ts` (prompt block) shows each block present, the untrusted-content and allowlist instructions present, "presence unavailable" when absent, and the preferred action named when the rule maps one.
  - _Requirements: 4.7, 5.4, 5.7, 5.8_
  - _Depends: 4.1_

- [ ] 4.3 (P) Build the strict verdict schema and normalize answers
  - Generate the structured-output schema named `triage_verdict` from the catalog: every object closed, every property required, `suggested_action` either null-only (empty catalog) or a choice of null or one branch per action with its id fixed and its params schema; memoize by catalog content.
  - Normalize an accepted answer: drop an action whose id is not in the catalog or whose verdict is not important (with notes), trim the reason to 500 characters with a default when empty, collapse the summary to one line of at most 200 characters, and attach the presence view.
  - Observable completion: `tests/triage-verdict-schema.test.ts` shows the strict-subset shape for empty and two-action catalogs, identical schema objects for identical catalogs, and each normalization rule with its note.
  - _Requirements: 6.2, 6.4, 6.5, 6.6, 6.7_
  - _Boundary: VerdictSchema_

- [ ] 4.4 (P) Cap model calls with an hourly budget
  - Track model calls in a sliding one-hour window, refuse a call once the configured cap is reached, and allow calls again as old entries age out; a cap of 0 refuses every call.
  - Observable completion: `tests/triage-judge.test.ts` (budget block) with an injected clock shows refusal at the cap, recovery after one hour, and refusal of every call at cap 0.
  - _Requirements: 7.6_
  - _Boundary: LlmBudget_

- [ ] 4.5 Route judgments to the right model
  - Build the default client from the operator settings and the local-only client as an Ollama-only override that clears every OpenAI-compatible endpoint setting and the fallback; build no default client under global local-only; turn construction errors into problems instead of exceptions.
  - Consult the budget before each call; call structured chat with the generated schema, purpose `triage`, temperature 0, and no tools; map success to the answer, raw text, and served info, and map every model error, a missing client, and budget refusal to the documented failure categories with served info when known.
  - Add a scripted fake judge to the shared triage fixtures.
  - Observable completion: `tests/triage-judge.test.ts` with llm-provider's fake transport shows local-only never reaches the OpenAI-compatible transport, global local-only builds no default client, a local-only judgment against a non-loopback Ollama host listed in `KHIPU_LLM_LOCAL_HOSTS` succeeds without the cloud opt-in, budget refusal yields `budget_exceeded`, and cloud-not-allowed, invalid structured output, timeout, and construction failure each produce the expected category; the recorded request carries purpose `triage` and no tools.
  - _Requirements: 5.9, 6.3, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 8.4, 8.5_
  - _Depends: 4.2, 4.3, 4.4_

- [ ] 5. Core: orchestration
- [ ] 5.1 Decide one message end to end
  - Implement the evaluation order from the design (missing message, own message, too old unless replaying, chat lookup, rule match) and each policy branch: skip, always-notify with presence and rule action, and llm with catalog snapshot, presence, context, and judge.
  - On judgment failure, apply the failure behavior: important "Could not triage" with rule urgency and resolvable rule action, or not important with the failure recorded; catalog problems become notes.
  - Provide the rules-only preview that reports the skip reason or match and whether a model would be asked, with no model call and no write.
  - Observable completion: `tests/triage-pipeline.test.ts` produces the documented draft for every branch of the policy flow, including latency, rules version, prompt version, and notes, and shows a model is called only for `llm` policy.
  - _Requirements: 1.8, 1.13, 3.9, 4.1, 4.2, 4.3, 7.1, 8.1, 8.2, 8.3, 8.6_
  - _Depends: 2.2, 2.3, 2.4, 4.5_

- [ ] 5.2 Consume live events with exactly-once decisions
  - Register as `triage-agent`, read live events in batches of 50, skip events that already have a decision, evaluate and insert each new one, acknowledge per event and per batch, and wait for the wake-up hint with the fallback poll when caught up.
  - Retry a failing event twice after a short delay, then record an internal-error decision (or log abandonment) and move past it; a failure on one event never stops later ones.
  - Stop takes no new event and waits for the in-flight evaluation at most the grace period, discarding a draft completed after the grace without recording or acknowledging it; a second stop is a no-op. Drain evaluates pending events until none remain without waiting, on the same serialized path as the loop, and ends after the in-flight event when stopped.
  - Observable completion: `tests/triage-consumer.test.ts` with the real event stream on an in-memory archive shows backfill passed over, a redelivered event producing one decision and one evaluation, a wake-up signal starting evaluation promptly, the poison-event path, stop discarding the in-flight draft and a second stop changing nothing, and drain returning the number recorded and ending early when stopped.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.9, 1.10, 1.11, 8.7_
  - _Depends: 3.1, 5.1_

- [ ] 5.3 Compose and start triage in the daemon process
  - Resolve settings, take the action catalog from `StartTriageOptions.actionCatalog` (falling back to the empty default), stay disabled with one explanatory log line when switched off, when the rules file is missing, or when it is invalid (logging every problem); otherwise build judge clients (logging construction problems once), budget, presence provider, pipeline, and consumer, run retention at start and hourly, and return a handle with drain and an idempotent stop that also clears the retention timer. Log through triage's own logger (the `log` option, default console); no logger comes from the daemon context.
  - Emit one decision log line per decision with ids, platform and account, chat name, outcome, urgency, rule, model, and latency, and never message text, answers, or presence.
  - Observable completion: `tests/triage-runtime.test.ts` shows the three disabled cases return no handle and log why, a broken model configuration still starts and records `llm_unavailable` fallbacks, retention runs and a pending important decision behind a registered downstream consumer survives the startup prune, and captured log lines contain no seeded message text.
  - _Requirements: 1.10, 1.11, 1.12, 8.5, 9.4, 9.5, 13.1, 13.5_

- [ ] 6. Command surface
- [ ] 6.1 (P) Lint rules against the action catalog and Slack watch lists
  - First confirm the Slack settings resolver from slack-all-workspaces exists; if not, stop and report it.
  - Warn for rule-mapped action ids missing from the catalog and for rules on Slack chats absent from the matching Slack accounts' watch lists, read-only through the Slack settings resolver and account registry; return no Slack warnings when Slack is not configured.
  - Observable completion: `tests/triage-cli.test.ts` (lint block) with a fake watch lookup and fake catalog shows both warning texts and none for a watched chat.
  - _Requirements: 2.9, 12.2_
  - _Boundary: RulesLint_

- [ ] 6.2 Add the `khipu triage` entry and the rules test command
  - First confirm `resolveDbPath` from cloud-deployment exists; if not, stop and report it.
  - Create `runTriageCli(argv, { catalog?, env?, out?, err? })` in `src/triage/cli.ts` returning the exit code: subcommand dispatcher with help, archive opening through the configured database path, the action catalog taken only from `options.catalog` (falling back to the empty default; no import of `src/daemon-wiring.ts`, `src/daemon-services.ts`, or `src/actions/` from triage files), a shared not-found error helper that exits with status 1, and shared human and JSON formatting. The entry script that injects the catalog is added in 7.1.
  - Implement `test --rules` (validate, print problems or version and rule count, then lint warnings, exit 1 when invalid) and its preview mode for listed message ids or recent messages, with no model calls and nothing stored.
  - Observable completion: `tests/triage-cli.test.ts` shows an injected catalog is used by the lint and the empty default applies when none is passed, exit codes for valid and invalid files, lint output, a preview table with matched rule and "would ask model", identical fields in `--json`, and no new decision rows.
  - _Requirements: 12.1, 12.2, 12.3, 12.11_
  - _Depends: 5.1, 6.1_

- [ ] 6.3 Replay a message against current rules and model
  - Show the stored event decision for the message next to a new replay evaluation; `--rules-only` shows the preview instead; `--save` stores the replay with a reference to the original.
  - Observable completion: `tests/triage-cli.test.ts` shows side-by-side output, no rows written without `--save`, a saved replay that never appears in the hand-off feed, and exit 1 for an unknown message id.
  - _Requirements: 12.4, 12.5, 12.6_
  - _Depends: 6.2, 3.2_

- [ ] 6.4 Inspect decisions and record feedback from the terminal
  - Implement `log` (newest first, important-only, rule, and limit filters, default 20), `show` (full decision with presence summary, model details, notes, feedback), `status` (enabled state, rules path and version, model provider and destination, triage consumer lag, 24-hour counts, downstream consumers), and `feedback` (source `cli`, prints previous value).
  - Observable completion: `tests/triage-cli.test.ts` shows each command's human and `--json` output on seeded decisions and exit 1 for unknown decision ids.
  - _Requirements: 12.7, 12.8, 12.9, 12.10, 12.11, 12.12_
  - _Depends: 6.2, 3.3_

- [ ] 7. Integration
- [ ] 7.1 Wire triage into the sync daemon and the command router
  - Add `src/triage/service.ts` with the `triage-agent` entry typed as message-events' `DaemonService` (type-only import of `DaemonService`, `DaemonServiceContext`, `ServiceHandle`): `start(ctx)` calls `startTriage({ env: ctx.env, actionCatalog: ctx.shared.actionCatalog })`, reads no `ctx.actionCatalog` or `ctx.log`, and returns null when triage is disabled.
  - Its handle branches on `ctx.mode`: in `'once'`, `drain(timeoutMs)` evaluates pending live events until none remain or the bound (`timeoutMs`, 120 s from `runSinglePass`) passes, then stops and leaves the rest unacknowledged; in `'watch'`, `drain(timeoutMs)` starts no new evaluation and awaits the in-flight one within the 10 s grace (or `timeoutMs` when smaller), discarding it after; `stop()` is synchronous and idempotent.
  - Register it in message-events' `src/daemon-services.ts` with one import and one `DAEMON_SERVICES` entry after event retention and before notifier and action-runner; do not edit `src/watch.ts`, and do not edit `src/daemon-wiring.ts` beyond the field added in 1.1.
  - Add the thin entry `src/cli-entries/triage-cli.ts`: call `composeSharedWiring(process.env)` from `src/daemon-wiring.ts`, then `runTriageCli(argv, { catalog: shared.actionCatalog })`, and set the exit code; nothing else. Point `OPERATIONAL_SCRIPTS['triage']` in `src/khipu.ts` at `cli-entries/triage-cli.ts` and list `khipu triage` in help.
  - Observable completion: `tests/triage-runtime.test.ts` (service block) shows the entry returns null when disabled, forwards `ctx.shared.actionCatalog`, in `'once'` mode drains every pending live event and leaves the rest unacknowledged when the bound passes, in `'watch'` mode starts no new evaluation and discards the in-flight draft after the grace, and a repeated `stop()` has no effect; message-events' daemon-services tests and `tests/watch.test.ts` pass unchanged with the entry present; a test in `tests/khipu.test.ts` resolves `triage` to `cli-entries/triage-cli.ts`; a test with a stubbed wiring shows the entry passes `shared.actionCatalog` to `runTriageCli`; with no rules file the daemon logs that triage is disabled and otherwise behaves as before.
  - _Requirements: 1.1, 1.10, 1.11, 12.1, 13.1_
  - _Depends: 5.3, 6.2_

- [ ] 7.2 Ship the example rules file and settings template
  - Add an annotated example rules file for the expedition scenario (Slack `#08-expedition`, transaction regex with a named group, hint about the ADV report, `adv-report` action mapping, a noise skip rule, mentions and direct messages escalated to the model), the `KHIPU_TRIAGE_*` block in the environment template (including `KHIPU_TRIAGE_CONFIG` and a note that local-only rules against a compose Ollama need llm-provider's `KHIPU_LLM_LOCAL_HOSTS=ollama`), the operator guide, and a README pointer.
  - Observable completion: a test parses the example file with the rules parser without problems, and cloud-deployment's environment template check still passes with the new variables listed.
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 2.1_

- [ ] 8. Validation
- [ ] 8.1 Enforce import isolation and dependency rules
  - Walk the transitive import graph from the hand-off feed and feedback modules and fail if it reaches query surfaces, the tool registry, MCP, web, ask, the daemon services list, action-runner modules, model client runtime modules, or presence runtime modules, while explicitly allowing the archive module, `src/schema-registry.ts`, and DDL-only schema modules; assert `src/triage/schema.ts` imports only types; assert no file under `src/triage/` imports `src/watch.ts`, `src/daemon-wiring.ts`, or `src/actions/**`, and that only `src/triage/service.ts` references `src/daemon-services.ts`, type-only (D14); assert `src/cli-entries/triage-cli.ts` imports only `src/daemon-wiring.ts` and `src/triage/cli.ts`; assert no Beeper import anywhere under the triage tree and no new package in the manifest; assert no network primitive is used outside the model client.
  - Observable completion: `tests/triage-isolation.test.ts` passes and fails when a forbidden import is temporarily added in a fixture graph.
  - _Requirements: 10.9, 13.2, 13.3, 13.4_

- [ ] 8.2 Prove the expedition scenario end to end
  - On a temp-file archive: store a Slack transaction message in `#08-expedition` inside a live ingest scope, signal, let the runtime with a fake model and fake `adv-report` catalog decide important with the action, read it from the hand-off feed as `notifier` and `action-runner`, acknowledge, record "not important" feedback, then restart the runtime and confirm no re-evaluation and no redelivery.
  - Observable completion: `tests/triage-e2e.test.ts` passes, asserting the stored verdict fields, source, action params from the named group, feedback, and a single model call across the restart.
  - _Requirements: 1.3, 1.6, 1.7, 4.4, 6.1, 10.1, 10.3, 10.5, 10.6, 11.1, 11.2_
  - _Depends: 7.1_

- [ ] 8.3 Run the full regression suite
  - Run `npm test` under Node 24 and confirm all existing tests (including surface parity and watch tests) and all triage tests pass, and that no log line in triage tests contains seeded message text.
  - Observable completion: the full suite passes with zero failures.
  - _Requirements: 13.1, 13.5_
