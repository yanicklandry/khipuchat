# Requirements Document

## Project Description (Input)
The user wants khipuchat always running so important messages (for example a new transaction in Slack `#08-expedition`) are seen within minutes, even when the laptop is closed. Today khipuchat runs on the Mac, and the shipped container setup does not actually work unattended: the image uses a Node version the native SQLite module refuses, the database volume is mounted at the database file path (turning it into a directory), entrypoints disagree on where the database lives, the sync service wraps an endless daemon in a loop that never iterates, macOS-only sources are hardcoded as "configured" and fail every cycle on Linux, and no authenticated HTTP ingress exists for later features (location reports, notification callbacks). The desired outcome: `docker compose up -d` on a Linux server the user controls runs the watch daemon and web UI unattended with a persistent (optionally encrypted) database, only syncs platforms that can work on that host, and exposes one authenticated ingress, meant to sit behind a TLS-terminating reverse proxy or tunnel, that later specs (presence-context, notifier) mount routes on. Secrets handling, database key handling, backups, and server setup are documented. khipuchat replaces Beeper: no Beeper dependency is introduced.

## Introduction
This feature makes khipuchat deployable as an always-on service on a Linux server owned by the user. It fixes the container runtime, unifies where every entrypoint finds the database, gates platform sync by what the host can actually run, adds a separate authenticated ingress surface with a stable route-registration contract for downstream specs, and gives the operator documented, verifiable procedures for secrets, encryption keys, and backups.

## Boundary Context
- **In scope**: container image and compose service definitions; a single operator-facing database location setting honored by every entrypoint; persistent data layout; per-platform host capability gating for the sync daemon and one-shot syncs; file-based secret loading; an authenticated ingress server with a health endpoint, a token check endpoint, a route-registration contract, and signed capability paths for links that cannot carry a header; a single resolver for feature data file locations next to the archive; web UI binding rules for server use; an online database backup command; a deployment guide and environment template; CI alignment with the pinned runtime and the container build.
- **Out of scope**: provisioning or infrastructure-as-code for any cloud vendor; running macOS-only or desktop-session sources (iMessage, WhatsApp, Zalo, Beeper-backed Signal or Facebook) on the server; multi-user tenancy; Kubernetes; TLS certificate management inside khipuchat (TLS terminates at the operator's reverse proxy or tunnel); location routes (presence-context); notification callback routes and their single-use, one-action-per-notification, and nonce-hash storage rules (notifier); the contents and parsing of feature configuration files (triage-agent, notifier, action-runner); the meaning of `KHIPU_LLM_LOCAL_HOSTS` (llm-provider); the schema registry (message-events); Slack session-token auth and token-expiry detection (slack-all-workspaces); the new-message event stream (message-events); backup scheduling, retention, and off-host shipping.
- **Adjacent expectations**: presence-context and notifier mount their HTTP routes on the ingress through the registration contract defined here and rely on ingress authentication rather than implementing their own; the notifier mints and redeems signed capability links through the capability contract defined here. Downstream features that keep a configuration file next to the archive locate it through the data file resolver defined here. Phase 5 cross-spec decisions D2 to D6 and D10 (`.kiro/specs/phase5-cross-spec-decisions.md`) are binding for this spec. The MCP server remains stdio-only and is never reachable through the ingress. The web UI remains a separate surface protected by its existing basic-auth mechanism. Signal on the server uses the existing signal-cli backend.

## Requirements

### Requirement 1: Container runtime matches the pinned Node runtime
**Objective:** As an operator, I want the container image to run on the same Node major version the project pins, so that native modules load and every khipuchat command starts inside the container.

#### Acceptance Criteria
1. The container image shall run on Node.js major version 24, matching the project engine pin.
2. When the container image is built on a clean machine for `linux/amd64` or `linux/arm64`, the build shall complete without manual steps and produce an image in which the `khipu` command is on the PATH.
3. When any of `khipu sync all`, `khipu web`, `khipu ingress`, `khipu mcp`, or `khipu backup` is started inside the container, the command shall load the SQLite driver, the vector extension, and the embedding runtime without native-module or ABI errors.
4. The container shall run khipuchat processes as a non-root user.
5. The container image shall identify itself to khipuchat as a server deployment without operator configuration.

### Requirement 2: Single database location for every entrypoint
**Objective:** As an operator, I want one setting that decides where the database file lives, so that every khipuchat process on a host reads and writes the same archive.

#### Acceptance Criteria
1. Where the `KHIPU_DB_PATH` setting is provided, every khipuchat entrypoint that opens the archive (sync daemon, one-shot platform syncs, web UI, ingress, MCP server, CLI queries, ask, list, sync status, index rebuild, backup) shall open the database at that path.
2. Where `KHIPU_DB_PATH` is not provided, every entrypoint shall open the database at the same default location regardless of the current working directory, and that default shall be the existing project-root `khipuchat.db` so that current local installs keep working unchanged.
3. If `KHIPU_DB_PATH` resolves to an existing directory, then the entrypoint shall exit with a non-zero status and a message naming the path and stating that a file path is required.
4. When the directory that will contain the database file does not exist, the entrypoint shall create it before opening the database.
5. Where an explicit database path argument is accepted by a command (the index rebuild `--db` option), that argument shall take precedence over `KHIPU_DB_PATH`.

### Requirement 3: Persistent and shareable data
**Objective:** As an operator, I want the archive and its media to survive container restarts and image upgrades, and to be usable by several services at once, so that nothing is lost and services do not trip over each other.

#### Acceptance Criteria
1. The compose definition shall store the database file, its write-ahead-log companion files, and stored media in persistent storage mounted as a directory, so that they survive container recreation and image rebuilds.
2. When the services are stopped and started again, or the image is rebuilt and the services recreated, the archive shall contain every message present before the restart.
3. While the sync daemon is writing to the archive, the web UI, ingress, MCP server, and backup command shall be able to open and read the archive without failing on a lock that is released within 5 seconds.
4. The compose definition shall keep re-downloadable caches (embedding model files) in storage separate from the archive data, so that a backup of the archive data excludes them.

### Requirement 4: Unattended sync service
**Objective:** As an operator, I want `docker compose up -d` to keep syncing indefinitely without supervision, so that new messages reach the archive within minutes while my laptop is closed.

#### Acceptance Criteria
1. The compose sync service shall run the sync daemon (`khipu sync all`) directly as its long-running process, without an outer loop.
2. If the sync daemon process exits for any reason other than an operator stop, then the container runtime shall restart it automatically.
3. When the sync service receives a stop signal, the sync daemon shall finish or abandon in-flight poll cycles within its 15 second cycle wait, then stop its in-daemon services within their 25 second total shutdown deadline, and exit with status 0; the compose stop grace period (45 seconds) shall exceed that worst case (15 s cycle wait + 25 s services deadline = 40 s < 45s) so the container runtime does not kill it mid-drain.
4. When the compose services are started with `docker compose up -d`, the sync daemon, web UI, and ingress shall all start without requiring an attached terminal or interactive input.

### Requirement 5: Platform capability gating
**Objective:** As an operator, I want khipuchat to sync only the platforms this host can actually run, so that the daemon does not fail every cycle on sources that cannot work on a Linux server.

#### Acceptance Criteria
1. The system shall classify every supported platform by what it requires from the host: macOS, a desktop-local session, or only network access.
2. While running in a server deployment, the sync daemon shall not start platforms that require macOS or a desktop-local session, and shall log one line per skipped platform at startup stating the platform and the unmet requirement.
3. While running on a macOS host in a local deployment, the sync daemon shall start the same set of platforms it starts today, so that existing local installs keep their behavior.
4. When Signal is configured to use the signal-cli backend, the system shall treat Signal as requiring only network access and shall consider it configured without requiring a Beeper access token.
5. When Signal is configured to use the Beeper backend, or Facebook Messenger is configured, the system shall treat that platform as requiring a desktop-local session.
6. If an operator runs a one-shot sync (`khipu sync <platform>` or `khipu sync <platform>@<account>`) for a platform whose requirement the host does not meet, then the system shall exit with a non-zero status and a message naming the platform and the unmet requirement, without contacting the platform.
7. When the serial all-platform sync runs on a host that does not meet a platform's requirement, the system shall skip that platform, log the reason, and not count it as a failure.

### Requirement 6: Secrets and database key handling
**Objective:** As an operator, I want to supply credentials either through an environment file or through secret files, and to be warned when the server archive is unencrypted, so that I can choose a secrets strategy appropriate to my server.

#### Acceptance Criteria
1. The system shall accept every supported secret setting (database key, ingress tokens, ingress signing key, web basic-auth credentials, MCP secret, LLM API key, notification channel credentials, and platform credentials) as a plain environment value.
2. Where a `<NAME>_FILE` setting is provided for a supported secret `<NAME>` and `<NAME>` itself is not set, the system shall use the file's contents, with one trailing newline removed, as the value of `<NAME>` for the command and every process it starts.
3. If both `<NAME>` and `<NAME>_FILE` are set for the same secret, then the system shall exit with a non-zero status and a message naming the conflicting setting.
4. If a `<NAME>_FILE` setting points to a file that cannot be read, then the system shall exit with a non-zero status and a message naming the setting and path, without printing any secret value.
5. While running in a server deployment without a database key, the sync daemon, web UI, and ingress shall each log a warning at startup that the archive is stored unencrypted.
6. The system shall never write secret values (tokens, passwords, database keys) to logs or to HTTP responses.
7. The supported secret settings for `<NAME>_FILE` loading shall be exactly: `DB_KEY`, `INGRESS_TOKEN`, every name matching `^INGRESS_TOKEN_[A-Z0-9_]+$`, `INGRESS_SIGNING_KEY`, `WEB_USER`, `WEB_PASS`, `MCP_SECRET`, `KHIPU_LLM_API_KEY`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING`, `DISCORD_TOKEN`, `SLACK_USER_TOKEN`, `SLACK_COOKIE`, every name matching `^SLACK_(TOKEN|COOKIE)_[A-Z0-9_]+$`, `EMAIL_IMAP_PASS`, `NTFY_TOKEN`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`, and `TELEGRAM_NOTIFY_BOT_TOKEN`, so that every Phase 5 secret can be supplied as a file without further changes to this allowlist.

### Requirement 7: Ingress server lifecycle and health
**Objective:** As an operator, I want a separate HTTP ingress process that starts only when safely configured and that my reverse proxy and container runtime can health-check, so that later features have a dependable entry point.

#### Acceptance Criteria
1. The system shall provide an ingress server, started by `khipu ingress`, that listens on its own port, separate from the web UI port.
2. Where no ingress host or port is configured, the ingress server shall listen on loopback (`127.0.0.1`) port 3334.
3. If the master ingress token is missing or shorter than 32 characters, then the ingress server shall refuse to start, exit with a non-zero status, and state which setting is invalid.
4. When a client sends `GET /healthz`, the ingress server shall respond without requiring authentication, with status 200 and a body stating only that it is healthy when the archive can be queried, or status 503 and a body stating only that it is unavailable otherwise.
5. When an authenticated client sends `GET /v1/ping`, the ingress server shall respond with status 200, so that an operator can verify token and proxy setup end to end.
6. When the ingress server starts, it shall log its listen address and the list of mounted route modules with their base paths.
7. When the ingress server receives a stop signal, it shall stop accepting new connections, let in-flight requests finish for up to 10 seconds, and exit with status 0.
8. The compose definition shall publish the ingress port only on the host's loopback interface, and shall health-check the ingress service through `/healthz`.

### Requirement 8: Ingress authentication
**Objective:** As an operator, I want every ingress route except health to require a secret token, presented in the ways my devices and services can send it, so that only my clients can reach khipuchat over the internet.

#### Acceptance Criteria
1. The ingress server shall require a valid token on every request except `GET /healthz`, including requests to paths that match no route.
2. When a request carries a valid token as a bearer token in the Authorization header, the ingress server shall treat it as authenticated.
3. When a request carries a valid token as the password of HTTP Basic credentials in the Authorization header, the ingress server shall treat it as authenticated, regardless of the username, so that clients limited to Basic auth can connect.
4. Where a route module declares a dedicated token header, when a request to that module carries a valid token in that header, the ingress server shall treat it as authenticated.
5. Where a module-specific token is configured for a route module, the ingress server shall accept either that module token or the master token on that module's routes, and shall accept only the master token on all other routes.
6. If a request carries no token, an invalid token, or a token only in the URL query string, and it is not authenticated by a valid signed capability under Requirement 15, then the ingress server shall respond with status 401 and a body that does not reveal which check failed, and shall not invoke any route handler.
7. When the ingress server rejects a request for authentication, it shall log the method, path without query string, client address, and a reason category, without logging any presented credential.
8. The ingress server shall compare presented tokens against configured tokens in a way whose duration does not depend on how many leading characters match.

### Requirement 9: Ingress route registration contract
**Objective:** As a developer of a downstream spec (presence-context, notifier), I want a stable way to mount routes on the ingress, so that my feature gets authentication, request limits, and logging without reimplementing them.

#### Acceptance Criteria
1. The ingress server shall mount every route module from a single explicit registration list, under the base path `/v1/<module id>`.
2. If two registered modules share an id, or a module id is not a lowercase identifier of 2 to 32 characters, or a module declares an invalid token header name, a request body limit above 1 MiB, or an invalid capability path declaration (Requirement 15.1), then the ingress server shall refuse to start and name the offending module.
3. The ingress server shall reject request bodies larger than the module's declared limit, or 64 KiB when the module declares none, with status 413, before the module handler runs.
4. When a route module's handler fails with an unexpected error, the ingress server shall respond with status 500 and a body that contains no error details, log the error with the module id, and keep serving other requests.
5. The ingress server shall give each mounted module access to the archive, to a logger that prefixes entries with the module id, and to the process environment after secret-file resolution.
6. While the registration list is empty, the ingress server shall start and serve only `/healthz` and `/v1/ping`.
7. The ingress server shall respond to every request with headers that disable response caching and content-type sniffing.
8. Route modules shall read settings from the environment provided in their module context rather than from the global process environment, so that tests can inject settings and secret-file values reach modules consistently.

### Requirement 10: Ingress isolation from query surfaces
**Objective:** As the owner of the archive, I want the internet-facing ingress to be unable to run archive queries or MCP tools, so that exposing it does not expose my messages.

#### Acceptance Criteria
1. The ingress server shall not expose the MCP server, MCP tools, or any message, chat, or search query endpoint.
2. The project test suite shall fail if the ingress server or any registered route module depends, directly or through any chain of imports, on the MCP server, the tool registry, the shared query handlers, or the web UI routes.
3. The MCP server shall remain reachable only over stdio.
4. The isolation check shall permit DDL-only schema modules (`src/<area>/schema.ts` or `src/<name>-schema.ts`) and the schema registry (`src/schema-registry.ts`) in the import chain, and shall fail if such a schema module imports anything other than types or the SQLite driver types.

### Requirement 11: Web UI on a server
**Objective:** As an operator, I want the web UI to be reachable from the container's published port but never openly exposed, so that I can browse the archive through an SSH tunnel or private network without leaking it.

#### Acceptance Criteria
1. Where web UI host and port settings are provided, the web UI shall listen on that host and port; otherwise it shall keep listening on `127.0.0.1:3333`.
2. If the web UI is configured to listen on a non-loopback address and web basic-auth credentials are not both set, then the web UI shall refuse to start, exit with a non-zero status, and state that basic-auth credentials are required.
3. The compose definition shall publish the web UI port only on the host's loopback interface.

### Requirement 12: Online database backup
**Objective:** As an operator, I want to take a consistent copy of the archive while the sync daemon keeps running, and to know the copy is usable, so that I can back up the server without downtime.

#### Acceptance Criteria
1. When the operator runs `khipu backup`, the system shall write a consistent snapshot of the archive to a new timestamped file in a `backups` directory next to the database, or to the path given with `--out`, while other services keep running.
2. When the backup file has been written, the system shall open it with the same database key as the source and verify that it passes an integrity check and that its messages can be counted.
3. Where the source archive is encrypted, the system shall verify that the backup file cannot be opened without the database key, so that a backup is never left unencrypted.
4. If the snapshot or its verification fails, then the system shall delete the backup file, exit with a non-zero status, and state the failure reason.
5. If the `--out` path already exists, then the system shall refuse to overwrite it and exit with a non-zero status.
6. When the backup succeeds, the system shall print the backup file path, its size, and the verified message count, and exit with status 0.

### Requirement 13: Deployment guidance
**Objective:** As an operator, I want a written guide and a complete environment template, so that I can set up, secure, and maintain a server deployment without reading the source code.

#### Acceptance Criteria
1. The project shall provide a deployment guide covering: server prerequisites, first start with `docker compose up -d`, which platforms run on a server and which stay on the Mac, putting the ingress behind a TLS-terminating reverse proxy or tunnel (Caddy, Cloudflare Tunnel, or Tailscale), and reaching the web UI over an SSH tunnel or private network.
2. The deployment guide shall explain choosing between an environment file and secret files, and how to generate an ingress token of sufficient length.
3. The deployment guide shall explain database key handling: setting the key before first start, that the key cannot be added to an existing unencrypted archive by setting it later, that losing the key makes the archive and its backups unreadable, and that storing the key next to the data weakens at-rest protection.
4. The deployment guide shall explain running and restoring backups, including that backups must be shipped off the server to be useful.
5. The deployment guide shall explain how to establish sessions for platforms that need an interactive first login (for example Telegram) before running unattended, and how to run Signal through the signal-cli backend on the server.
6. The deployment guide shall state that using Slack session tokens from a datacenter IP address may trigger Slack unusual-access checks, and that detection and re-authentication belong to the Slack integration.
7. The environment template shall list every setting the compose definition, the ingress, and the database location rely on, each with a one-line description.
8. The project test suite shall fail if a setting referenced by the compose definition or read by the ingress configuration is missing from the environment template.
9. The deployment guide shall explain running a local Ollama model server as an additional compose service and setting `KHIPU_LLM_LOCAL_HOSTS` to that service's hostname, so that local-only LLM routing works on the server without allowing cloud providers.
10. The deployment guide shall explain generating the ingress signing key (for example with `openssl rand -hex 32`), that signed links act as credentials until they expire, that they can appear in reverse proxy or tunnel access logs and browser history, and how to limit or filter those logs.
11. The deployment guide and the environment template shall list every secret setting from Requirement 6.7, without values.
12. The deployment guide shall state where feature data files (Requirement 16) live in the server layout and which setting overrides each.

### Requirement 14: CI alignment
**Objective:** As a maintainer, I want CI to test on the pinned runtime and to build the container image, so that runtime or image regressions are caught before deployment.

#### Acceptance Criteria
1. The CI test job shall run on Node.js major version 24.
2. The CI workflow shall run on pushes and pull requests to the repository's default branch.
3. The CI workflow shall build the container image and fail if the build fails.
4. When the CI workflow builds the container image, it shall start `khipu ingress` from that image with a test token and fail unless `/healthz` responds with status 200.

### Requirement 15: Signed capability paths
**Objective:** As a developer of a downstream spec (notifier), I want links that a phone app or browser can open without an authorization header to be authenticated by a short-lived signed credential in the path, so that notification buttons work while every other ingress route keeps header-token authentication.

#### Acceptance Criteria
1. Where a route module declares capability paths, the declaration shall consist of a path prefix matching `^/[a-z][a-z0-9-]{0,15}$` and a non-empty set of allowed methods drawn only from GET and POST.
2. When a request with an allowed method targets `/v1/<module id><prefix>/<capability>` or a deeper path below it on a module that declares capability paths, and the request carries no valid header credential under Requirement 8, the ingress server shall authenticate it by verifying the `<capability>` path segment.
3. When a request to a capability path carries a valid header credential under Requirement 8, the ingress server shall treat it as authenticated as it does on any other route of that module, without requiring a capability.
4. The capability shall have the form `<payload>.<exp>.<sig>`, where `<payload>` matches `^[A-Za-z0-9_-]{16,64}$`, `<exp>` is the expiry in unix seconds written in decimal, and `<sig>` is the base64url HMAC-SHA256 over `<payload>.<exp>` under a module key equal to HMAC-SHA256 keyed by `INGRESS_SIGNING_KEY` over `khipu-ingress-capability:v1:<module id>`, so that a capability signed for one module is invalid on every other module.
5. If the capability is malformed, its signature does not verify for the target module, or its expiry is not later than the current time, then the ingress server shall respond with the same 401 status and body as Requirement 8.6, shall not invoke any route handler or body parser, and shall log the reason category `capability-invalid` (malformed or bad signature) or `capability-expired` (authentic but expired).
6. The ingress server shall verify capabilities before routing and before parsing any request body, and on success shall make the verified module id, payload, and expiry available to the module handler for that request.
7. Where `INGRESS_SIGNING_KEY` is not set, the ingress server shall authenticate no request by capability, and when at least one registered module declares capability paths it shall log exactly one startup warning stating that signed links are disabled.
8. If `INGRESS_SIGNING_KEY` is set and shorter than 32 characters, then the ingress server shall refuse to start, exit with a non-zero status, and name the setting.
9. The ingress server shall accept a capability only as a path segment of a declared capability path, and shall keep ignoring tokens and capabilities in the URL query string.
10. The ingress server shall replace the capability segment with `<capability>` in every log line it writes for a capability path, and shall compare signatures in a way whose duration does not depend on how many leading bytes match.
11. The system shall provide a signing function, usable outside the ingress process, that produces capabilities accepted by the ingress for a given module, payload, and expiry, and that refuses a payload outside the allowed pattern or a non-integer expiry.
12. The ingress server shall send a header on every response that prevents browsers from sending the request URL as a referrer, so that capability links do not leak to third parties.

### Requirement 16: Data file locations
**Objective:** As a developer of a downstream spec (triage-agent, notifier, action-runner), I want one rule for where feature data files live, so that every process finds the same file regardless of the working directory and the files persist with the archive on a server.

#### Acceptance Criteria
1. The system shall provide one resolver that, given a data file name and its dedicated setting name, returns the setting's value when that setting is provided, and otherwise the file name in the directory that contains the archive file resolved under Requirement 2.
2. The resolver's result shall not depend on the current working directory when the dedicated setting is not provided, and a relative setting value shall resolve against the current working directory in the same way as `KHIPU_DB_PATH`.
3. Where the archive is in memory (tests), the resolver shall fall back to the directory of the default archive location.
4. The resolver shall neither create nor read the data file; reporting a missing or invalid file belongs to the feature that owns it.
5. The resolver shall reject a data file name that contains a path separator.
6. The recognized data files and settings shall be `khipu.triage.json` with `KHIPU_TRIAGE_CONFIG`, `khipu.notify.json` with `KHIPU_NOTIFY_CONFIG`, and `khipu.actions.json` with `KHIPU_ACTIONS_CONFIG`; the account registry `khipu.config.json` keeps its existing location rules.
