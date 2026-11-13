# Implementation Plan

> Coordination note: message-events is being implemented in parallel and owns `pollCycle` in `src/watch.ts` and `insertMessage` in `src/db.ts`. Tasks here touch only the DB open line, the startup loop, and the moved `isConfigured` in `watch.ts`, and only the `busy_timeout` line in `initDb`. Keep those diffs local.

> Cross-spec note: Phase 5 decisions D2 to D6 and D10 (`.kiro/specs/phase5-cross-spec-decisions.md`) are folded into this plan. The signed capability helper and capability authentication (former notifier UC-1) and the full secret allowlist (former notifier UC-2 plus Slack and LLM secrets) are implemented here; other specs only verify them.

- [ ] 1. Foundation: shared runtime configuration helpers
- [ ] 1.1 Resolve the archive location from one setting
  - Provide the single resolver for the database file location: the operator setting when present (absolute, or relative to the working directory), otherwise the existing project-root default that does not depend on the working directory; an explicit command argument wins over both; the in-memory test path passes through
  - Refuse a location that is an existing directory with a message naming the path and asking for a file path; create a missing parent directory
  - Unit tests cover override, relative resolution, default independence from cwd, explicit precedence, directory refusal, parent creation, and in-memory passthrough, and they pass
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [ ] 1.2 Make concurrent services wait on database locks
  - Opening the archive sets a 5 second lock wait right after the encryption key is applied, with no other change to database initialization
  - A test holds a write transaction on a temporary file database from one connection, releases it within 5 seconds, and shows a second connection opening and reading without a lock error
  - _Requirements: 3.3_

- [ ] 1.3 Detect deployment profile and host capabilities
  - Read the deployment profile (local by default, server when set), rejecting unknown values with a clear error; derive host capabilities (macOS from the OS, desktop-local sessions only outside the server profile); add the platform requirement type to the adapter contract types
  - Produce startup warnings, currently only "archive stored unencrypted" for a server profile without a database key, and a logging helper that prefixes the service name; warnings contain no secret values
  - Unit tests with injected env and OS cover parsing, capability derivation for darwin/linux and local/server, and the warning condition, and they pass
  - _Requirements: 1.5, 5.1, 6.5_

- [ ] 1.4 Load allowlisted secrets from files
  - Allowlist the full Phase 5 secret set up front: `DB_KEY`, `INGRESS_TOKEN`, names matching `^INGRESS_TOKEN_[A-Z0-9_]+$`, `INGRESS_SIGNING_KEY`, `WEB_USER`, `WEB_PASS`, `MCP_SECRET`, `KHIPU_LLM_API_KEY`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING`, `DISCORD_TOKEN`, `SLACK_USER_TOKEN`, `SLACK_COOKIE`, names matching `^SLACK_(TOKEN|COOKIE)_[A-Z0-9_]+$`, names matching `^MCP_TOKEN_[A-Z0-9_]+$`, `EMAIL_IMAP_PASS`, `NTFY_TOKEN`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`, `TELEGRAM_NOTIFY_BOT_TOKEN`; export the fixed names, the patterns, and a name check so other specs can verify their names
  - For each allowlisted secret name with a companion file setting, return the file contents with one trailing newline removed as the value; an env key ending in the file suffix is always the companion of the name without it; leave non-allowlisted file settings alone; never mutate the input env
  - Return typed errors for a value-and-file conflict and for an unreadable file; formatted error messages name the setting and path but never file contents
  - Unit tests with an injected file reader cover success, newline stripping, conflict, unreadable file, non-allowlisted names, all three name patterns, and every fixed name of the allowlist resolving from a file, and they pass
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 6.7_

- [ ] 1.5 Resolve feature data file locations next to the archive
  - Add the data file resolver beside the archive resolver: the dedicated setting wins (absolute as is, relative against the working directory), otherwise the file name in the archive's directory; an in-memory archive falls back to the default archive directory; names containing a path separator are rejected; the file itself is never created or read
  - Export the recognized data files and their settings (`khipu.triage.json` / `KHIPU_TRIAGE_CONFIG`, `khipu.notify.json` / `KHIPU_NOTIFY_CONFIG`, `khipu.actions.json` / `KHIPU_ACTIONS_CONFIG`) with their owning spec; the account registry file is not included
  - Unit tests cover setting precedence (absolute and relative), the default next to an overridden archive, the default from a different working directory, the in-memory fallback, separator rejection, and that no file is created, and they pass
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_
  - _Boundary: DataFileResolver_
  - _Depends: 1.1_

- [ ] 2. Platform capability gating
- [ ] 2.1 (P) Classify platforms by host requirement and decide whether each may run
  - Define the requirement of every platform (iMessage needs macOS; WhatsApp, Zalo, Facebook Messenger need a desktop-local session; Telegram, Discord, Slack, Email need only network; Signal depends on the selected backend: signal-cli is network, Beeper is desktop-local session); the table is exhaustive over the platform union at compile time
  - Copy the existing "is configured" logic into the new gate module with unchanged behavior: only iMessage, WhatsApp, and Zalo are configured by default (and only after their requirement passes); Facebook Messenger and Beeper-backed Signal keep the Beeper-token-or-registry check; Signal with the signal-cli backend stays configured without a Beeper token
  - This task creates only the gate module and its tests; it does not edit the sync daemon module
  - Provide the gate decision (run, unsupported with requirement and profile, not configured) and the one-line skip description
  - Unit tests prove that on a local macOS host the set of runnable platforms equals today's behavior, and that on a server Linux host only network platforms (and signal-cli Signal) run
  - _Requirements: 5.1, 5.3, 5.4, 5.5_
  - _Boundary: PlatformCapabilityGate_
  - _Depends: 1.3_

- [ ] 2.2 Gate the sync daemon startup
  - The daemon checks each platform's requirement before its configuration, logs exactly one skip line per unsupported or unconfigured platform at startup, and logs startup warnings for its service
  - Delete the hardcoded local-only set, the required-env table, and the old "is configured" function from the daemon module, and re-export the gate module's version so existing callers and tests keep importing it; leave the poll cycle untouched
  - Update the daemon tests that expected local-only platforms to always run so they inject host capabilities; tests showing server-profile skips and unchanged local behavior pass
  - _Requirements: 5.2, 5.3, 6.5_

- [ ] 2.3 Skip unsupported platforms in the serial all-platform sync
  - The serial orchestrator consults the gate before spawning a platform, logs the skip reason, and does not count the skip as a failure
  - A test with an injected server Linux host shows unsupported platforms are not spawned and the run reports no failure
  - Can run in parallel with 2.2 once 2.1 is done (different files)
  - _Requirements: 5.7_

- [ ] 3. Authenticated ingress server
- [ ] 3.1 (P) Define the ingress contracts and load ingress configuration
  - Publish the downstream module contract (module id, optional token header, optional body limit, optional capability path declaration, mount function), the module context (archive handle, module-prefixed logger, clock, resolved environment), the capability path declaration and verified capability types, the logger, the token set and module auth info (with optional capability paths), the locals key for the verified capability, and the ingress configuration types (with a nullable signing key) in the ingress types file, as specified in the design
  - Load host (loopback default), port (3334 default), trust-proxy flag, master token, and per-module tokens for registered module ids; reject a missing token, any token shorter than 32 characters, and an invalid port with typed errors naming the setting (the signing key is wired in by 3.2a)
  - Unit tests cover defaults, each error, and that per-module tokens are read only for registered ids, and they pass
  - _Requirements: 7.2, 7.3, 8.5, 9.5, 9.8, 15.1_
  - _Boundary: IngressConfig_

- [ ] 3.2a Add the signed capability helper
  - Create `src/ingress/capability.ts` in the config-helper layer using only `node:crypto` and ingress types: sign and verify `<payload>.<exp>.<sig>` tokens with the per-module key derived from the signing key and the `khipu-ingress-capability:v1:<module id>` label, payload and expiry format checks, signature check before expiry check, constant-time comparison of decoded signature bytes, and the reasons malformed, invalid, and expired
  - Provide the reader for the verified capability from response locals, the signing key reader with the 32-character minimum, and the path redactor that replaces the capability segment with `<capability>`; re-export the capability path declaration and verified capability types so imports from this file match the notifier design
  - Wire the signing key reader into the ingress configuration loader: unset or empty gives a null signing key, a set key shorter than 32 characters gives the too-short error naming `INGRESS_SIGNING_KEY`; extend the configuration tests for both cases
  - `tests/ingress-capability.test.ts` shows a signed token verifies for its module and fails for another module, a tampered payload, expiry, or signature, a wrong key, an expiry equal to or before now, and malformed tokens, each with the documented reason; signing refuses a bad payload or non-integer expiry; a fixed key-derivation vector matches; the locals reader returns null for absent or malformed values; redaction works; and they pass
  - _Requirements: 15.4, 15.7, 15.8, 15.10, 15.11_
  - _Boundary: CapabilityTokens, IngressConfig_
  - _Depends: 3.1_

- [ ] 3.2 Authenticate ingress requests by token
  - Extract a credential from a bearer Authorization header, from the password of Basic credentials regardless of username, or from the module's declared header on that module's paths only; never accept query-string tokens
  - Accept the master token everywhere and a module token only under that module's base path; compare via fixed-length digests in constant time without early exit across candidates
  - Reject with 401, a bearer challenge header, and a generic body; log method, path without query, client address, and reason category without any credential
  - The middleware takes the signing key and a clock; on a declared capability path with an allowed method, a valid header credential still authenticates (verified capability left unset); otherwise, with a signing key, verify the path segment for the target module before any body parsing, store the verified capability in response locals on success, and reject with the generic 401 and reason `capability-invalid` or `capability-expired`; without a signing key, never authenticate by capability; capabilities in the query string are ignored; every logged path redacts the capability segment
  - Unit tests cover every credential source, scope rules, query-token rejection, malformed Basic input, and absence of tokens in captured logs, plus capability cases (valid, header on a capability path, tampered, expired, other module, disallowed method including HEAD, no signing key, capability in the query string, redacted log path), and they pass
  - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 6.6, 15.2, 15.3, 15.5, 15.6, 15.9, 15.10_
  - _Depends: 3.2a_

- [ ] 3.3 Assemble the ingress application
  - Validate registered modules before building (id format, unique ids, reserved ping id, header name rules, body limit bounds, capability path prefix pattern and methods limited to a non-empty duplicate-free subset of GET and POST) and fail naming the offending module
  - Apply no-store, nosniff, and no-referrer headers to every response, serve unauthenticated health (200 when the archive answers a trivial query, 503 otherwise), run authentication (with the configured signing key and the shared clock) before all other routing, serve authenticated ping, mount each module under its versioned base path with JSON and form body parsing limited to its declared size (64 KiB default), give each module a context carrying the injected environment, redact capability segments in error logs, and return fixed JSON envelopes for 400, 401, 404, 413, and 500
  - Integration tests with an in-memory archive and fake modules show: health works without auth and fails with a closed archive; ping needs a token; unknown paths give 401 unauthenticated and 404 authenticated; oversized bodies give 413 before the handler; a throwing handler gives a detail-free 500 and the next request still succeeds; an empty registration list serves only health and ping; invalid capability declarations are refused; a capability-path handler reads the verified capability; an oversized body with a bad capability gives 401 rather than 413; the module context exposes the injected environment; the no-referrer header is present; captured logs contain no token or capability
  - _Requirements: 7.4, 7.5, 8.1, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 10.1, 15.1, 15.6, 15.12_
  - _Depends: 3.2_

- [ ] 3.4 Run the ingress as its own process
  - Add the single, empty module registration list
  - The ingress entrypoint loads env and secret files, validates modules and configuration, opens the archive through the shared resolver, logs startup warnings (including exactly one "signed links disabled" warning when no signing key is set and a registered module declares capability paths), passes the resolved environment to the app, listens on the configured address, and logs the listen address plus each mounted module and base path (or that none are registered)
  - On a stop signal it stops accepting connections, closes remaining ones after 10 seconds, closes the archive, and exits 0; configuration errors and a busy port exit 1 with a secret-free message
  - A test starts the entrypoint on an ephemeral port with a temp archive, reaches health, sends a stop signal, and observes exit status 0; a test without a token observes exit status 1; a test with a capability-declaring fake module and no signing key observes the single warning line
  - _Requirements: 7.1, 7.6, 7.7, 9.6, 6.5, 15.7_
  - _Depends: 1.1, 1.3, 1.4_

- [ ] 3.5 Enforce ingress isolation from query surfaces
  - A static test builds the transitive import closure (relative static imports, re-exports, and string-literal dynamic imports; type-only imports skipped) starting from every ingress source file and the module registration list, and fails on any MCP server, remote MCP endpoint (`src/remote-mcp/**`), tool registry, shared query handlers, web UI, ask, or CLI module anywhere in the closure
  - It permits DDL-only schema modules (`src/<area>/schema.ts`, `src/<name>-schema.ts`) and `src/schema-registry.ts` in the closure, and fails if a schema module imports anything other than types or SQLite driver types, or the registry imports anything other than schema modules
  - It fails if a file in the closure, other than the ingress entrypoint and the shared config helpers that take an injected env, reads the global process environment, so modules use the context environment
  - The same test asserts the ingress closure contains neither the MCP server nor any file under `src/remote-mcp/**`
  - The test passes on the current tree and fails when a forbidden import is temporarily added two hops away from an ingress file
  - _Requirements: 9.8, 10.1, 10.2, 10.3, 10.4_

- [ ] 4. (P) Bind the web UI safely for server use
  - Resolve web host and port from settings with the current loopback 3333 default; refuse a non-loopback host unless both basic-auth credentials are set, with a message saying they are required
  - The web entrypoint uses this resolution and logs startup warnings, without changing the existing server start function or routes
  - Unit tests cover defaults, loopback detection, refusal, and acceptance with credentials, and they pass
  - _Requirements: 11.1, 11.2_
  - _Boundary: WebBind_
  - _Depends: 1.3_

- [ ] 5. (P) Verified online backup command
  - Write a consistent snapshot of the archive to a new timestamped file in a backups directory next to it, or to an explicit output path that must not already exist, through a temporary partial file readable only by the owner, opening the source read-only without schema setup or index rebuild
  - When the source is encrypted and the partial opens without a key, re-encrypt it with the source key; then verify integrity, that messages can be counted, and, when encrypted, that it cannot be opened without the key; rename on success and delete on any failure
  - The backup entrypoint loads env and secret files, parses the optional output path argument, resolves the archive through the shared resolver (directory error exits 1), creates the backups directory, prints path, size, and verified message count and exits 0 on success, and exits 1 with the failure reason otherwise; a test runs the entrypoint and checks both exit statuses
  - Tests with temp files cover a plain archive, an encrypted archive (opens with key, fails without), refusal to overwrite, deletion after a forced verification failure, an unchanged source, and a snapshot taken while a second connection writes; they pass and record the observed encryption behavior of the snapshot
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 3.3_
  - _Boundary: BackupCommand_
  - _Depends: 1.1, 1.2, 1.4_

- [ ] 6. Integration: entrypoints and command routing
- [ ] 6.1 Open the archive through the shared resolver everywhere
  - Replace every hardcoded archive location in the sync daemon, web UI, MCP server, CLI, ask, list, sync status, index rebuild (default branch only, explicit option keeps precedence), and the nine platform sync scripts with the shared resolver; top-level entrypoints print the directory error and exit 1
  - Modules that open the archive at import time (the sync daemon and the platform sync scripts) wrap that open so a directory path prints the resolver error and exits 1 instead of throwing an unhandled error; a test spawns at least one such module with the setting pointing at a directory and observes exit status 1
  - A repository search finds no remaining hardcoded archive filename outside the resolver and tests; the full test suite passes
  - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - _Depends: 2.2, 4_

- [ ] 6.2 Route the new commands, secret files, and one-shot gating through the khipu command
  - The command router resolves secret files once and passes the resolved env (with companion file settings removed) to the spawned script, exiting 1 with the formatted error on conflict or unreadable file
  - Add the ingress and backup subcommands with help lines
  - One-shot platform sync and platform-at-account sync return an error naming the platform and unmet requirement when the injected gate reports unsupported, without spawning the platform script
  - Router tests cover the new subcommands, the unsupported refusal, and secret-file failure exit status, and they pass
  - _Requirements: 5.6, 6.2, 6.3, 6.4, 7.1, 12.1_
  - _Depends: 1.4, 2.1, 3.4, 5_

- [ ] 7. Container, compose, and CI
- [ ] 7.1 Rebuild the container image on Node 24
  - Two-stage image on the Node 24 Debian slim base with a native build toolchain only in the builder, engine-strict install, browser download skipped, the khipu command linked, a non-root runtime user owning the data and cache directories, and server-profile defaults for deployment profile, archive location, media directory, model cache, and web and ingress listen hosts
  - Exclude local session files, backups, and database companion files from the build context
  - Building the image locally succeeds for the host architecture (arm64 is covered by the CI cross-build in 7.4), and inside it the SQLite driver, vector extension, and embedding runtime load, and the running user is not root
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 7.2 Define the unattended compose stack
  - Sync service runs the daemon directly with automatic restart and a stop grace period of 45 s, longer than the daemon's 15 s sync-cycle wait plus its 25 s total service shutdown deadline (40 s); web and ingress services publish only on host loopback; ingress has a health check against its health endpoint; all share one data volume mounted as a directory plus a separate model cache volume; no service needs a terminal
  - Optional signal-cli profile shares its socket with the sync service through a volume; a commented secrets example uses companion file settings
  - Optional `remote-mcp` profile service `mcp-http` runs `khipu mcp --http` with `MCP_HTTP_HOST=0.0.0.0` inside the container, publishes `127.0.0.1:3335:3335` only on host loopback, and is health-checked against `/healthz`; it never shares a port or process with the ingress
  - Verification needs a local env file with an ingress token of at least 32 characters (and web basic-auth credentials, since the web service binds beyond loopback inside the container)
  - `docker compose config` validates, and `docker compose up -d` brings sync, web, and ingress up with ingress reported healthy
  - _Requirements: 3.1, 3.2, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 7.8, 11.3_
  - _Depends: 3.4, 6.2, 7.1_

- [ ] 7.3 Complete the environment template and guard it with a configuration test
  - Add every setting used by the compose stack, the ingress configuration (including `INGRESS_SIGNING_KEY`, optional, at least 32 characters), the archive location, the deployment profile, web binding, signal-cli, and the remote MCP endpoint (`MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_ALLOWED_ORIGINS`) to the environment template, each with a one-line description and a note on companion file settings; list every fixed secret name of the allowlist without values and describe the three name patterns (`INGRESS_TOKEN_*`, `SLACK_(TOKEN|COOKIE)_*`, `MCP_TOKEN_*`)
  - A configuration test fails if any such setting or any fixed allowlisted secret name is missing from the template, if the data volume is mounted at a database file path, if any published port is not loopback-only, if the sync command contains a shell loop, or if the image base is not Node 24; it passes on the updated files
  - _Requirements: 13.7, 13.8, 13.11, 1.1, 3.1, 4.1, 4.5, 6.7, 7.8, 11.3_
  - _Depends: 1.4, 3.1, 7.1, 7.2_

- [ ] 7.4 Align CI with Node 24 and smoke-test the image
  - The test job runs on Node 24 and the workflow triggers on pushes and pull requests to the default branch
  - A new job builds the image, cross-builds it for linux/arm64 without pushing, proves the native modules load inside it, starts the ingress from the image with a test token, and fails unless health returns 200 within 30 seconds
  - The workflow file passes a local syntax check and the same build plus smoke commands succeed when run locally
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 1.2, 1.3_
  - _Depends: 6.2, 7.1_

- [ ] 7.5 Write the deployment guide and update the README
  - The guide covers prerequisites, first start, which platforms run on the server versus the Mac, putting the ingress behind Caddy, Cloudflare Tunnel, or Tailscale and verifying with ping, reaching the web UI through an SSH tunnel, env file versus secret files and token generation, database key handling and its pitfalls, backups and restore with off-host shipping, establishing Telegram sessions on the laptop first, Signal via the signal-cli profile, the Slack datacenter IP caveat, why the sync service stop grace period (45 s) must exceed the 15 s sync-cycle wait plus the 25 s service shutdown deadline (40 s), migrating from the old volume layout, and upgrading
  - Secrets section: generate `INGRESS_TOKEN` and, separately, `INGRESS_SIGNING_KEY` with `openssl rand -hex 32`; table of every allowlisted secret name and both name patterns
  - Signed links section: what capability links are, that they act as credentials until they expire, that they appear in reverse proxy or tunnel access logs and browser history, how to filter or disable proxy access logging for capability paths (Caddy snippet), and that rotating the signing key revokes every outstanding link
  - Data files section: the default location of each recognized data file next to the archive in the data volume, the overriding setting, and the owning spec
  - Local LLM section: an optional Ollama compose service snippet and setting `KHIPU_LLM_LOCAL_HOSTS` to its service hostname so local-only routing works without allowing cloud providers (semantics owned by llm-provider)
  - The README Docker section states Node 24, uses the new volume layout for the MCP container command, and links the guide
  - Every guide section listed above exists, and every setting it names that this spec owns is present in the environment template; settings owned by other specs (`KHIPU_LLM_LOCAL_HOSTS`, the data file settings) are named with their owning spec
  - Included despite the code-only default because requirement 13 makes the guide a deliverable of this spec
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9, 13.10, 13.11, 13.12, 16.6_
  - _Depends: 1.5, 7.3_

- [ ] 8. Validation
- [ ] 8.1 Regression and parity check on the Mac
  - Run the full test suite under Node 24 and the MCP stdio smoke test; confirm the local daemon on macOS starts the same platforms as before this spec and opens the same archive as the MCP server from a different working directory
  - All tests pass, the MCP smoke test lists all tools, and the daemon startup log shows no new skips on the Mac
  - _Requirements: 2.2, 5.3, 10.3_

- [ ] 8.2 End-to-end server-profile check with compose
  - On a Linux container host (or Docker Desktop), start the stack, confirm macOS and desktop-session platforms are logged as skipped once, ping the ingress through loopback with and without the token, take a backup while sync runs, stop the sync service and check its exit status, kill the daemon process inside the running sync container and observe the automatic restart, recreate the services after an image rebuild, and confirm the message count is unchanged
  - Ping returns 401 without a token and 200 with it, the backup verifies, the stopped sync service reports exit status 0, the killed daemon is restarted, and the message count matches before and after recreation
  - _Requirements: 3.2, 4.2, 4.3, 4.4, 5.2, 7.5, 8.1, 12.1_
