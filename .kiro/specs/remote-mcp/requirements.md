# Requirements Document

## Project Description (Input)
Add a Streamable HTTP transport to the khipuchat MCP server (`khipu mcp --http`) so cloud AI clients (for example Muse.ai, which runs in the cloud with no access to the local machine) can reach it over Tailscale Funnel or Cloudflare Tunnel. Use real `Authorization: Bearer` header auth (the current `MCP_SECRET` check reads `params._meta.authorization`, which HTTP clients never send), with revocable per-client tokens and an optional read-only tool subset per client. The stdio transport stays unchanged for local clients. This reverses the cloud-deployment decision that the MCP server is stdio-only and never reachable through the ingress, so the cloud-deployment spec and the phase 5 cross-spec decisions must be updated to match. Document exposing the endpoint via Tailscale Funnel (and Cloudflare Tunnel). khipuchat replaces Beeper: no Beeper dependency.

## Introduction
Cloud-hosted AI clients cannot start a local process, so today they cannot query the khipuchat archive at all. This feature adds a remote MCP endpoint: a separate, opt-in process that serves the same MCP tools over HTTP to named clients, each holding its own secret token and optionally limited to a subset of tools. The endpoint listens on loopback and is meant to be published through a TLS-terminating tunnel (Tailscale Funnel or Cloudflare Tunnel) that the operator controls. Local stdio use is unchanged.

Decisions taken with the user (2026-11-13): the endpoint runs as its own process and port, not as an ingress module; tokens are configured per client through settings or secret files and revoked by removing the setting and restarting; a client without an allowlist may use every tool; each tool call is logged with client, tool, outcome and duration only.

## Boundary Context
- **In scope**: an HTTP mode of the MCP server started explicitly by the operator; per-client bearer tokens; per-client tool allowlists; listen address defaults and startup validation; unauthenticated health check; request size and origin checks; per-call audit logging without arguments or results; graceful stop; documentation for publishing the endpoint through Tailscale Funnel and Cloudflare Tunnel and for connecting a cloud client; updates to the cloud-deployment spec, the phase 5 cross-spec decisions, and steering so they no longer state that MCP is stdio-only.
- **Out of scope**: OAuth or any interactive authorization flow; token management commands or tokens stored in the archive; revocation without restart; rate limiting; TLS termination inside khipuchat; mounting MCP on the ingress server; new MCP tools or write/action tools; changing stdio MCP behavior, including its existing `MCP_SECRET` check; multi-user tenancy (all clients belong to the one archive owner); a web UI for clients or tokens.
- **Adjacent expectations**: the remote endpoint serves exactly the tool set the stdio server serves (one tool list), so tools added later by other specs (for example presence-context's `get_presence`) appear remotely too, subject to allowlists. The ingress server (cloud-deployment) keeps its isolation from the archive and MCP; only the "MCP is reachable only over stdio" rule changes. Where cloud-deployment's single database location setting exists, the remote endpoint honors it like every other entrypoint. Secret-file loading for the new token settings is provided by cloud-deployment's secret allowlist, extended by this feature's spec updates. The operator owns the tunnel, its public hostname, and its TLS.

## Requirements

### Requirement 1: Opt-in remote MCP endpoint
**Objective:** As the archive owner, I want to start a remote MCP endpoint only when I ask for it, so that my archive is never reachable over the network by accident.

#### Acceptance Criteria
1. The khipuchat CLI shall provide a remote mode of the MCP server, started by `khipu mcp --http`, that serves MCP over HTTP at the path `/mcp`.
2. When `khipu mcp` is started without `--http`, the MCP server shall serve over stdio only and behave exactly as before this feature, including its existing `MCP_SECRET` check.
3. The remote MCP endpoint shall run as its own process with its own port, separate from the web UI and the ingress server.
4. Where no remote MCP host or port is configured, the remote MCP endpoint shall listen on loopback (`127.0.0.1`) port 3335.
5. If the configured remote MCP port is already in use, then the remote MCP endpoint shall exit with a non-zero status and a message naming the address.
6. When the remote MCP endpoint starts, it shall log its listen address, the names of the configured clients, and the number of tools each client may use, without logging any token.
7. Where the remote MCP endpoint is configured to listen on an address other than loopback, it shall log a warning at startup that the endpoint is reachable from the network without TLS.

### Requirement 2: Per-client tokens
**Objective:** As the archive owner, I want each cloud client to have its own secret token, so that I can tell clients apart and cut one off without affecting the others.

#### Acceptance Criteria
1. The remote MCP endpoint shall read one token per client from a setting named `MCP_TOKEN_<CLIENT>`, where `<CLIENT>` is 1 to 32 characters of uppercase letters, digits, and underscores, and the client name is `<CLIENT>` in lowercase.
2. If no client token is configured when `khipu mcp --http` starts, then the remote MCP endpoint shall refuse to start, exit with a non-zero status, and state that at least one `MCP_TOKEN_<CLIENT>` setting is required.
3. If any client token is shorter than 32 characters, then the remote MCP endpoint shall refuse to start, exit with a non-zero status, and name the offending setting without printing its value.
4. If two clients are configured with the same token value, then the remote MCP endpoint shall refuse to start, exit with a non-zero status, and name both settings without printing the value.
5. Where a `MCP_TOKEN_<CLIENT>_FILE` setting is provided and `MCP_TOKEN_<CLIENT>` is not set, the remote MCP endpoint shall use that file's contents as the client token, following the cloud-deployment secret-file rules.
6. When the operator removes a client's token setting and restarts the remote MCP endpoint, the remote MCP endpoint shall reject every request presenting that client's former token.
7. The remote MCP endpoint shall not accept the stdio `MCP_SECRET` value as a remote client token unless it is also configured as an `MCP_TOKEN_<CLIENT>` value.

### Requirement 3: Request authentication
**Objective:** As the archive owner, I want every remote MCP request to prove which client it comes from, so that only my chosen clients can read my messages over the internet.

#### Acceptance Criteria
1. The remote MCP endpoint shall require a valid client token on every request except `GET /healthz`, including requests to paths that match no route.
2. When a request carries a configured client token as a bearer token in the Authorization header, the remote MCP endpoint shall treat the request as coming from that client.
3. If a request carries no token, an unknown token, a malformed Authorization header, or a token only in the URL query string or in the MCP request body, then the remote MCP endpoint shall respond with status 401 and a body that does not reveal which check failed, and shall not run any tool.
4. The remote MCP endpoint shall compare presented tokens against configured tokens in a way whose duration does not depend on how many leading characters match.
5. When the remote MCP endpoint rejects a request for authentication, it shall log the method, path without query string, client address, and a reason category, without logging any presented credential.
6. If a request carries an Origin header whose value is not in the configured list of allowed origins, then the remote MCP endpoint shall respond with status 403 without running any tool, so that a web page in a browser cannot drive the endpoint.
7. When a request carries no Origin header and a valid client token, the remote MCP endpoint shall process it, so that server-to-server cloud clients can connect.

### Requirement 4: Per-client tool scope
**Objective:** As the archive owner, I want to limit which tools a given client may use, so that I can share only what that client needs (for example search without images).

#### Acceptance Criteria
1. Where no tool allowlist is configured for a client, the remote MCP endpoint shall let that client list and call every tool the stdio MCP server offers.
2. Where a tool allowlist setting `MCP_TOOLS_<CLIENT>` is configured as a comma-separated list of tool names, the remote MCP endpoint shall let that client list and call only the named tools.
3. When a client lists tools, the remote MCP endpoint shall return only the tools that client may call.
4. If a client calls a tool outside its allowlist, then the remote MCP endpoint shall return an MCP error stating the tool is not available, without running the tool and without revealing whether the tool exists.
5. If an allowlist names a tool that the MCP server does not offer, or is set but empty, then the remote MCP endpoint shall refuse to start, exit with a non-zero status, and name the setting and the unknown tool.
6. If an `MCP_TOOLS_<CLIENT>` setting exists for a client that has no token, then the remote MCP endpoint shall refuse to start and name the setting.
7. The remote MCP endpoint shall return the same tool results for a permitted call as the stdio MCP server returns for the same tool and arguments against the same archive.

### Requirement 5: Remote protocol behavior and limits
**Objective:** As the archive owner, I want the remote endpoint to work with standard cloud MCP clients and to stay safe under bad input, so that connecting a client just works and malformed traffic cannot harm the archive.

#### Acceptance Criteria
1. The remote MCP endpoint shall implement the MCP Streamable HTTP transport so that a standard MCP client given the endpoint URL and a bearer token can initialize, list tools, and call tools.
2. The remote MCP endpoint shall not modify the archive in response to any request.
3. If a request body exceeds 1 MiB, then the remote MCP endpoint shall respond with status 413 before parsing it and without running any tool.
4. If a tool call fails with an unexpected error, then the remote MCP endpoint shall return an MCP error without internal details or stack traces, log the error with the client name and tool name, and keep serving other requests.
5. The remote MCP endpoint shall respond to every request with headers that disable response caching and content-type sniffing.
6. When a client sends `GET /healthz`, the remote MCP endpoint shall respond without requiring authentication, with status 200 and a body stating only that it is healthy when the archive can be queried, or status 503 and a body stating only that it is unavailable otherwise.
7. When the remote MCP endpoint receives a stop signal, it shall stop accepting new connections, let in-flight requests finish for up to 10 seconds, and exit with status 0.

### Requirement 6: Audit logging
**Objective:** As the archive owner, I want a record of which client used which tool, so that I can see what a cloud service accessed without the log itself holding my messages.

#### Acceptance Criteria
1. When a client calls a tool, the remote MCP endpoint shall log one line with the timestamp, client name, tool name, outcome (ok, error, or denied), and duration in milliseconds.
2. The remote MCP endpoint shall not log tool arguments, tool results, message content, or any token.
3. When a client lists tools or initializes a session, the remote MCP endpoint shall log the client name and the operation, without arguments.

### Requirement 7: Deployment and exposure guidance
**Objective:** As the archive owner, I want clear instructions to publish the endpoint and connect a cloud client, so that I can give a service such as Muse.ai access safely.

#### Acceptance Criteria
1. The project shall document how to generate a client token, configure `MCP_TOKEN_<CLIENT>` and `MCP_TOOLS_<CLIENT>`, and start `khipu mcp --http`.
2. The project shall document publishing the endpoint through Tailscale Funnel and through Cloudflare Tunnel, including that Tailscale Serve alone is reachable only inside the tailnet and is not reachable by cloud services.
3. The project shall document verifying the setup end to end through the public URL, both with a valid token and with no token (expecting 401).
4. The project shall document that the endpoint is reachable only while the host runs and is awake, and that a server deployment provides always-on access while macOS-only sources still sync from the Mac.
5. The project shall document the privacy implications: every configured client can read the archive data its tools return, tokens act as credentials until removed, and revoking a client requires removing its setting and restarting.
6. Where the cloud-deployment compose definition exists, the project shall provide an optional remote MCP service in it that publishes its port only on the host's loopback interface and is health-checked through `/healthz`.

### Requirement 8: Consistency with existing specs and steering
**Objective:** As the maintainer, I want the specs and steering to describe the new rule accurately, so that later work does not reintroduce the "stdio only" assumption or break ingress isolation.

#### Acceptance Criteria
1. The cloud-deployment spec shall state that the MCP server is reachable over stdio and, when explicitly started with `--http`, through the remote MCP endpoint on its own port, and shall keep the rule that the ingress server never exposes MCP, MCP tools, or archive queries.
2. The cloud-deployment secret-file allowlist shall include every name matching `^MCP_TOKEN_[A-Z0-9_]+$`.
3. The phase 5 cross-spec decisions shall record this change as a new decision naming remote-mcp as the owner of the remote MCP endpoint.
4. The tech steering shall describe MCP as stdio by default with an opt-in Streamable HTTP mode, and the product steering shall note that remote access sends tool results to the configured clients.
5. The project test suite shall continue to fail if the ingress server or any of its route modules depends on the MCP server, the tool registry, the shared query handlers, or the web UI routes.
