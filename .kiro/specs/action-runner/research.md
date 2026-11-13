# Research & Design Decisions

## Summary
- **Feature**: `action-runner`
- **Discovery Scope**: New Feature (greenfield module `src/actions/`) integrating with four upstream contracts (triage-agent, notifier, cloud-deployment, message-events style); security-sensitive, so full discovery was applied to the execution path and light discovery to the integration seams.
- **Key Findings**:
  - Both upstream specs already reserve exactly the seams this feature needs: `defaultActionCatalog()` in `src/triage/action-catalog.ts` and `defaultApprovalOffer()` in `src/notify/approval-offer.ts`. (Superseded by D7/D12: their bodies are NOT changed; they stay empty defaults and the real seams arrive through `DaemonSharedWiring`.)
  - The verdict feed and the approval feed both use the message-events cursor style (register idempotently, read never writes, monotonic ack, `'now'` default start). The runner can process each record exactly once by pairing at-least-once reads with unique indexes on `action_runs`.
  - Node 24 `child_process.spawn(file, args, { shell: false })` is the execFile-equivalent primitive that allows bounded tail capture and process-group termination; `execFile` itself kills the child when `maxBuffer` is exceeded, which conflicts with "keep the tail, do not stop the run".

## Research Log

### Upstream seams and obligations
- **Context**: The task brief requires building strictly on upstream contracts.
- **Sources Consulted**: `.kiro/specs/triage-agent/design.md` (ActionCatalog, VerdictOutbox, DecisionStore), `.kiro/specs/notifier/design.md` (ApprovalOffer, ApprovalFeed, NotificationRequests), `.kiro/specs/cloud-deployment/design.md` (IngressModule, SecretFileLoader, DeploymentProfile), `.kiro/specs/message-events/design.md` (cursor semantics, `CONSUMER_NAME_PATTERN`), `.kiro/specs/presence-context/design.md` (laptop reporter, LaunchAgent).
- **Findings**:
  - `ActionDescriptor { id, description, params_schema }`; id `^[a-z][a-z0-9-]{0,63}$`; schema in the strict subset (every object `additionalProperties: false`, every property required, no `allOf`/`oneOf`). `listActions()` is synchronous and side effect free. `snapshotCatalog` drops bad descriptors defensively.
  - Obligations on action-runner from triage: stable ids, strict-subset schemas, re-validate params, never rely on triage for authorization.
  - `ApprovalOffer.offer(action, decisionId): boolean`, synchronous, side effect free, called once per verdict notification at send time; a throw counts as false.
  - `ApprovalRecord { approval_id, notification_id, decision_id, request_origin, request_key, action_id, params, approved_at, approved_via }`. Obligations: re-check id and params, own policy and age limit using `approved_at`, idempotent per `approval_id`, report with `queueNotification({ origin: 'action-runner', key: 'run:<id>' })`, missing approval is never consent.
  - `queueNotification` never throws for invalid input, is idempotent per `(origin, key)`, title 1..120 single line, body 0..1000, `open_url` https only max 512, urgency from triage `Urgency`.
  - `VerdictRecord.outcome` is `'rule' | 'llm' | 'fallback'`; fallback actions come from rule mappings (triage design, `resolveRuleAction` in the fallback branch). This makes "rule-sourced" decidable from the record without new triage fields.
  - The notifier offer only receives `decisionId`, so to decide auto eligibility by source the offer reads the decision with `getDecision` from `src/triage/decision-store.ts` (a triage data module that imports only `db.ts` and triage types).
  - `IngressModule { id, tokenHeader?, bodyLimitBytes?, mount }`; registration is one import plus one array entry in `src/ingress/modules.ts`; `INGRESS_TOKEN_<ID>` is already covered by the secret allowlist pattern `^INGRESS_TOKEN_[A-Z0-9_]+$`.
  - `readDeploymentProfile(env)` returns `'local' | 'server'` from `KHIPU_DEPLOYMENT`.
- **Implications**: ~~No upstream contract changes. Two seam bodies edited, one ingress registration entry (optional milestone), plus the shared daemon and router files (`src/watch.ts`, `src/khipu.ts`) that every Phase 5 spec touches with a few lines.~~ **Superseded by D6, D7, D12, D14 (Phase 5 cross-spec decisions, 2026-11-12).** Current plan: no seam body is edited and `src/watch.ts` is not touched; `composeActionSeams({ env })` from `src/actions/seams.ts` is imported only by message-events' `src/daemon-wiring.ts`, where action-runner adds `actionCatalog?` / `approvalOffer?` to `DaemonSharedWiring` and sets them in `composeSharedWiring(env)`; triage's and notifier's own `DAEMON_SERVICES` entries and CLI entry scripts read those fields (not edited by action-runner); the runner adds only its own `DAEMON_SERVICES` entry; `action_runs` is registered in `src/schema-registry.ts`; one ingress registration entry (optional milestone) and one `src/khipu.ts` router entry remain.

### Parameter schema validation without a new dependency
- **Context**: Params must be validated twice (triage path through the LLM provider, then again here). llm-provider makes `ajv` a direct dependency but restricts its import to `src/llm-structured.ts`; triage repeats "never ajv".
- **Findings**: The required parameter shapes (transaction id, date, small enums, counts, flags) are flat scalars. A flat-scalar subset is trivially validated by hand (about 80 lines) and is a strict subset of the provider strict mode. OpenAI-compatible strict mode accepts `type`, `description`, `enum`, `pattern`, `minimum`, `maximum`; `maxLength` support varies by provider.
- **Implications**: Own validator in `src/actions/params-schema.ts`; the descriptor given to triage omits `maxLength` (enforced locally only). Every string must have `enum` or an anchored `pattern`, which removes free-form strings entirely.

### Process execution primitive
- **Context**: Brief demands `execFile` (no shell) with timeout and bounded output.
- **Sources Consulted**: Node.js 24 `child_process` documentation (`spawn`, `execFile`, `shell`, `detached`, `maxBuffer`, `timeout`, `killSignal`).
- **Findings**:
  - `execFile` with `shell: false` does not spawn a shell; it is a wrapper over `spawn` that buffers output and kills the child on `maxBuffer` overflow.
  - `spawn(file, args, { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })` puts the child in its own process group on POSIX, so `process.kill(-pid, 'SIGTERM')` stops descendants too.
  - `env` replaces the environment entirely when given (no inheritance), which enables the minimal environment.
  - `ENOENT` and `EACCES` surface as an `'error'` event before `'spawn'`.
- **Implications**: Executor uses `spawn` with `shell: false` (execFile semantics, no shell anywhere), its own ring buffer tails, timeout with SIGTERM then SIGKILL after 5 s on the process group.

### Laptop channel
- **Context**: Brief suggests reusing the presence laptop agent channel; the task brief says that would be a presence-context revalidation trigger and prefers a separate module.
- **Findings**: presence's reporter is a one-shot `POST /v1/presence/report` under its own LaunchAgent with `StartCalendarInterval`; its payload and module id are presence contracts. A separate ingress module (`actions`, token `INGRESS_TOKEN_ACTIONS`) and a separate LaunchAgent (`com.khipuchat.action-agent`, `StartInterval`) reuse the same patterns (loopback-only http rule, token from `.env`, no secrets in the plist) without touching presence.
- **Implications**: Laptop path is a separate, optional milestone (tasks group 9) gated by `KHIPU_ACTIONS_LAPTOP=1`.

### Codebase observations
- `src/khipu.ts` maps subcommands through `OPERATIONAL_SCRIPTS`; triage and notifier add one entry each the same way.
- Existing process spawning (`src/sync-all.ts`, `src/khipu.ts`) uses `spawn` with argument arrays; no shell use except `setup-env.ts` (unrelated).
- `src/triage`, `src/notify`, `src/ingress` do not exist yet; this spec depends on them being implemented first.

### Round 2 cross-spec alignment (2026-11-12)
- D12: seams reach triage and notifier only through `DaemonSharedWiring.actionCatalog?` / `approvalOffer?`, filled in `composeSharedWiring(env)`; action-runner edits no other spec's `DAEMON_SERVICES` entry.
- D13: `ctx.mode` drives drain. Watch mode (signal): no new work, the in-flight run is stopped and recorded interrupted within 15 s, inside the daemon's 25 s overall deadline. Once mode: pending work processed until none remains or the bound. The earlier "drain loops the intakes" behavior on signal is dropped.
- D14: `src/daemon-wiring.ts` is the only importer of `src/actions/seams.ts`; CLIs reach it through `src/cli-entries/*`.
- D15: `composeActionSeams({ env })` and `resolveDataFile(name, envVar, { env })`, no `process.env` in composition code; the laptop LaunchAgent uses presence-context's `LaunchdJob` / `LaunchdDeps` / `buildLaunchdPlist` / `installLaunchAgent` / `uninstallLaunchAgent` / `launchAgentStatus` and its result unions.
- D16: `src/actions/service.ts` may `import type` from `src/daemon-services.ts`; no runtime import of daemon modules under `src/actions/`.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Feed consumers + run table state machine (selected) | Two intakes write `action_runs`; one worker executes queued rows; one reporter queues notifications | Mirrors triage and notifier; restart-safe; each concern testable alone | More rows than strictly needed (awaiting rows) | Awaiting rows give the audit trail Requirement 8.2 wants |
| Execute directly inside approval read | Run the command while handling the approval batch | Fewer moving parts | A long run blocks feed processing; ack ordering vs crash is unsafe | Rejected |
| Separate runner process or service | Own compose service | Isolation | Another service, another lifecycle; Phase 5 keeps one daemon | Rejected; can be revisited |
| Reuse presence reporter for laptop | Extend `/v1/presence` | No new module | Presence contract change, revalidation | Rejected per task brief |

## Design Decisions

### Decision: Flat-scalar parameter subset with mandatory string constraints
- **Context**: Requirements 2.1 to 2.3; triage strict-subset obligation; no free-form text into commands.
- **Alternatives Considered**:
  1. Full strict subset with nested objects and arrays, validated by Ajv.
  2. Flat scalars only, hand-validated, every string constrained.
- **Selected Approach**: Option 2.
- **Rationale**: Commands take argv strings; nested data has no safe argv mapping. Hand validation avoids touching the llm-provider dependency rule.
- **Trade-offs**: An action needing a list must declare separate params or an enum; acceptable for P3.
- **Follow-up**: Revisit only when a real action (OQ-1) needs more.

### Decision: Effective policy computed by one pure function shared by offer and intake
- **Context**: Requirements 3.3, 3.4, 5.1 to 5.4. Offer (notifier daemon, send time) and verdict intake (runner tick) must agree.
- **Selected Approach**: `effectivePolicy(definition, { autoEnabled }, outcome)` returns `'ask-first' | 'auto'`; both seams call it with the same registry snapshot source.
- **Trade-offs**: A config reload between the offer and the intake can disagree; the later approval is then rejected as `already_handled` and reported (documented).

### Decision: Exactly-once by unique indexes, at-least-once feeds
- **Context**: Requirements 4.10, 5.6, 9.7.
- **Selected Approach**: `UNIQUE (approval_id)`, partial unique `(decision_id, action_id) WHERE source = 'verdict'`, notification key `run:<id>` (idempotent upstream), `reported_at` column for retry. Feeds are acked after the row is committed.

### Decision: Running rows never auto-retried
- **Context**: Requirement 8.3. Side effects of a half-finished run are unknown (for example a partially generated report).
- **Selected Approach**: On start, rows in `running` owned by this host become `interrupted` and are reported; the operator can re-run from the CLI.

### Decision: Result protocol by stdout lines
- **Context**: Requirement 7.7; tools are user-provided and unknown (OQ-1).
- **Selected Approach**: Last stdout line matching `^KHIPU_RESULT_URL=(https://\S{1,500})$` and `^KHIPU_RESULT_SUMMARY=(.{1,200})$`. Simple for any script; ignored when absent.

### Decision: Build, not adopt
- Job queues (BullMQ, Agenda) need Redis or Mongo; a SQLite table plus one worker matches the archive-centric architecture and the "no new dependency" rule.
- Sandboxing (containers, `sandbox-exec`, seccomp) is out of scope for P3; isolation relies on operator-chosen commands, no shell, a minimal environment, and bounded time. Recorded as a risk.

### Decision: Simplifications
- One worker, serial execution per host (Requirement 6.3); no concurrency setting.
- No "run started" notification; only results.
- No separate approval-request notifications from the runner; Do it buttons come from verdict notifications via the offer seam, with the CLI approve command as fallback when callbacks are unavailable.

## Risks & Mitigations
- Operator configures a dangerous command: mitigated by ask-first default, per-action rate limits, duplicate window, documentation; residual risk accepted (operator-owned).
- Argument injection through parameter values: anchored patterns or enums mandatory, leading hyphen rejected for whole-argument placeholders, no shell.
- Leaked callback link approves a run: notifier links are single-use and expiring; runner still validates params, policy, age, limits.
- Laptop route abused with a stolen token: route hands out only id and params; the laptop executes only its own configured commands; per-module token; results only for runs claimed by that agent.
- Config reload race between offer and intake: approval rejected and reported, never executed twice.
- Container lacks the tool (OQ-1): `khipu action check` reports missing commands; laptop milestone available.

## References
- Node.js 24 `child_process` documentation: `spawn`, `execFile`, options `shell`, `detached`, `env`, `timeout`.
- OpenAI structured outputs supported schema keywords (strict mode) as referenced by llm-provider research.
- Apple `launchd.plist(5)`: `StartInterval`, `LimitLoadToSessionType`, `ProgramArguments`.
