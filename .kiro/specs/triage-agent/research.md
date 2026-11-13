# Research & Design Decisions: triage-agent

## Summary
- **Feature**: `triage-agent`
- **Discovery Scope**: New Feature integrating four not-yet-implemented upstream specs (message-events, llm-provider, presence-context, slack-all-workspaces) plus cloud-deployment conventions. Full discovery over upstream design contracts and the current codebase; no external API research needed beyond what llm-provider already recorded (Meta Model API strict structured-output subset).
- **Key Findings**:
  - message-events gives exactly the consumer contract triage needs (`registerConsumer('triage-agent')` defaulting to `startFrom: 'now'`, `readEvents` skipping backfill by default with an `ackId` that also passes skipped rows, `ack`, and `waitForEvents` as a hint only). Triage must keep a fallback poll and be idempotent per `event.id`.
  - llm-provider's `chatStructured` takes no tools, retries once with a corrective turn, and validates with Ajv against the caller schema. With `strict: true` the Meta endpoint requires `additionalProperties: false` on every object and every property listed in `required`; `anyOf` is allowed below the root. Optional verdict fields must therefore be expressed as nullable (`anyOf` with `{ type: 'null' }`), never as missing properties.
  - presence-context makes `presenceForLlm()` (and `formatPresenceSummary()`) the only allowed gate for LLM-bound presence; the raw `PresenceSnapshot` must never reach a prompt. `getPresence` throws `PresenceConfigError` on bad settings, which triage must absorb.
  - slack-all-workspaces explicitly lists "importance rules, watchlists for triage" as out of its boundary: its `watch` list only controls read frequency (tier `watched`, 60 s). A triage rule on a Slack chat that is not watched is still correct but slower (active 5 min, idle 60 min).
  - None of the upstream modules exist in `src/` yet (`src/event-bus.ts`, `src/llm-*.ts`, `src/presence/`, `src/platforms/slack/settings.ts` are absent); implementation order must follow the Phase 5 dependency graph.

## Research Log

### Consumer loop and delivery semantics (message-events)
- **Context**: Req 1 (live consumption, latency, idempotency, shutdown).
- **Sources Consulted**: `.kiro/specs/message-events/design.md` (EventBus, EventSignal, consumer loop contract, retention).
- **Findings**:
  - `readEvents(name, { limit })` examines up to `limit` rows; `events` excludes backfill; `ackId` is the last examined id or `null` when caught up.
  - `waitForEvents({ timeoutMs, signal })` resolves `signalled | timeout | aborted`; the signal fires once per daemon cycle that recorded events, after the adapter call.
  - Retention deletes events at or below the minimum consumer position, so acknowledging promptly keeps the stream small.
  - `getMessageById(id): MessageRow | null` is the lookup for event payloads.
- **Implications**: triage uses the documented loop, acks per event for fine-grained progress, and uses its own `UNIQUE` constraint on `event_id` for exactly-once decisions under at-least-once delivery. Latency is bounded by the signal (sub-second after a cycle) with a 30 s fallback poll.

### Structured verdicts (llm-provider)
- **Context**: Req 5, 6, 7, 8.
- **Sources Consulted**: `.kiro/specs/llm-provider/design.md` (LlmTypes, LlmErrors, LlmClient, LlmFallback, LlmFactory downstream contract), `.kiro/specs/llm-provider/research.md` (Meta strict subset).
- **Findings**:
  - `createLlmClientFromEnv(env, deps)` is the only constructor; configuration errors throw at construction, the cloud gate throws `cloud_not_allowed` at call time.
  - Fallback-eligible kinds (`unreachable`, `timeout`, `server`, `rate_limited`, `auth`, `permission_denied`) are retried once on local Ollama when `KHIPU_LLM_FALLBACK=ollama`.
  - The design names a per-source local-only rule as "triage-agent constructing a second client from an env override with `KHIPU_LLM_PROVIDER=ollama`".
  - Precedence for an Ollama primary: `KHIPU_LLM_BASE_URL` > `OLLAMA_HOST`; `KHIPU_LLM_MODEL` > `OLLAMA_MODEL`. A cloud base URL therefore leaks into an Ollama override unless cleared.
  - `tests/fixtures/fake-llm-transport.ts` is designed to be reusable by triage tests.
- **Implications**: the local-only client is built from `env` with `KHIPU_LLM_PROVIDER=ollama` and `KHIPU_LLM_BASE_URL`, `KHIPU_LLM_MODEL`, `KHIPU_LLM_API_KEY`, `KHIPU_LLM_FALLBACK` removed. "Local-only" means "the operator's Ollama provider, never the OpenAI-compatible endpoint"; a non-loopback `OLLAMA_HOST` still passes through the global cloud gate exactly as llm-provider defines.

### Presence (presence-context)
- **Context**: Req 5.5, 5.6, 9.3.
- **Sources Consulted**: `.kiro/specs/presence-context/design.md` (PresenceSnapshot, PresenceView, presenceForLlm, formatPresenceSummary, resolvePresenceConfig, getPresence).
- **Findings**: `presenceForLlm(snapshot, cfg)` yields a coarse view unless `KHIPU_PRESENCE_LLM_PRECISION=precise`; the view carries `summary`. `getPresence` is read-only and sub-millisecond.
- **Implications**: triage computes presence per non-skipped evaluation through one provider function that returns `PresenceView | null`, stores that same view as `presence_snapshot`, and never touches `PresenceSnapshot` fields directly.

### Slack watch list relationship (slack-all-workspaces)
- **Context**: avoiding a second, conflicting watchlist concept (Req 2.9, 12.2).
- **Sources Consulted**: `.kiro/specs/slack-all-workspaces/design.md` (SlackSettings, `classifyTier`, boundary).
- **Findings**: `SlackSettings.watch` holds normalized names (lowercase, no `#`) and ids, sourced from `khipu.config.json` fields or `SLACK_WATCH_CHANNELS`. `resolveSlackSettings(fields, env)` is a pure service.
- **Implications**: triage rules are a separate concept named "triage rules" (never "watch list"). Triage does not read the Slack watch list at runtime. Only the `khipu triage test --rules` lint reads it, read-only, to warn that a rule's Slack chat is not watched and will be read less often.

### Archive reads for context
- **Context**: Req 5.1 to 5.3.
- **Sources Consulted**: `src/db.ts`, `src/tool-registry.ts`.
- **Findings**: `getMessages(chatId, limit, before)` orders `ASC` with `LIMIT`, so it returns the oldest messages before a time, not the most recent. `dispatchTool('list_messages', ...)` delegates to the same handler and returns `unknown` JSON. There is no chat lookup by id in `db.ts`.
- **Implications**: triage owns two small read queries (chat by id; latest N messages before a message) in its own module, typed, instead of going through `dispatchTool`. Parent messages use the existing `getMessageIdByExternalId` and message-events' `getMessageById`.

### Configuration conventions (cloud-deployment)
- **Context**: settings location on server, secrets.
- **Sources Consulted**: `.kiro/specs/cloud-deployment/design.md` (KHIPU_DEPLOYMENT, `resolveDbPath`, secret allowlist, `.env.example` check).
- **Findings**: server data lives under `/app/data`; `.env.example` must list every variable referenced in compose; `_FILE` loading is only for allowlisted secrets.
- **Implications**: triage has no secrets (no allowlist change). All `KHIPU_TRIAGE_*` settings go into `.env.example`; on the server the rules file is `/app/data/khipu.triage.json`, found by default through cloud-deployment's `resolveDataFile('khipu.triage.json', 'KHIPU_TRIAGE_CONFIG')` (next to the archive, cwd-independent; the setting was renamed from `KHIPU_TRIAGE_RULES` per cross-spec decision D5). Triage behavior does not branch on `KHIPU_DEPLOYMENT`.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Pipeline with pure core, ports for IO (selected) | Pure rule parser and matcher, pure schema and normalizer; IO behind small injected functions (archive reads, presence, judge, store) | Fully unit-testable, matches llm-provider and presence styles | More small files | Fits 200-line limit |
| Agentic tool loop | Give the model `TOOL_DEFINITIONS` and let it fetch thread context | Flexible context | `chatStructured` forbids tools; more calls, more content egress | Rejected |
| Separate outbox table for hand-off | Copy important decisions into `triage_handoff` rows | Decouples log retention | Duplicate data, two writes per decision, ownership blur | Rejected in favor of decisions-as-outbox |

## Design Decisions

### Decision: Module tree `src/triage/`
- **Context**: about 20 files; steering prefers flat `src/` but presence-context (`src/presence/`) and cloud-deployment (`src/ingress/`) already introduced feature directories for cohesive modules.
- **Selected Approach**: `src/triage/` directory, tests as `tests/triage-*.test.ts`.
- **Trade-offs**: deviates from the oldest steering text but follows the current Phase 5 precedent.

### Decision: Separate rules file `khipu.triage.json`
- **Alternatives Considered**: 1. `triage` section inside `khipu.config.json` (account registry); 2. separate file (selected); 3. env-only rules.
- **Rationale**: the account registry and `khipu slack login` rewrite `khipu.config.json`; a separate file avoids parser coupling and concurrent-writer risk, can be hot-reloaded by mtime, and makes the "triage rules are not the Slack watch list" boundary physical.
- **Follow-up**: document in `.env.example` and `docs/TRIAGE.md`.

### Decision: Decisions table doubles as the hand-off outbox
- **Context**: notifier and action-runner need an ordered, durable, at-least-once feed with their own cursors.
- **Selected Approach**: `triage_decisions.id` is `AUTOINCREMENT`; `readVerdicts` examines rows after a consumer's `last_decision_id` and returns only `kind = 'event' AND important = 1`, with an `ackId` semantics identical to message-events. Cursors live in `triage_verdict_cursors` (not message-events' `consumer_cursors`, whose ids refer to a different sequence).
- **Trade-offs**: retention must respect consumer positions for important rows; simple and single-write.

### Decision: Dynamic strict verdict schema with action enum
- **Context**: the model may only pick allowlisted action ids with valid params; triage must not import Ajv (llm-provider restricts it to `llm-structured.ts`).
- **Selected Approach**: per evaluation, build the schema from the catalog: `suggested_action` is `anyOf` of `{ type: 'null' }` and one object branch per action (`id` with a single-value `enum`, `params` = the action's `params_schema`). `chatStructured` validates (provider and Ajv); triage re-checks the id against the catalog snapshot. Schemas are memoized by catalog content so llm-structured's identity cache stays effective.
- **Trade-offs**: action-runner must provide params schemas in the strict subset; Ollama grammar support for `anyOf` with many branches is weaker (mitigated: catalog is small, invalid answers degrade per Req 8).

### Decision: Action catalog as a consumer-defined, read-only contract
- **Selected Approach**: triage defines `ActionDescriptor`, `ActionCatalog`, `EMPTY_ACTION_CATALOG`, and one seam `defaultActionCatalog()` returning the empty catalog. Superseded by cross-spec decisions D7, D12, and D14: `defaultActionCatalog()` stays empty permanently; action-runner sets `DaemonSharedWiring.actionCatalog` inside message-events' `composeSharedWiring(env)` (`src/daemon-wiring.ts`); the triage service entry calls `startTriage({ env: ctx.env, actionCatalog: ctx.shared.actionCatalog })`, and the thin entry `src/cli-entries/triage-cli.ts` calls `composeSharedWiring(process.env)` then `runTriageCli(argv, { catalog: shared.actionCatalog })`. action-runner never edits triage files, and no file under `src/triage/` imports `src/daemon-wiring.ts`, `src/daemon-services.ts` (beyond the type-only import in `service.ts`), or `src/actions/`. Tests and callers may inject a catalog.
- **Rationale**: triage works before action-runner exists; there is exactly one edit point; no mutable global registry.

### Decision: Rule-mapped action parameters are templated, not schema-validated by triage
- **Context**: Req 4.4 to 4.6.
- **Selected Approach**: rule `action.params` values may contain `${group}` (regex named group), `${message_id}`, `${chat_id}`; triage checks id presence in the catalog and placeholder resolution only. action-runner remains the owner of params validation before execution (Req 10.6).

### Decision: In-memory hourly LLM budget
- **Selected Approach**: sliding one-hour window of call timestamps in the daemon process; resets on restart. Replay calls use the CLI process's own budget.
- **Trade-offs**: not persisted; acceptable for a cost guard.

### Decision: Decisions are written by the consumer, not the pipeline
- **Selected Approach**: `evaluateMessage` returns a `DecisionDraft`; the consumer inserts it (event kind) and the replay command inserts only on `--save` (replay kind). This keeps replay side-effect free by default and the pipeline pure apart from reads and the model call.

## Synthesis Outcomes
- **Generalization**: the hand-off feed reuses the message-events consumer contract shape (`register`, `read` with `ackId`, `ack`, `status`, same name pattern and error codes), so notifier and action-runner implement one familiar loop twice.
- **Build vs Adopt**: no new library. Regex via built-in `RegExp`; hashing via `node:crypto`; validation through llm-provider. ntfy-style or queue libraries are irrelevant (no delivery here).
- **Simplification**: no tool loop, no persisted budget, no separate outbox table, no MCP surface, no rule learning. One consumer loop, sequential evaluation.

## Risks & Mitigations
- Prompt injection from message content: system prompt marks content as data; output constrained to schema and allowlisted ids; triage never executes anything.
- Regex catastrophic backtracking: pattern length capped at 500, matched text capped at 10 000 characters, patterns compiled once per rules load.
- Upstream specs unimplemented: tasks start with a prerequisite check; tests use upstream fakes only where the upstream contract is stable.
- Model latency on local Ollama (tens of seconds): sequential processing may build a backlog; budget and `too_old` cutoff bound it; `khipu triage status` shows lag.
- Both laptop and server daemons running on separate archives would triage twice: documented; each archive has its own decisions.

## References
- `.kiro/specs/message-events/design.md`: consumer API and loop contract.
- `.kiro/specs/llm-provider/design.md` and `research.md`: `LlmClient`, error kinds, strict subset.
- `.kiro/specs/presence-context/design.md`: `presenceForLlm`, `formatPresenceSummary`.
- `.kiro/specs/slack-all-workspaces/design.md`: `SlackSettings.watch`, tiers.
- `.kiro/specs/cloud-deployment/design.md`: `resolveDbPath`, `.env.example` check, deployment profile.
