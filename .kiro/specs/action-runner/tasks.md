# Implementation Plan

> Prerequisites (upstream dependencies): triage-agent (`src/triage/action-catalog.ts` types, `outbox.ts`, `decision-store.ts`, `types.ts`, `StartTriageOptions.actionCatalog`), notifier (`src/notify/requests.ts`, `approvals.ts`, `approval-offer.ts` type, `types.ts`, `StartNotifierOptions.offer`), cloud-deployment (`src/deployment.ts`, `src/secret-files.ts`, `src/db-path.ts` with `resolveDataFile`, `src/ingress/types.ts` with `IngressContext.env`, `src/ingress/modules.ts`), and message-events (`src/daemon-services.ts` with `DAEMON_SERVICES`, `ServiceHandle`, and `DaemonServiceContext` with `env`, `mode`, `shared`; `src/daemon-wiring.ts` with `DaemonSharedWiring` and `composeSharedWiring(env)`; `src/schema-registry.ts` with `SCHEMA_MODULES` called by `initDb`) must be implemented first. Task group 9 additionally needs presence-context (`src/launchd-plist.ts`). Task 1.1 confirms these. The Phase 5 cross-spec decisions (`.kiro/specs/phase5-cross-spec-decisions.md`, D4 to D7, D9, and D12 to D17) are binding.
>
> Gate OQ-1 (what ADV report generation is concretely): this plan contains no ADV-specific work beyond the disabled placeholder example required by 14.1 (task 10.3). A real `adv-report` command, its parameter patterns, and its execution host are a later configuration change that starts only after the user answers OQ-1 (see requirements.md and design.md). Task group 9 (laptop milestone) is optional: start it only when the answer to OQ-1 (or another action) needs a Mac-only tool and the user confirms the milestone.
>
> Note: `npm run typecheck` is broken repo-wide (pre-existing). "Compiles" below means `tsc --noEmit` reports no errors for the new or changed files (filtered output) and vitest loads them.
>
> Ownership: 1.3 creates `tests/actions-fixtures.ts` and `tests/fixtures/actions/*.sh`; later tasks only add helpers when their bullets say so. 3.1 creates `src/actions/schema.ts` and `run-store.ts` (schema, insert, lookups, transitions); 3.2 adds the remaining store functions to `run-store.ts`; later tasks only call them. 6.1 creates `src/actions/run-service.ts`; 6.2 adds operator operations and finalize to it. No task touches triage-owned or notifier-owned files: `defaultActionCatalog()` and `defaultApprovalOffer()` stay the empty defaults, and `src/watch.ts` is not edited (D7). 3.1 is the only task that touches message-events-owned `src/schema-registry.ts` (one import and one `SCHEMA_MODULES` entry); 7.3 is the only task that touches message-events-owned `src/daemon-wiring.ts` (type-only imports of the two seam types, the `actionCatalog?` and `approvalOffer?` fields on `DaemonSharedWiring`, one import of `composeActionSeams`, and setting both fields inside `composeSharedWiring(env)` from `composeActionSeams({ env })`) and `src/daemon-services.ts` (one import and one `DAEMON_SERVICES` entry for the runner only; the triage-agent and notifier entries are not edited, D12); 9.4 is the only task that touches cloud-deployment-owned `src/ingress/modules.ts` (one import and one entry). 8.1 creates `src/actions/cli.ts` (entry, archive open, schema, dispatch), `cli-format.ts`, and `tests/actions-cli.test.ts`; 8.2 creates `cli-run.ts` and adds only its dispatch entries and test cases; 9.3 adds only the `agent` dispatch branch. `.env.example` and `README.md` are touched only by 10.3.

- [ ] 1. Foundation: upstream check, vocabulary, settings, fixtures
- [ ] 1.1 Confirm upstream modules and contracts
  - Confirm the action catalog seam and descriptor types, the verdict feed (register, read, ack, status), the decision lookup by id, the notification request function, the approval feed (register, read, ack, status), the approval offer seam, the deployment profile reader, the secret name allowlist, the DB path resolver, and the ingress module types exist and export the names the design imports; if any is missing, stop and report which spec must be implemented first.
  - Confirm the seam functions still return the empty catalog and the never-offer value (they stay that way; this spec never edits them), and that triage start accepts an injected action catalog and the notifier start accepts an injected offer.
  - Confirm message-events' daemon services list (entry shape, service handle with drain and stop, the service ctx with env, mode, and shared wiring), the shared wiring module with its compose function taking env, and the schema registry (module list called once by archive init), and cloud-deployment's data file resolver accepting an injected env and the ingress context env field; for task group 9 only, confirm presence-context's shared helper exports `LaunchdJob`, `LaunchdDeps`, `LaunchdInstallResult`, `LaunchdUninstallResult`, `buildLaunchdPlist`, `installLaunchAgent`, `uninstallLaunchAgent`, `launchAgentStatus`.
  - Observable completion: a short written check result in the task report listing each upstream export as present or missing.
  - _Requirements: 3.1, 3.3, 4.1, 4.4, 9.1_

- [ ] 1.2 Declare the action vocabulary and resolve settings
  - Declare every type and constant listed in design.md (ActionsTypes), including run statuses, final statuses, reasons, sources, and the run record shape.
  - Resolve the feature settings from the env passed in, never the process env (enable switch, config path through the shared data file resolver called with that env so the env var wins and the default sits next to the archive, auto switch, tick interval, retention, laptop switch, laptop claim limit) and the Mac agent settings, falling back to defaults with a warning naming the setting; decide whether this host executes server or laptop runs from the deployment profile.
  - Observable completion: `tests/actions-settings.test.ts` shows defaults, the config path next to the archive (independent of the working directory) and the `KHIPU_ACTIONS_CONFIG` override, each out-of-range value falling back with a named warning, warnings never containing the token, and the host-execution rule for local and server profiles.
  - _Requirements: 1.1, 1.11, 5.4, 11.1, 12.1, 12.2, 12.6_

- [ ] 1.3 Create shared test fixtures
  - Provide a temporary config file writer, a fake clock, fake verdict and approval feeds with ack tracking, a fake notification queue, and a seeded-run helper on a `:memory:` archive.
  - Add executable fixture scripts: one that prints its arguments and `KHIPU_*` environment plus result lines, one that fails with stderr, one that sleeps and starts a sleeping child, and one that writes about 1 MB to stdout.
  - Observable completion: a smoke test imports the fixtures and runs the success script once through Node's process API, and the scripts are executable in the repository.
  - _Requirements: 7.5, 7.6, 7.7_

- [ ] 2. Configuration and registry
- [ ] 2.1 (P) Parameter schema subset and validation
  - Accept only flat object schemas with every property required, no extra properties, at most 10 scalar properties, valid names, and strings constrained by an allowed-values list or an anchored pattern with a length cap; report each unsupported keyword or shape by name.
  - Produce the descriptor schema for triage (type, description, allowed values, pattern, numeric bounds only) and validate parameter objects, reporting failing parameter names only, including control characters; produce canonical parameters and their short hash.
  - Observable completion: `tests/actions-params-schema.test.ts` covers every accepted and rejected shape, every validation failure kind by name, and a descriptor schema with no extra properties, all properties required, and no length keyword.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1_
  - _Boundary: ParamsSchema_

- [ ] 2.2 (P) Effective policy rule
  - Compute ask-first or auto from the action's policy, the global auto switch, the auto eligibility source, and the triage decision outcome; unknown outcomes are ask-first.
  - Observable completion: `tests/actions-policy.test.ts` passes a full truth table over policy, switch, eligibility source, and outcome (rule, fallback, llm, unknown).
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: Policy_

- [ ] 2.3 Configuration file parser
  - Parse version 1 files with the per-action fields and defaults from design.md, rejecting unknown keys and reporting every problem with action id and field.
  - Enforce id pattern and uniqueness, absolute command and working directory, placeholders that name declared parameters, environment name and value limits, reserved environment names, the khipuchat secret pass-through denylist, numeric ranges, and the laptop-host rule for server profiles without the milestone; compute the content fingerprint.
  - Observable completion: `tests/actions-config-parse.test.ts` shows defaults (including ask-first), each listed rejection with id and field, forbidden pass-through for platform, ingress, database, and khipuchat names while a tool-specific name is allowed, and the laptop-host rejection message.
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 12.9_
  - _Depends: 2.1_

- [ ] 2.4 Registry source with hot reload
  - Load the file once, expose the current snapshot (all actions, lookup by id, settings, fingerprint), re-stat on every read and re-parse on modification, keep the last valid snapshot with one log line per failed change, and return an empty snapshot when disabled, missing, or invalid at first load.
  - Provide one lazily created shared registry per process, built from the env given on the first call (never the process env), plus a reset helper for tests.
  - Observable completion: `tests/actions-registry.test.ts` shows a change picked up on the next read without restart, an invalid or deleted file keeping the previous version with exactly one log line, disabled actions present in the snapshot but flagged, and an empty snapshot when the feature is switched off.
  - _Requirements: 1.8, 1.9, 1.10, 1.11_

- [ ] 3. Run log storage
- [ ] 3.1 Create the run table, inserts, lookups, and transitions
  - Define the run table and indexes exactly as in design.md in a DDL-only schema module (idempotent), including the unique approval column and the per-decision unique index for verdict rows, and register it with one import and one entry in the shared schema registry so archive init creates it; no lazy schema creation anywhere.
  - Implement insert with conflict detection, lookup by id and by verdict decision and action, status-guarded transitions, and executor-guarded completion; truncate stored params, tails, summary, and link to their limits.
  - Observable completion: `tests/actions-run-store.test.ts` shows the table present after plain archive init on `:memory:` with no action-runner call, a second insert for the same approval or the same verdict decision and action is refused, transitions and completions from a final status or another executor are refused, and stored values are truncated to their limits.
  - _Requirements: 4.10, 5.6, 8.1, 8.2_

- [ ] 3.2 Add claim, limit queries, listings, report marking, and retention to the store
  - Implement the atomic claim of the oldest queued run per host (optionally limited to given action ids), queued counts and duplicate lookups for limits, running-on-host check, listings by filter and status, pending reports and report marking, and retention that never deletes non-final or pending-report rows.
  - Observable completion: `tests/actions-run-store.test.ts` (added cases) shows two claims never return the same run, claims respect queue order and action filters, counts and duplicate lookups honor their time windows, and pruning keeps awaiting, queued, running, and pending-report rows.
  - _Requirements: 6.1, 6.2, 6.3, 8.5_

- [ ] 4. Pure domain logic
- [ ] 4.1 (P) Invocation builder
  - Build the command, one argument per template element with placeholders replaced by the value's string form and never split or re-parsed, the minimal environment, the action's literal environment, pass-through variables, and the run, action, and per-parameter variables; reject a whole-argument string placeholder whose value starts with a hyphen.
  - Observable completion: `tests/actions-invocation.test.ts` shows values with spaces, quotes, and shell characters arriving as single unchanged arguments, the option-like rejection, the per-parameter environment names, and that a database key or ingress token present in the process environment never appears in the built environment.
  - _Requirements: 2.7, 7.1, 7.2, 7.3, 7.4, 7.9_
  - _Boundary: InvocationBuilder_

- [ ] 4.2 (P) Output tails and result lines
  - Keep the last 2000 characters of a stream regardless of total size, and extract the last https result link line and the last result summary line from the stdout tail.
  - Observable completion: `tests/actions-output.test.ts` shows the tail after 1 MB of input, an http link ignored, the last of several summary lines kept and cut to 200 characters with control characters removed.
  - _Requirements: 7.6, 7.7_
  - _Boundary: OutputTail_

- [ ] 4.3 (P) Admission guards
  - Decide queued, rejected, skipped, or expired in the documented order: unknown or disabled action, approval age, stale auto suggestion, parameter validation, duplicate window, hourly limit; identical for every source.
  - Observable completion: `tests/actions-admission.test.ts` covers each reason, age limits exactly at and just past the boundary, a disabled duplicate window, and the hourly limit at the threshold.
  - _Requirements: 2.4, 2.5, 4.7, 4.9, 5.5, 6.1, 6.2, 6.4_
  - _Boundary: Admission_

- [ ] 4.4 (P) Result notification content
  - Decide reportability from final status, who approved, and the action's report level, and build the notification request with origin `action-runner`, key `run:<id>`, a title containing the action id and run id, fixed-phrase body lines, the command's own summary, the https result link as open link, and normal or high urgency.
  - Observable completion: `tests/actions-report-content.test.ts` shows the reportability table (verdict-only rows, expired offers, cancelled runs, report levels) and that bodies never contain output tails or parameter values.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.8, 13.4_
  - _Boundary: ReportContent_

- [ ] 5. Execution
- [ ] 5.1 Command executor
  - Start the command without a shell in its own process group with the built environment and either the configured working directory or a private temporary directory removed afterwards; distinguish missing and non-executable commands before starting.
  - Capture both streams into tails without stopping the run, stop the whole process group on timeout or abort (forcibly after the grace period), and map every outcome to a completion (succeeded, failed with exit code or reason, timed out, interrupted).
  - Observable completion: `tests/actions-executor.test.ts` runs the fixture scripts and shows success with result lines, failure exit code and stderr tail, missing and non-executable commands, the slow script and its child both gone after timeout, the noisy script finishing with a 2000-character tail, abort producing interrupted, and the temporary directory removed.
  - _Requirements: 7.5, 7.6, 7.8, 7.9, 11.2_

- [ ] 6. Orchestration
- [ ] 6.1 Run service: creation from verdicts and approvals
  - Create rows from verdicts (ignore records without a suggestion or with an existing row; reject unknown, disabled, or invalid suggestions without reporting; awaiting approval for ask-first; admission for auto with stale-suggestion expiry) and from approvals (admit a matching awaiting row in place, otherwise a new approval row; offer-expired and already-handled rejections; existing row returned on repeated delivery).
  - Observable completion: `tests/actions-run-service.test.ts` shows each path's resulting status, reason, who approved, and report state, including an approval arriving before its verdict and an approval for an expired offer.
  - _Requirements: 4.3, 4.5, 4.6, 4.8, 4.9, 4.10, 4.11, 5.1, 5.5, 8.2_

- [ ] 6.2 Run service: command-line creation, approve, cancel, finalize
  - Create rows from the command line (foreground only when nothing is running on this host, otherwise a busy error; queue on request; laptop targets on a server profile always queued), implement operator approve and cancel, and finalize executed runs with the report state from the reportability rule and the run log line.
  - Observable completion: `tests/actions-run-service.test.ts` (added cases) shows foreground and queued creation, the busy error, approve on awaiting rows only, cancel on awaiting and queued rows only, and finalize producing the documented status and report state for each executor outcome.
  - _Requirements: 4.12, 6.4, 10.4, 10.6_

- [ ] 6.3 (P) Verdict and approval intakes with feed adapters
  - Build the default feed adapters over the triage verdict feed and the notifier approval feed (register from the newest record, read, ack).
  - Register both consumers on first start, read batches of 50, pass each record to the run service, ack per record and per batch, and on unexpected failure retry the record on the next tick, recording an internal-error rejection and acking past it after the third failure.
  - Observable completion: `tests/actions-intakes.test.ts` shows the real adapters registering from the newest record on the real feed tables, records without suggestions acked without rows, redelivery producing no second row, and the three-failure path with fake feeds.
  - _Requirements: 4.1, 4.2, 4.4, 4.10, 5.6, 11.4_
  - _Boundary: VerdictIntake, ApprovalIntake_

- [ ] 6.4 (P) Worker
  - Keep at most one run in flight; claim the oldest queued run for each host this daemon executes; re-check the definition and parameters at claim time and fail without executing when they no longer pass; execute and finalize; support abort for shutdown.
  - Observable completion: `tests/actions-worker.test.ts` with a fake executor shows queue order, one run at a time, laptop runs left queued on the server profile and executed on the local profile, and a run whose action was disabled after queuing completing as failed without execution.
  - _Requirements: 4.11, 6.3, 12.1, 12.2_
  - _Boundary: Worker_
  - _Depends: 5.1, 6.2_

- [ ] 6.5 (P) Sweeper
  - Interrupt this daemon's running rows at startup, expire awaiting rows past their offer age limit, expire unclaimed laptop runs past the claim limit, interrupt overdue running rows of other executors, and prune at most hourly.
  - Observable completion: `tests/actions-sweeper.test.ts` shows each transition with its reason and report state (expired offers not reported, unclaimed and lost laptop runs reported) and no re-execution after restart.
  - _Requirements: 4.8, 8.3, 8.5, 12.6, 12.7_
  - _Boundary: Sweeper_

- [ ] 6.6 (P) Reporter
  - For pending reports, re-check reportability against the current action definition, queue the result notification, mark it sent with the notification id, stop retrying on validation errors with one log line, and leave the row pending on a throw.
  - Observable completion: `tests/actions-reporter.test.ts` with a fake queue shows exactly one request per run with key `run:<id>`, a retry after a throw, no second request after a simulated restart, and a failures-only action producing no success notification.
  - _Requirements: 9.1, 9.6, 9.7_
  - _Boundary: Reporter_

- [ ] 6.7 Runtime lifecycle
  - Start only with the feature enabled and a valid configuration (logging the disabled reason and leaving both feeds untouched otherwise), rely on the table created at archive init, register consumers, interrupt stale own runs, and tick at the configured interval without overlapping ticks (sweeper, intakes, worker, reporter).
  - Provide the single-pass processing (process verdicts, approvals, queued runs, and reports until nothing remains on this host or a deadline is reached, waiting for runs) and stop (no new work, abort the running command, record it interrupted, final report pass, within the grace period), and the run log line format without parameters or output. Signal shutdown uses only stop; it never loops the intakes.
  - Observable completion: `tests/actions-runtime.test.ts` shows each disabled reason with no consumer registered, the tick interval, single-pass processing completing all pending work and stopping at its deadline, stop starting no new work and finishing within 15 seconds with the running run interrupted, and log lines free of parameter values.
  - _Requirements: 1.11, 8.4, 8.6, 11.1, 11.2, 11.3_
  - _Depends: 6.3, 6.4, 6.5, 6.6_

- [ ] 7. Seams and daemon integration
- [ ] 7.1 (P) Catalog view (triage seam implementation)
  - Implement the catalog view returning enabled actions' id, description, and descriptor schema, empty on any failure, with no database access. Do not edit triage files: the triage default catalog stays empty and triage receives this view only through the daemon services wiring (task 7.3).
  - Observable completion: `tests/actions-catalog-view.test.ts` shows the view over a temp config listing an enabled action, nothing for disabled actions or a missing file, an empty list on a throwing registry, triage's own snapshot accepting every descriptor (no problems), and triage's default catalog still empty.
  - _Requirements: 1.10, 3.1, 3.2, 3.5, 13.5_
  - _Boundary: CatalogView_

- [ ] 7.2 (P) Offer view (notifier seam implementation)
  - Implement the offer view answering yes only for an enabled action whose effective policy for the suggestion's decision outcome is ask-first, false on any failure, read-only. Do not edit notifier files: the notifier default offer stays never-offer and the notifier receives this view only through the daemon services wiring (task 7.3).
  - Observable completion: `tests/actions-offer-view.test.ts` shows yes for ask-first, no for auto with a rule outcome, yes for auto with a model outcome under rule-only eligibility, yes with the auto switch off, no for unknown or disabled actions and on a throwing lookup, no database writes, and the notifier default offer still never offering.
  - _Requirements: 3.3, 3.4, 3.5, 13.5_
  - _Boundary: OfferView_

- [ ] 7.3 Compose the seams and register the runner as a daemon service (integration, message-events-owned file)
  - Export `composeActionSeams({ env })` from the actions module, returning the catalog view and the offer view over one shared registry built from that env, side-effect free, fail-closed, and with no process env read.
  - Add the runner's daemon service entry (type-only imports from the daemon services module, D16) with a service handle adapter that branches on the daemon mode: in watch mode, drain starts no new work and awaits the in-flight run through the stop path (interrupt the running command, record it, final report pass) within 15 seconds; in once mode, drain processes pending verdicts, approvals, and queued runs until none remain or the bound (the 120 second `timeoutMs` given by the single pass, D17); stop starts the shutdown sequence synchronously and nothing new runs after it.
  - In `src/daemon-wiring.ts` only: fill the body of `composeSharedWiring(env)`, setting `actionCatalog` and `approvalOffer` from `composeActionSeams({ env })` (D12, D17). The fields are owned by triage-agent (`actionCatalog?`) and notifier (`approvalOffer?`), which declare them with their type-only imports; only if a field is still absent, add it with its type-only import as a fallback, exactly as message-events' design shows; the triage and notify CLI entry scripts and the triage-agent and notifier daemon entries already read these fields and are not edited. In `src/daemon-services.ts` only: one import and one entry for the runner, last after the notifier. No edit to `src/watch.ts`, triage files, notifier files, or the CLI entry scripts.
  - Observable completion: `tests/actions-seams.test.ts` shows the composed catalog listing an enabled action and the composed offer answering yes over a temp config named in the passed env (a conflicting process env ignored), empty and never-offer without config, and `composeSharedWiring(env)` returning both fields; `tests/actions-service.test.ts` shows the entry last in the daemon services list with the triage-agent and notifier entries unchanged, null start without config, once-mode drain processing pending work and stopping at its bound, watch-mode drain reading no feed, claiming no queued run, and interrupting the running run within 15 seconds, and stop alone also interrupting within 15 seconds.
  - _Requirements: 1.11, 3.1, 3.2, 3.3, 3.4, 3.5, 11.1, 11.2, 11.3, 13.5_
  - _Depends: 6.7, 7.1, 7.2_

- [ ] 8. Operator commands
- [ ] 8.1 Inspection commands: check, list, log, show
  - Validate the configuration with the current profile and report each problem and, for actions executed on this host, whether the command exists and is executable, exiting non-zero on any problem; list actions with policy, effective auto state, host, enabled state, and parameters; show recent runs with filters and one run in full.
  - Observable completion: `tests/actions-cli.test.ts` (inspection cases) shows check exit codes for valid, invalid, and missing-command configs, the effective auto wording, log filters by action and status, and show output including tails.
  - _Requirements: 10.1, 10.2, 10.3, 10.7_

- [ ] 8.2 Run, dry run, approve, cancel
  - Parse repeated `--param name=value` by the declared type, run through the same admission as other sources, execute in the foreground with an outcome line (refusing while another run is in progress on this host) or queue with `--queue` (always for laptop actions on a server profile), print the exact command, arguments, and parameter environment for `--dry-run` without recording anything, and approve or cancel by run id; attempt one report pass before exit.
  - Observable completion: `tests/actions-cli.test.ts` (run cases) shows a foreground success recorded with source command line and a pending report, refusal while busy, queue mode, a dry run that leaves the run table unchanged, approve queuing an awaiting run, cancel on queued and awaiting runs, and non-zero exits for unknown ids and invalid params.
  - _Requirements: 4.12, 6.4, 10.4, 10.5, 10.6, 10.7_

- [ ] 8.3 Register the `khipu action` subcommand
  - Add the subcommand to the router and its help line.
  - Observable completion: the router test shows `khipu action list` resolving to the actions CLI script.
  - _Requirements: 10.1_

- [ ] 9. Laptop execution milestone (optional; see the gate note at the top; upstream: presence-context `src/launchd-plist.ts` for 9.3, cloud-deployment `IngressContext.env` for 9.1)
- [ ] 9.1 Laptop claim and result routes
  - Implement the actions ingress module that reads its settings from the ingress context env (never the process env) and mounts its routes only when the laptop milestone is enabled (the table already exists from archive init), validates claim and result bodies, claims at most one queued laptop run among the agent's action ids (returning only id, action id, params, and timeout), accepts results only from the claiming agent, and logs without params or output.
  - Observable completion: `tests/actions-laptop-routes.test.ts` (supertest on the mounted module) shows no routes when disabled, enabling through the ingress context env while the process env is ignored, claim payload contents, sequential claims returning different runs, 409 for another agent's result, 400 for invalid bodies, and the finalized run with a pending report.
  - _Requirements: 12.3, 12.5, 12.9_
  - _Boundary: ActionsIngressModule, LaptopRoutes_

- [ ] 9.2 (P) Laptop pull agent
  - Resolve the agent URL and token (refusing plain http to non-loopback hosts), send the ids of the Mac's enabled laptop actions, and loop claim, local definition and parameter check, execute with the shared executor, and report, until no run is returned (bounded per invocation); report a rejection without executing when the action is not defined locally or params fail.
  - Observable completion: `tests/actions-laptop-agent.test.ts` with a fake fetch shows the insecure URL refusal, an unknown local action reported as rejected without execution, a fixture script executed and its result posted, and error messages free of the token.
  - _Requirements: 12.4, 12.8_
  - _Boundary: LaptopAgent_
  - _Depends: 5.1_

- [ ] 9.3 Agent schedule on macOS and agent subcommands
  - Build the LaunchAgent job as presence-context's `LaunchdJob` (interval, run at load, login session only, background, log paths, no environment or secrets) and render it with `buildLaunchdPlist`; install with `installLaunchAgent`, uninstall with `uninstallLaunchAgent`, and report status with `launchAgentStatus`, passing `LaunchdDeps` through and returning `LaunchdInstallResult` / `LaunchdUninstallResult` (no own plist writer or launchctl calls); expose `khipu action agent run [--once] | install | uninstall | status`, printing failed results as one line with exit 1.
  - Observable completion: `tests/actions-agent-launchd.test.ts` with a fake `LaunchdDeps` shows the job contents without any token or environment block, install on Linux returning not-macos, reinstall returning replaced after a bootout, uninstall returning absent when nothing is installed, and the plist and install going through `buildLaunchdPlist` and `installLaunchAgent`.
  - _Requirements: 12.8_
  - _Boundary: AgentLaunchd_
  - _Depends: 9.2; upstream presence-context shared launchd plist helper_

- [ ] 9.4 Register the actions module with the ingress (integration, cloud-deployment-owned file)
  - Add one import and one entry for the actions ingress module to the ingress module list; no other change to cloud-deployment files.
  - Observable completion: the ingress app test shows `/v1/actions/laptop/claim` reachable with the per-module token when the milestone is enabled and 404 when disabled, and the cloud-deployment ingress isolation test still passes with the new module.
  - _Requirements: 12.3, 12.9_
  - _Depends: 9.1_

- [ ] 10. Validation and operator material
- [ ] 10.1 Static scope and isolation checks
  - Scan imports and source text under the actions module for every isolation rule in design.md: the catalog view chain, the offer view chain, the seam composition chain, the ingress module chain (checked only when the laptop milestone files exist, so the test passes with group 9 skipped) including no process env reads there, no process env reads in the composition chain, the DDL-only schema module and no lazy schema functions, no triage or notifier file importing the actions module, the composition module imported outside the actions module only by `src/daemon-wiring.ts` and the service module only by `src/daemon-services.ts`, no runtime import of either daemon module under the actions module with the single allowance of a type-only import from the daemon services module in the service-entry file (D16), no platform clients, no Beeper, no shell execution forms.
  - Observable completion: `tests/actions-isolation.test.ts` passes on the real tree and fails on an injected file that imports a forbidden module or uses a shell option.
  - _Requirements: 13.1, 13.2, 13.3_

- [ ] 10.2 End-to-end expedition scenario with a stand-in action
  - On a temp-file archive, drive a verdict suggesting a stand-in ask-first action through the offer, an approval, the worker running the success fixture with the transaction id as one argument and as a parameter variable, and the reporter; then redeliver the approval and deliver an expired approval.
  - Observable completion: `tests/actions-e2e.test.ts` shows one awaiting row, offer yes, one succeeded run with result link and summary, exactly one notification request `run:<id>` with the link as open link, no change on redelivery, and one rejected and reported expired approval.
  - _Requirements: 4.3, 4.5, 4.7, 4.10, 7.2, 7.3, 7.7, 9.1, 9.2, 9.3_

- [ ] 10.3 Example configuration, environment template, and operator guide
  - Ship the example configuration with a disabled `adv-report` entry using a placeholder command and placeholder transaction id parameter marked as waiting for OQ-1; add the commented settings block to the environment template; write the operator guide sections listed in design.md and a short README pointer.
  - Observable completion: a test parses the example configuration successfully with the parser (the example action disabled), and checks that every setting read by the settings module appears in the environment template.
  - _Requirements: 14.1, 14.2, 14.3_
