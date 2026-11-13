# Research & Design Decisions: presence-context

## Summary
- **Feature**: `presence-context`
- **Discovery Scope**: New Feature (new domain: location) integrated into an existing system (ingress, tool registry, CLI router, DB). Full discovery for external formats (OwnTracks, CoreLocationCLI, launchd); light discovery for codebase integration.
- **Key Findings**:
  - OwnTracks HTTP mode POSTs one JSON object per request, expects any 2xx (typically `200` with body `[]`), and identifies the device via `X-Limit-U` / `X-Limit-D` headers, `?u=&d=` query params, or (iOS) the `topic` key. Required location fields are `lat`, `lon`, `tst`, plus `tid` in HTTP mode. Many non-location `_type` values (`transition`, `waypoint`, `lwt`, `card`, `status`, `encrypted`, zero-length) also arrive and must be acknowledged, not rejected.
  - CoreLocationCLI (MIT, `brew install --cask corelocationcli`) prints one fix by default; `--format` accepts `%latitude %longitude %h_accuracy` and also address specifiers. `--json` prints all fields, including address fields, which implies reverse geocoding through Apple; the reporter must use `--format` with coordinate specifiers only.
  - launchd `StartInterval` firings that fall during sleep are missed; `StartCalendarInterval` firings are coalesced into one run on wake. A calendar schedule every N minutes therefore gives "every N minutes and once on wake" with one mechanism.
  - The ingress (cloud-deployment) already provides Basic-auth-password tokens, per-module `INGRESS_TOKEN_<ID>`, body parsing, and an isolation test that follows every file imported by `src/ingress/modules.ts`. Presence logic must therefore live in a module tree (`src/presence/`) that imports neither the tool registry nor query surfaces.

## Research Log

### OwnTracks HTTP mode transport
- **Context**: Requirement 1; the phone client is fixed by the roadmap.
- **Sources Consulted**: https://owntracks.org/booklet/tech/http/ (fetched 2026-11-12)
- **Findings**:
  - Method POST, `Content-Type: application/json`, one message per request.
  - Authentication: HTTP Basic, configured in the app's Identification settings or embedded in the URL. TLS strongly recommended.
  - Identification: `X-Limit-U` (user) and `X-Limit-D` (device) headers, or `?u=user&d=device`; iOS adds `topic` (e.g. `owntracks/user/device`) to unencrypted payloads.
  - Success: any 2xx; `200` with `[]` is typical. The response body may be an array of objects the app acts on (`location` of friends, `cmd`, `card`, `transition`); returning `[]` means "nothing for you".
  - Unreachable endpoints cause the app to queue and retry later, so the same fix can arrive more than once.
  - Zero-length payloads are sent when a friend is deleted and should be ignored.
  - Behavior of the app on non-2xx from a reachable endpoint is not documented.
- **Implications**: Always reply `200 []` for anything that is well-formed but not a storable location (other `_type`, empty body, unknown device). Reply `400` only for location messages that violate the schema. Deduplicate on (device, source, fix time). Device id order: `X-Limit-D`, `?d=`, last `topic` segment, `tid`.

### OwnTracks location JSON
- **Context**: Requirement 1.1, 1.4, 5.3.
- **Sources Consulted**: https://owntracks.org/booklet/tech/json/ (fetched 2026-11-12)
- **Findings**:
  - Required: `lat` (float deg), `lon` (float deg), `tst` (int epoch seconds, fix time), `tid` (HTTP mode).
  - Optional: `acc` (int m, omitted when zero), `alt`, `vac`, `vel`, `cog`, `batt`, `bs`, `conn`, `t` (trigger, `p` ping, `u` manual, `r` reportLocation response, `c` region, `t` timer, `v` frequent locations), `topic`, `created_at`, `m` (1 significant, 2 move), `SSID`, `BSSID`, `inregions`, `inrids`, `poi`, `tag`, `motionactivities`.
  - Other `_type`: `transition`, `waypoint`, `waypoints`, `lwt`, `card`, `status`, `configuration`, `cmd`, `beacon`, `steps`, `encrypted`, `request`.
- **Implications**: Keep only `lat`, `lon`, `acc`, `tst`, and the device id; drop everything else, including `SSID`/`BSSID` and `inregions` (privacy minimisation, 5.3). Missing `acc` is treated as unknown accuracy (default 100 m in co-location). `encrypted` payloads are out of scope and acknowledged with a warning so the phone does not retry forever.

### CoreLocationCLI
- **Context**: Requirement 3; laptop location source fixed by the roadmap.
- **Sources Consulted**: https://github.com/fulldecent/corelocationcli README (fetched 2026-11-12)
- **Findings**:
  - Install: `brew install --cask corelocationcli` (notarized release). License MIT.
  - Options: `-h`, `--version`, `-w/--watch`, `-v/--verbose`, `-f/--format FORMAT` (default `%latitude %longitude`), `-j/--json`.
  - Format specifiers include `%latitude %longitude %altitude %h_accuracy %v_accuracy %time %timeZone` and address specifiers (`%address`, `%locality`, ...).
  - `--json` output includes address fields; the README notes Wi-Fi must be on, otherwise `kCLErrorDomain error 0` (location unknown).
  - The README does not document the permission prompt, `--timeout`, or launchd use.
- **Implications**: Invoke `CoreLocationCLI --format "%latitude %longitude %h_accuracy"` once, with a 30 s kill timeout enforced by the reporter (no reliance on a tool flag). Parse three space-separated numbers. Map stderr containing `kCLErrorDomain error 1` (Core Location `kCLErrorDenied`) to `denied`, `error 0` to `no-fix` (suggest enabling Wi-Fi). Timezone comes from the Node process (`Intl.DateTimeFormat().resolvedOptions().timeZone`), which follows macOS automatic timezone, not from the tool. Fix time is the reporter's clock at the moment the fix returns.

### macOS location permission and launchd
- **Context**: Requirement 4 and the brief's constraint "daemon (non-GUI) launchd jobs cannot hold the permission".
- **Sources Consulted**: launchd.plist(5) man page (https://keith.github.io/xcode-man-pages/launchd.plist.5.html, fetched 2026-11-12); brief.md constraints; existing `src/setup-sync.ts` LaunchAgent pattern.
- **Findings**:
  - `StartInterval`: "if the system is asleep during the time of the next scheduled interval firing, that interval will be missed".
  - `StartCalendarInterval`: "launchd will start the job the next time the computer wakes up", and multiple missed intervals "will be coalesced into one event upon wake from sleep".
  - `LimitLoadToSessionType` restricts an agent to given session types; `Aqua` is the GUI login session (value used widely, not defined on the page).
  - Location authorization is tied to the responsible app or binary; whether a launchd user agent invoking the cask's CoreLocationCLI inherits the authorization granted in Terminal is not documented anywhere found.
- **Implications**: Agent is a per-user LaunchAgent (`~/Library/LaunchAgents/com.khipuchat.presence-reporter.plist`), `LimitLoadToSessionType` `Aqua`, `StartCalendarInterval` array of `{Minute: m}` for every interval step, `RunAtLoad` true. Installed with `launchctl bootstrap gui/<uid>` and removed with `launchctl bootout gui/<uid>/<label>`. The permission behavior under launchd is the main unknown, so tasks start with a go/no-go spike (task 1.1), mirroring zalo-full-history's spike pattern.

### Codebase integration points
- **Context**: light discovery on the existing system.
- **Findings**:
  - `src/tool-registry.ts` (80 lines) holds `TOOL_DEFINITIONS` and `dispatchTool`; both `mcp.ts` and `ask.ts` consume it, so one new definition reaches MCP and ask. `tests/ask-parity.test.ts` asserts `TOOL_DEFINITIONS` has length 8 and `scripts/test-mcp.sh` lists tool calls; both need one update.
  - `src/khipu.ts` (280 lines) maps operational subcommands to scripts through `OPERATIONAL_SCRIPTS`; adding `presence` is one entry plus help text.
  - `src/db.ts` `initDb` creates schema, then migrations; message-events adds `applyEventSchema` after `runMigrations`. ~~Presence follows the same one-line hook (`applyPresenceSchema`).~~ **Superseded by Phase 5 D6**: presence ships a DDL-only `src/presence/schema.ts` registered in message-events' `SCHEMA_MODULES`; no hook in `initDb`.
  - `src/web/routes.ts` (135 lines) registers `/api/*` JSON routes behind optional basic auth; one `GET /api/presence` route fits.
  - `src/setup-sync.ts` shows the existing plist-writing style (`launchctl load`, label `com.khipuchat.sync`).
  - Config is env-driven throughout (llm-provider `KHIPU_LLM_*`, cloud-deployment `INGRESS_*`); `src/config.ts` must not be imported (eagerly reads Telegram env).
  - cloud-deployment is designed but `src/ingress/` does not exist yet; presence's ingress task depends on it.
- **Implications**: New code under `src/presence/`; thin edits to five existing files.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Pure core + thin adapters | Pure functions (geo, payload parsing, snapshot) over a small store; ingress, tool, CLI, web are adapters | Testable without HTTP or macOS; one place for precision rules | Slightly more files | Selected |
| Presence inside query-handlers | Add presence to `query-handlers.ts` | Fewer files | Ingress cannot import query-handlers (isolation rule); file already 258 lines | Rejected |
| Laptop writes DB directly | Laptop agent opens the archive | No HTTP on laptop | Archive lives on the server in Phase 5 | Rejected |
| Laptop long-running watcher (`--watch`) | KeepAlive agent streaming fixes | Fast updates | Battery, permission held longer, more failure modes | Rejected for v1 |

## Design Decisions

### Decision: Two fixed device roles
- **Context**: Brief and downstream specs only need phone and laptop.
- **Alternatives Considered**: 1. Arbitrary device registry with roles. 2. Exactly `phone` and `laptop` roles, raw device id kept for audit.
- **Selected Approach**: Option 2. `device` column is a role; `source_device` keeps the client's id.
- **Rationale**: Simplification lens; co-location is defined between two devices.
- **Trade-offs**: Multiple phones need a revalidation (listed trigger).
- **Follow-up**: none.

### Decision: Single precision gate for LLM-bound output
- **Context**: Requirement 9 and the brief's privacy constraint.
- **Alternatives Considered**: 1. Each consumer redacts. 2. One `presenceForLlm` function used by the tool registry and by triage-agent.
- **Selected Approach**: Option 2, driven by `KHIPU_PRESENCE_LLM_PRECISION` (`coarse` default).
- **Rationale**: Generalization lens: tool output and triage context are the same problem. No hidden shared ownership.
- **Trade-offs**: triage-agent must call it rather than serialising the raw snapshot (stated as an obligation).

### Decision: Calendar schedule for the laptop agent
- **Context**: Requirement 4.1 needs "interval and on wake".
- **Selected Approach**: `StartCalendarInterval` entries every N minutes (N divides 60) plus `RunAtLoad`.
- **Rationale**: Adopt the platform feature (launchd coalesces missed calendar runs on wake) instead of building a sleep/wake listener.
- **Trade-offs**: N restricted to divisors of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60).

### Decision: Env-based settings, compact places syntax
- **Context**: Places need structured data; the project config is env-driven and Docker `env_file` friendly.
- **Alternatives Considered**: 1. A `presence` section in `khipu.config.json` (owned by account-registry). 2. `KHIPU_PRESENCE_PLACES="home=45.5017,-73.5673,150,America/Toronto;office=..."`.
- **Selected Approach**: Option 2.
- **Rationale**: Does not touch account-registry; one setting family owned by one module.
- **Trade-offs**: Less readable for many places; acceptable for a handful.

### Decision: Staleness defaults per role
- **Context**: OwnTracks in significant-change mode reports rarely while stationary; the laptop agent reports every 5 minutes while awake.
- **Selected Approach**: phone 180 min, laptop 30 min, both configurable.
- **Rationale**: A stationary phone at the desk still counts as fresh for a working session; a closed laptop quickly becomes stale, which yields `unknown` (consumers then treat the user as away).
- **Follow-up**: tune after a week of real data; values are settings, not code.

### Decision: Coarse distance rounding
- **Selected Approach**: coarse views round `distance_m` to the nearest 50 m. Relative distance between the user's own devices does not reveal absolute position but rounding removes accuracy-level detail at no cost.

### Build vs adopt summary
- Adopt OwnTracks (phone), CoreLocationCLI (laptop), launchd calendar scheduling, `Intl` for timezones and local time formatting.
- Build haversine distance and place containment (a few lines; no geo library justified). No reverse geocoding, no timezone-from-coordinates dataset (out of scope, would need large data or a service).

## Risks & Mitigations
- Location permission not honored for the launchd agent: go/no-go spike first (task 1.1); fallback documented: run the reporter from a login item or keep the laptop as `unknown` (routing falls back to phone).
- OwnTracks queued retries: dedupe on (device, source, fix time).
- Ingress not yet implemented: presence ingress task declares the dependency; all core logic is testable without it.
- Clock skew between phone and server: 5-minute future tolerance; older fixes accepted until the retention age.
- Accuracy unknown or poor (Wi-Fi off): accuracy cap yields `unknown` instead of a wrong "together".

## References
- [OwnTracks HTTP mode](https://owntracks.org/booklet/tech/http/): transport, auth, identification, response.
- [OwnTracks JSON](https://owntracks.org/booklet/tech/json/): `_type=location` fields.
- [CoreLocationCLI](https://github.com/fulldecent/corelocationcli): install, options, format specifiers.
- [launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html): StartInterval vs StartCalendarInterval sleep behavior.
- `.kiro/specs/cloud-deployment/design.md`: `IngressModule` contract, auth, isolation rule.
