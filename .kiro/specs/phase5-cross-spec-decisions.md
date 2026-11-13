# Phase 5 cross-spec decisions (remediation round 1, 2026-11-12)

Binding resolutions from the Phase 5 cross-spec review. Every Phase 5 spec must conform. Owner = the only spec that defines/implements the item; others reference it.

## D1. Sync time ("since") for the daemon: owner message-events
- Folds roadmap candidate `watch-lastsync` into message-events: `runAdapterCycle` (watch.ts wiring) writes the platform/account last-sync time on an ok cycle outcome, so events from ALL daemon-synced platforms are tagged `live` after the first cycle.
- slack-all-workspaces must NOT write `setPlatformLastSyncedAt` itself (remove its req 7.8 behaviour / SlackCycle write step); it relies on D1.

## D2. Secret `_FILE` allowlist: owner cloud-deployment
cloud-deployment lists every Phase 5 secret up front in Req 6 / SecretFileLoader / task 1.4:
`KHIPU_LLM_API_KEY`, `SLACK_USER_TOKEN`, `SLACK_COOKIE`, pattern `^SLACK_(TOKEN|COOKIE)_[A-Z0-9_]+$`, `INGRESS_TOKEN`, pattern `^INGRESS_TOKEN_[A-Z0-9_]+$`, `INGRESS_SIGNING_KEY`, `NTFY_TOKEN`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`, `TELEGRAM_NOTIFY_BOT_TOKEN` (plus whatever it already had). Other specs' allowlist tasks become verification only.

## D3. Signed capability links (former notifier UC-1): owner cloud-deployment
Folded into cloud-deployment as a new requirement "Signed capability paths": `IngressModule.capabilityPaths?`, `src/ingress/capability.ts` (`signCapability`, `verifyCapability`, `capabilityFromLocals`, node:crypto only), token `<payload>.<exp>.<sig>` HMAC-SHA256 with per-module key derived as `khipu-ingress-capability:v1:<id>` from `INGRESS_SIGNING_KEY` (optional, >=32 chars; absent => capability auth off + one startup warning), verified before routing and body parsing, `res.locals.ingressCapability`, log redaction `<capability>`, AuthFailureReason `capability-invalid` | `capability-expired`, query tokens still rejected. Notifier keeps single-use/one-action-per-notification/hash storage (DB side) and references this as an upstream contract; notifier tasks 1.2 to 1.4 removed, its human amendment gate removed.

## D4. Ingress context and isolation: owner cloud-deployment
- `IngressContext` gains `readonly env: NodeJS.ProcessEnv`; modules read env from ctx, not `process.env`.
- IngressIsolationTest follows the transitive import closure.

## D5. Data file locations: owner cloud-deployment
`resolveDataFile(name, envVar)` in `src/db-path.ts`: env var wins, else `join(dirname(resolveDbPath()), name)`; cwd-independent. Config files and env vars: `khipu.triage.json` / `KHIPU_TRIAGE_CONFIG`, `khipu.notify.json` / `KHIPU_NOTIFY_CONFIG`, `khipu.actions.json` / `KHIPU_ACTIONS_CONFIG`. (triage renames `KHIPU_TRIAGE_RULES` to `KHIPU_TRIAGE_CONFIG`.) `khipu.config.json` (account registry) is unchanged.

## D6. Schema creation: owner message-events (`src/schema-registry.ts`)
- One convention: each spec defines its tables in a DDL-only module `src/<area>/schema.ts` (or `src/<name>-schema.ts` for flat modules) exporting `apply<Name>Schema(db)`; DDL-only means it imports nothing but types / better-sqlite3 types.
- `src/schema-registry.ts` holds an ordered `SCHEMA_MODULES` list; `initDb` in db.ts calls it once. Each spec adds one import + one entry (like INGRESS_MODULES). No lazy `ensure*Schema` on first use.
- Isolation rules in triage, notifier, action-runner, ingress explicitly allow DDL-only `*/schema.ts` modules and `src/schema-registry.ts`.

## D7. Daemon services: owner message-events (`src/daemon-services.ts`)
- Ordered `DAEMON_SERVICES: { name, start(ctx): ServiceHandle | null }[]` with `ServiceHandle { drain(timeoutMs): Promise<void>; stop(): void }`. watch.ts calls `startDaemonServices` once at startup and drains/stops them on SIGINT/SIGTERM in reverse order.
- Order: event retention (message-events), triage-agent, notifier, action-runner. Each spec adds one entry; none edits watch.ts for start/stop.
- `ctx` carries the shared wiring: action-runner's catalog and approval offer are injected into triage (`StartTriageOptions.actionCatalog`) and notifier (`StartNotifierOptions.offer`) through this wiring. Seam bodies `defaultActionCatalog()` / `defaultApprovalOffer()` stay EMPTY defaults in upstream files; action-runner does not edit upstream files (the CLIs get the catalog via the same composition function exported from `src/actions/`, imported by the wiring layer only).

## D8. Time units
All Phase 5 shared tables use unix seconds. `account_health.changed_at` / `checked_at` switch to seconds. Slack-internal `slack_*` tables may stay ms but must be labelled.

## D9. Shared launchd plist helper: owner presence-context
`src/launchd-plist.ts` (pure plist builder + install/uninstall via launchctl) owned by presence-context; action-runner's laptop agent reuses it. Roadmap candidate `setup-sync-stale-path` stays direct implementation but should use this helper once it exists.

## D10. Local Ollama on the server: owner llm-provider
llm-provider adds `KHIPU_LLM_LOCAL_HOSTS` (comma-separated hostnames treated as local, e.g. `ollama` compose service); triage `local-only` routing stays valid without `KHIPU_LLM_ALLOW_CLOUD`. cloud-deployment's guide documents it.

## D11. Nested ingest scopes: owner message-events
message-events IngestContext invariant names Slack as a nesting caller (backfill scopes inside a daemon cycle) and rolls inner stats into the outer scope.

## Not adopted (reported only)
- Optional spec splits (slack-credential-capture, notify-callbacks): not done this round.
- Shared cursor-feed helper / shared import-graph test helper: optional, implementer's discretion.

# Remediation round 2 additions (2026-11-12)

## D12. Shared daemon wiring fields: owner message-events
- `DaemonSharedWiring` (in `src/daemon-wiring.ts`, see D14) has optional fields `actionCatalog?: ActionCatalog` and `approvalOffer?: ApprovalOffer`, typed via type-only imports. action-runner sets them inside `composeSharedWiring(env)` by calling `composeActionSeams({ env })`.
- Service bodies read the fields themselves: triage's entry calls `startTriage({ env: ctx.env, actionCatalog: ctx.shared.actionCatalog })`; notifier's entry calls `notifierService({ env: ctx.env, mode: ctx.mode, shared: ctx.shared })` (mode added per D17) and reads `ctx.shared.approvalOffer`. Neither reads `ctx.actionCatalog` / `ctx.approvalOffer` / `ctx.log` (no `log` on the context; services use their own logger).
- action-runner never edits other specs' DAEMON_SERVICES entries; it only adds its own entry and fills `composeSharedWiring`.

## D13. Shutdown and single-pass semantics: owner message-events
- `ctx.mode: 'watch' | 'once'` decides drain behaviour; every service branches on it.
- Signal shutdown (mode 'watch'): `drain` starts NO new work and only awaits in-flight work. `stopDaemonServices` runs drain then stop per service in REVERSE registry order under ONE overall deadline `SERVICE_SHUTDOWN_DEADLINE_MS = 25_000` (total, not per service). Per-service limits from their own requirements (triage 10 s grace, action-runner 15 s) still apply inside it.
- Single pass (mode 'once'): `runSinglePass` drains services in FORWARD registry order (producers before consumers: event-retention, triage-agent, notifier, action-runner), each processing pending work until none remain or its own bound, then stops all in reverse order.
- cloud-deployment: compose `stop_grace_period` must exceed the 25 s total deadline plus sync-cycle drain (set 45s) and the guide states the relationship.

## D14. CLI access to shared wiring: owner message-events
- `composeSharedWiring(env)` lives in a light module `src/daemon-wiring.ts` that imports only the composition functions (action-runner's `composeActionSeams`) and types; `src/daemon-services.ts` imports it. It never imports service runtimes.
- The triage and notify CLIs are reached through thin entry scripts outside their feature dirs, `src/cli-entries/triage-cli.ts` and `src/cli-entries/notify-cli.ts` (owned by triage-agent and notifier respectively), which call `composeSharedWiring(process.env)` then `runTriageCli(argv, { catalog: shared.actionCatalog })` / `runNotifyCli(argv, { offer: shared.approvalOffer })`. `khipu.ts` OPERATIONAL_SCRIPTS point at these entries. `src/triage/**` and `src/notify/**` still never import daemon-wiring, daemon-services or actions.

## D15. Minor alignments
- message-events Req 7.6/7.7: "when the adapter call resolves / rejects" (Slack's auth-failed cycle resolves; safe because Slack ignores `since` and uses per-conversation cursors).
- Canonical SCHEMA_MODULES order (message-events owns the list): message-events, account-health, slack, presence, triage, notifier, action-runner. Entry `name` = `<spec>[:<module>]` (e.g. `slack-all-workspaces:account-health`, `slack-all-workspaces:slack`).
- action-runner's laptop LaunchAgent uses presence's helper exactly: `LaunchdDeps`, `LaunchdInstallResult` / `LaunchdUninstallResult`, `buildLaunchdPlist`, `installLaunchAgent`, `uninstallLaunchAgent`, `launchAgentStatus`.
- `composeActionSeams({ env })` and `resolveDataFile(name, envVar, { env })`: no `process.env` reads in composition code; notifier likewise.
- notifier resolves its signing key with cloud-deployment's `readSigningKey(env)`.
- Stale UC-1 / seam-edit / own-sync_state / initDb-hook wording in research.md and design.md files is marked superseded by the relevant D-number or rewritten.

## D16. Type-only imports of daemon types (clarifies D14)
"Never imports daemon-services / daemon-wiring" means no RUNTIME import. A feature's service-entry file (e.g. `src/triage/service.ts`, `src/notify/service.ts`, `src/actions/service.ts`) MAY use `import type` from `src/daemon-services.ts` for `DaemonService`, `DaemonServiceContext`, `ServiceHandle`, `DaemonSharedWiring`; type imports are erased and load no service runtime. Isolation tests allow exactly this (type-only, service-entry file only).

# Remediation round 3 additions (2026-11-12)

## D17. Final alignment
- **Shutdown arithmetic (owner message-events):** watch.ts waits at most `CYCLE_DRAIN_TIMEOUT_MS = 15_000` for in-flight sync cycles (was 30 s), then `stopDaemonServices` runs under the 25 s total deadline. Worst case 15 + 25 = 40 s, below cloud-deployment's `stop_grace_period: 45s`. Both specs state this arithmetic.
- **Single-pass bound (owner message-events):** `runSinglePass` passes each service a finite bound `SINGLE_PASS_SERVICE_BOUND_MS = 120_000`; services treat `timeoutMs` as their bound (no `Number.POSITIVE_INFINITY`).
- **DaemonSharedWiring field ownership (amends D12):** message-events creates `src/daemon-wiring.ts` with an empty `DaemonSharedWiring` and `composeSharedWiring` returning `{}`. triage-agent adds `actionCatalog?: ActionCatalog` (plus its type-only import) in the same task that creates `src/triage/action-catalog.ts`; notifier adds `approvalOffer?: ApprovalOffer` in the task that creates `src/notify/approval-offer.ts`. These one-line field declarations are the only sanctioned edits of `daemon-wiring.ts` by those specs. action-runner only fills the `composeSharedWiring` body (adding a field only if absent, as a fallback) and does not claim ownership of the fields.
- **D12 call shape corrected:** notifier's entry is `notifierService({ env: ctx.env, mode: ctx.mode, shared: ctx.shared })`.
- **D13 clarification:** a service MAY abort its in-flight work on signal shutdown within its own requirement's limit (action-runner aborts the running command, recorded as interrupted, within 15 s). Draining order is reverse, so action-runner (first) may consume part of the 25 s total before triage's 10 s grace.
- **Env reads:** event retention reads `env['EVENT_RETENTION_DAYS']` from the passed env, not `process.env`.
- **CLI entries:** OPERATIONAL_SCRIPTS values are relative to `src/` (`'cli-entries/triage-cli.ts'`, `'cli-entries/notify-cli.ts'`); `runNotifyCli(argv, opts): Promise<number>` like `runTriageCli`, entries set `process.exitCode`.

# Remote MCP (2026-11-13)

## D18. Remote MCP endpoint: owner remote-mcp
- **Own process and port:** the remote MCP endpoint runs as its own process, `khipu mcp --http`, on its own port (default `127.0.0.1:3335`). It is never mounted on the ingress and is not an `IngressModule`. Plain `khipu mcp` keeps the stdio transport unchanged.
- **Ingress isolation unchanged:** cloud-deployment Req 10.1, 10.2 and task 3.5 keep their meaning; the forbidden-module list of the ingress isolation test now also includes `src/remote-mcp/**`, and Req 10.3 reads "The MCP server shall not be reachable through the ingress server; remote HTTP access is provided only by the remote MCP endpoint defined in remote-mcp."
- **Secret allowlist (amends D2):** the name pattern `^MCP_TOKEN_[A-Z0-9_]+$` joins the `_FILE` allowlist (cloud-deployment Req 6.7). The allowlist owner is still cloud-deployment (`src/secret-files.ts`); remote-mcp only consumes the resolved values.
- **Compose profile:** the optional `mcp-http` service under compose profile `remote-mcp` (runs `khipu mcp --http`, `MCP_HTTP_HOST=0.0.0.0` inside the container, published only as `127.0.0.1:3335:3335`, health-checked via `/healthz`) is owned by cloud-deployment ComposeStack (task 7.2, Req 4.5).
- **Ownership:** remote-mcp owns `src/remote-mcp/**` and the settings `MCP_TOKEN_<CLIENT>`, `MCP_TOOLS_<CLIENT>`, `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, and `MCP_ALLOWED_ORIGINS`. cloud-deployment lists `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_ALLOWED_ORIGINS` in its environment template (task 7.3).
