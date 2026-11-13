# Research & Design Decisions: cloud-deployment

## Summary
- **Feature**: `cloud-deployment`
- **Discovery Scope**: Extension (brownfield: container, sync daemon gating, DB open path) plus one new surface (ingress server). Light discovery for the extension parts, focused full discovery for ingress auth and backup semantics because they are security-sensitive.
- **Key Findings**:
  - 18 entrypoints open the DB with two incompatible conventions: `'./khipuchat.db'` (cwd-relative: watch.ts, web/server.ts, all 9 `src/platforms/*/sync.ts`) and `path.join(__dirname, '..', 'khipuchat.db')` (project-root: cli.ts, mcp.ts, ask.ts, khipu-list.ts, khipu-sync-status.ts, index-embeddings.ts). They agree only when cwd is the repo root.
  - Alpine is the wrong base: `onnxruntime-node` (used by `@huggingface/transformers`) ships no musl prebuilds, and `sqlite-vec` platform packages are glibc builds. A Debian slim Node 24 base removes both problems.
  - `src/web/server.ts` binds `127.0.0.1` by default; inside a container that makes the published port unreachable. A host override is needed, and with it a guard against an unauthenticated non-loopback bind.
  - `initDb` sets no `busy_timeout`; with three services (sync, web, ingress) on one WAL database, a reader or the per-open FTS rebuild can fail immediately with `SQLITE_BUSY`.
  - `isConfigured('signal')` lists `BEEPER_ACCESS_TOKEN` as its env hint, but `loadRegistry()` synthesizes a `default` Signal account when `SIGNAL_BACKEND=cli`, so the signal-cli backend is already considered configured without a Beeper token. The gating rework must preserve this and, in addition, classify Signal by backend (cli = network, beeper = local-session).

## Research Log

### Database path resolution
- **Context**: Brief: the `db-data` volume is mounted at `/app/khipuchat.db`, turning the file path into a directory.
- **Sources Consulted**: `grep` of `initDb(` across `src/`; `docker-compose.yml`; `src/db.ts` `initDb`.
- **Findings**: 18 call sites (listed above). `index-embeddings.ts` already accepts `--db <path>`. WAL mode creates `-wal` and `-shm` siblings, so the persistent mount must be the containing directory, not the file.
- **Implications**: One helper `resolveDbPath()` used by every call site. Default stays project-root `khipuchat.db` (what MCP via Claude Desktop already uses, and identical to the cwd form when run from the repo root). Volume mounted at `/app/data`, `KHIPU_DB_PATH=/app/data/khipuchat.db`.

### Container base image
- **Context**: `Dockerfile` uses `node:20-alpine`; `package.json#engines` is `>=24 <25` with `engine-strict=true`.
- **Sources Consulted**: onnxruntime-node npm prebuilt table (Windows, Linux x64/arm64 glibc, macOS only); Hugging Face forum "transformers library won't run under node-alpine"; sqlite-vec npm platform packages.
- **Findings**: `npm ci` on Node 20 fails the engine check outright. On Alpine, the embedding runtime cannot load. `better-sqlite3-multiple-ciphers` builds from source if no prebuild matches, which needs `python3`, `make`, `g++` in the builder stage.
- **Implications**: `node:24-bookworm-slim` for both stages, build toolchain only in the builder, `npm ci` with `PUPPETEER_SKIP_DOWNLOAD` (whatsapp-web.js is not run on the server). Run as the image's built-in `node` user. Multi-arch release workflow already exists and keeps working.

### Sync daemon gating
- **Context**: `LOCAL_ONLY_PLATFORMS = {imessage, whatsapp, zalo}` are always "configured".
- **Sources Consulted**: `src/watch.ts`, `src/platforms/signal/backend.ts`, `src/platforms/signal/cli-sync.ts`, `src/platforms/facebook/sync.ts`, `tests/watch.test.ts`.
- **Findings**: Facebook and Beeper-Signal call Beeper Desktop at `localhost:23373`, which is a desktop-local session just like WhatsApp's LocalAuth and Zalo's `.zalo_session.json`. The signal-cli adapter reads `SIGNAL_CLI_SOCKET` (UNIX socket path) from credentials or env; the transport also supports TCP but the adapter does not wire it.
- **Implications**: Requirement classes `macos` (imessage), `local-session` (whatsapp, zalo, facebook, signal when backend is beeper), `network` (telegram, discord, slack, email, signal when backend is cli). On the server, Signal uses a signal-cli daemon container sharing a UNIX socket through a named volume (no TCP change needed).

### Ingress authentication for downstream clients
- **Context**: presence-context (OwnTracks HTTP mode, laptop reporter) and notifier (ntfy action buttons, Telegram bot webhook) will call the ingress.
- **Sources Consulted**: OwnTracks HTTP mode docs (supports HTTP Basic username/password and custom headers depending on client); ntfy "http" action (arbitrary headers); Telegram Bot API `setWebhook` `secret_token` (sent as `X-Telegram-Bot-Api-Secret-Token`).
- **Findings**: Not every client can send `Authorization: Bearer`. Basic auth with the token as password, and a module-declared header, cover all known clients without per-module auth code.
- **Implications**: Ingress owns three credential sources (Bearer, Basic password, declared header). Query-string tokens are never accepted, since they leak into proxy logs. Optional per-module tokens (`INGRESS_TOKEN_<ID>`) allow revoking a phone without rotating the master token.

### Online backup with SQLCipher
- **Context**: Unattended server needs backups without stopping the daemon; the archive may be encrypted.
- **Sources Consulted**: SQLite `VACUUM INTO` docs; SQLite3MultipleCiphers FAQ (shows `VACUUM INTO` with a keyed target URI, and a rekey-after-vacuum pattern); Drift encryption guide (plaintext `VACUUM INTO` then `PRAGMA rekey`).
- **Findings**: `VACUUM INTO` runs inside one read transaction, so the copy is a consistent snapshot even while another process writes in WAL mode. Whether the output inherits the source key in SQLite3MultipleCiphers is not confirmed by documentation.
- **Implications**: Write to `<out>.partial` (mode 0600), then probe: if the source is encrypted and the partial opens without a key, apply `PRAGMA rekey` with the source key; then verify (integrity check, message count, unkeyed open must fail when encrypted); rename to final path on success, delete on failure. The first backup task pins the actual library behavior with a test against an encrypted temp DB.

### Secret files
- **Context**: Brief asks to document `.env` vs docker secrets. Compose file-based secrets are mounted under `/run/secrets/<name>`; the app must read files for them to be usable.
- **Sources Consulted**: Docker Compose `secrets` top-level element; the widely used `<NAME>_FILE` convention (official postgres, mysql images).
- **Findings**: A generic "any var ending in `_FILE`" rule could collide with legitimate settings; an allowlist avoids that.
- **Implications**: `resolveSecretFiles()` with an explicit allowlist, applied once in the `khipu` router before spawning the child script so every child inherits the resolved env.

### CI
- **Context**: `.github/workflows/ci.yml`.
- **Findings**: Runs Node 20 (fails engine-strict) and triggers on `main` while the default branch is `master`, so CI never runs on pushes to the default branch.
- **Implications**: Node 24, branches `[master, main]`, add an image build plus ingress `/healthz` smoke step.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Mount ingress routes on the web UI app | One Express app, two auth schemes | One process | Mixes a loopback basic-auth browsing surface with an internet-facing surface; a routing bug exposes query APIs | Rejected: brief requires a separate surface |
| Separate ingress process and port (chosen) | `khipu ingress`, own Express app, own auth | Clean blast radius; can be the only thing behind the tunnel | One more container | Matches brief and security-hardening binding rules |
| Dynamic plugin discovery for modules | Scan a directory for route modules | No list edits | Hidden registration, harder to audit what is internet-facing | Rejected: explicit list is auditable and testable |
| Free-form module base paths | Modules choose paths | Flexible | Collisions, reserved-prefix rules, path confusion | Rejected: base path derived as `/v1/<id>` |

## Design Decisions

### Decision: Deployment profile instead of OS sniffing alone
- **Context**: Gating must differ between the Mac and the server, but a Linux developer machine is not necessarily a server.
- **Alternatives Considered**:
  1. `process.platform !== 'darwin'` means server.
  2. Explicit `KHIPU_DEPLOYMENT=local|server`, set by the image.
- **Selected Approach**: Option 2. `macos` capability is `process.platform === 'darwin'`; `local-session` capability is "deployment is not server". The Dockerfile sets `KHIPU_DEPLOYMENT=server`.
- **Rationale**: Explicit, testable, zero configuration for the operator, and does not change local behavior on the Mac.
- **Trade-offs**: One new setting; unknown values must fail fast.

### Decision: Generalize credential sources, not auth schemes
- **Context**: Downstream clients present tokens differently.
- **Selected Approach**: One token check with three credential sources (Bearer, Basic password, module header); no per-route "public" mode except the built-in `/healthz`.
- **Rationale**: Downstream modules cannot accidentally ship an unauthenticated route.

### Decision: Ingress hands modules the DB handle and a logger only
- **Context**: Modules need to write (device locations, callback acknowledgements).
- **Selected Approach**: `IngressContext = { db, log, now }`. Query surfaces are forbidden by an architecture test that scans `src/ingress/` and every file imported by `src/ingress/modules.ts`.
- **Trade-offs**: The rule is enforced by test rather than by the type system; acceptable for a single-owner codebase.

### Decision: Build vs adopt
- Adopted: Express 5 (already a dependency), `express.json` body limit, Node `crypto.timingSafeEqual`, SQLite `VACUUM INTO`, Docker `restart: unless-stopped` and `healthcheck`, compose secrets.
- Not adopted: `helmet` (two headers needed; not worth a dependency), `express-rate-limit` (32+ character random tokens make online guessing infeasible; the reverse proxy may rate limit), Passport (one scheme).

### Simplification
- No authenticated status endpoint beyond `/v1/ping`.
- No platform enable/disable override setting; capability plus configuration is sufficient.
- No backup scheduler or retention; operator uses host cron and their own off-host tool.
- No TLS in-process.

## Phase 5 Cross-Spec Amendments (2026-11-12)
Source: `.kiro/specs/phase5-cross-spec-decisions.md` (binding). Folded in: D2, D3, D4, D5, D6 (isolation allowances only), D10.

### Decision: Own the signed capability paths (D3, former notifier UC-1 and UC-2)
- **Context**: ntfy action buttons and Pushover links open a URL without an Authorization header, so the header-only ingress auth cannot serve them. The notifier design had proposed an upstream change in cloud-deployment files.
- **Selected Approach**: cloud-deployment owns `src/ingress/capability.ts` and the auth-step verification. Token and function signatures are taken verbatim from the notifier design (`<payload>.<exp>.<sig>`, per-module key `HMAC-SHA256(INGRESS_SIGNING_KEY, 'khipu-ingress-capability:v1:' + id)`, `signCapability`, `verifyCapability`, `capabilityFromLocals`). `CapabilityPathSpec` and `VerifiedCapability` are declared in `src/ingress/types.ts` and re-exported by `capability.ts`, because `IngressModule` (types layer) must reference them without importing the config-helper layer.
- **Details chosen here**: signature checked before expiry (so `capability-expired` is only logged for authentic tokens); a valid header credential always wins on a capability path (operator tools keep working) and leaves locals unset; HEAD is not treated as GET; without a key no request is authenticated by capability and one warning is logged when at least one registered module declares capability paths (with an empty or capability-free registry there is nothing to disable, so no warning noise); `readSigningKey` is shared by the ingress and minting processes so both apply the same 32-character rule; `Referrer-Policy: no-referrer` on every response; `redactCapabilityPath` for every ingress log line.
- **Trade-offs**: capability links still appear in proxy access logs and browser history; mitigated by short module-chosen lifetimes, notifier-side single use, and guide instructions to filter proxy logs. No key id or key list in v1: rotation revokes all links, acceptable for a single-user deployment.
- **Not owned here**: single use, one action per notification, and nonce-hash storage stay in the notifier (DB side).

### Decision: Full secret allowlist up front (D2)
- `SECRET_NAMES` and `SECRET_NAME_PATTERNS` include every Phase 5 secret, so slack-all-workspaces, llm-provider, notifier, and action-runner never edit `src/secret-files.ts`; their tasks only verify. Rule added for pattern names: an env key `<X>_FILE` is always the companion of `<X>`, so a pattern match never ends in `_FILE`.

### Decision: `IngressContext.env` and transitive isolation (D4, D6)
- Modules read settings from `ctx.env` (the env after secret-file resolution), which also makes them testable without mutating `process.env`.
- The isolation test follows the full transitive closure (a forbidden import two hops away is caught), skips type-only imports (erased at runtime), and allows DDL-only schema modules and `src/schema-registry.ts`, asserting they really are DDL-only. This spec defines no table, so it adds nothing to the schema registry.

### Decision: `resolveDataFile` in `src/db-path.ts` (D5)
- Placed next to `resolveDbPath` so the archive directory rule has one owner; default `join(dirname(resolveDbPath()), name)` is cwd-independent and lands in the persistent `/app/data` volume on the server. In-memory archives fall back to the default archive directory. The resolver never touches the file; owners report missing or invalid files.

### Decision: Guide documents `KHIPU_LLM_LOCAL_HOSTS` (D10)
- The guide shows an optional Ollama compose snippet and `KHIPU_LLM_LOCAL_HOSTS=ollama`; the setting's semantics and template entry belong to llm-provider. The compose file gains no default Ollama service.

## Risks & Mitigations
- Capability links leak through proxy access logs, browser history, or link previews: ingress-side redaction and no-referrer, module-chosen short lifetimes, side-effect-free GET handlers, notifier single use, and guide instructions to filter proxy logs.
- Parallel edits to `src/watch.ts` and `src/db.ts` by message-events: this spec touches only `isConfigured` (moved out), the startup loop, the DB open line, and adds `busy_timeout` in `initDb`; message-events owns `pollCycle` and `insertMessage`. Keep diffs local and rebase.
- `VACUUM INTO` key inheritance unknown: rekey fallback plus the unkeyed-open verification; a test fixes the behavior.
- Telegram first login is interactive and writes the session back to `.env`; in a container that write is lost. Mitigation: the guide instructs generating `TELEGRAM_SESSION_STRING` on the laptop first and copying it to the server.
- Slack session tokens from a datacenter IP may trigger Slack unusual-access checks: documented; detection belongs to slack-all-workspaces.
- The signal-cli container image name must be verified during implementation (candidate: the upstream `ghcr.io/asamk/signal-cli` image); it is an optional compose profile so the default stack does not depend on it.
- Each process start runs the FTS rebuild in `initDb`; with `busy_timeout` it waits instead of failing. Cost on a large DB is pre-existing and out of scope.

## References
- [onnxruntime-node on npm](https://npmjs.com/package/onnxruntime-node): prebuilt platform table, no musl.
- [transformers.js under node-alpine (HF forum)](https://discuss.huggingface.co/t/huggingface-transformers-library-wont-run-under-node-alpine/112570): Alpine failure report.
- [SQLite3MultipleCiphers FAQ](https://utelle.github.io/SQLite3MultipleCiphers/docs/faq/faq_overview): `VACUUM INTO` with keys, rekey pattern.
- [Drift encryption guide](https://drift.simonbinder.eu/platforms/encryption): `VACUUM INTO` followed by `PRAGMA rekey`.
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto): consistent snapshot semantics.
- [Telegram Bot API setWebhook](https://core.telegram.org/bots/api#setwebhook): `secret_token` header.
