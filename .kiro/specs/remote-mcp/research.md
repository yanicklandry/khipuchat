# Research & Design Decisions

## Summary
- **Feature**: `remote-mcp`
- **Discovery Scope**: Extension (light discovery: integration with the existing MCP server, tool registry, CLI router, and the not-yet-implemented cloud-deployment spec)
- **Key Findings**:
  - The installed `@modelcontextprotocol/sdk` is 1.29.0 and ships `StreamableHTTPServerTransport` (Node `IncomingMessage`/`ServerResponse` wrapper) with a stateless mode (`sessionIdGenerator: undefined`) and JSON responses (`enableJsonResponse: true`). Express 5 is already a dependency (web UI). No new package is needed.
  - `src/tool-registry.ts` already holds the single tool list (`TOOL_DEFINITIONS`) and `dispatchTool`, shared by stdio MCP and `khipu ask`. Every current tool is read-only. Building the remote server on the registry gives parity (Req 4.7) for free, including tools other specs add later.
  - `createMcpServer()` is called with no arguments by four test files and enforces `MCP_SECRET` through `params._meta.authorization`. Changing it risks stdio regressions (Req 1.2), so the remote server is a separate factory and `createMcpServer` is untouched except for sharing the result formatter.
  - `khipu.ts` forwards `argv.slice(1)` to operational scripts, so `khipu mcp --http` reaches `src/mcp.ts` as `--http` without router changes beyond help text.
  - `initDb` writes at startup (schema, migrations, FTS rebuild). The no-modification guarantee (Req 5.2) is therefore about requests, not startup, and is verified with `total_changes()` around tool calls.
  - cloud-deployment (tasks generated, not implemented) owns `resolveSecretFiles` (D2). Its result keeps `<NAME>_FILE` in the env next to the resolved `<NAME>`, and it runs in the CLI router before spawning. remote-mcp must not re-run it (it would report a conflict) and must not grow a second loader.

## Research Log

### MCP Streamable HTTP in SDK 1.29.0
- **Context**: Req 5.1 needs a standard remote transport that cloud clients understand.
- **Sources Consulted**: `node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.d.ts`, `webStandardStreamableHttp.d.ts`, `express.d.ts`.
- **Findings**:
  - `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` + `server.connect(transport)` + `transport.handleRequest(req, res, parsedBody)`. Stateless mode needs a fresh Server and transport per request.
  - Transport options include `allowedOrigins`, `allowedHosts`, `enableDnsRebindingProtection`; `handleRequest` options carry `authInfo` to handlers via `extra.authInfo`.
  - `createMcpExpressApp` exists but adds host validation aimed at localhost dev servers; behind a tunnel the Host header is the public hostname, so it is not used.
- **Implications**: one Server per POST, built for the authenticated client with its filtered tool list. GET and DELETE on `/mcp` answer 405 (stateless, no SSE stream, no sessions), which the protocol allows.

### Authentication against the MCP authorization model
- **Context**: Requirements put OAuth out of scope; bearer tokens only.
- **Findings**: The MCP authorization spec uses OAuth 2.1 bearer tokens in the `Authorization` header. A static bearer token is the same wire format, so clients that accept a custom header work. Clients that insist on OAuth discovery will not connect (accepted, recorded as a risk).
- **Implications**: auth is a small Express middleware ahead of body parsing, using SHA-256 digests and `crypto.timingSafeEqual` over every configured client (no early exit), mirroring cloud-deployment's IngressAuth approach.

### Secret files and the cloud-deployment loader
- **Context**: Req 2.5 (`MCP_TOKEN_<CLIENT>_FILE`).
- **Sources Consulted**: `.kiro/specs/cloud-deployment/design.md` (SecretFileLoader), `phase5-cross-spec-decisions.md` (D2).
- **Findings**: The loader is pure, allowlist plus name patterns, discovers pattern names from env keys ending in `_FILE`, and is invoked by the CLI router for every spawned command.
- **Implications**: remote-mcp adds the pattern `^MCP_TOKEN_[A-Z0-9_]+$` to the cloud-deployment spec (D2 owner) and relies on the router. The remote config ignores keys ending in `_FILE` when discovering clients; if `MCP_TOKEN_<C>_FILE` is present but `MCP_TOKEN_<C>` is not, the loader did not run (direct `tsx` start, or cloud-deployment not yet implemented) and startup fails with a message naming the setting.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Own process, stateless HTTP (selected) | `khipu mcp --http` runs a small Express app with one Server per request | Ingress isolation untouched; per-client tool scope is just a filtered list; no session state to secure or expire | Per-request Server construction cost (negligible: registers two handlers) | Chosen with the user |
| Ingress module | Mount MCP at `/v1/mcp` | One public URL | Breaks cloud-deployment Req 10.1/10.2 isolation | Rejected by the user |
| Stateful sessions | `sessionIdGenerator: randomUUID` with a session map | Server-initiated notifications, SSE | Session lifecycle, memory, session hijack surface; no tool here needs server push | Not needed |

## Design Decisions

### Decision: Separate remote server factory over the shared registry
- **Context**: Parity (Req 4.7) without touching stdio behavior (Req 1.2).
- **Alternatives Considered**: 1. Parameterize `createMcpServer(options)`. 2. New factory in `src/remote-mcp/`.
- **Selected Approach**: New factory `createRemoteMcpServer(client, audit)` using `TOOL_DEFINITIONS` and `dispatchTool`; result formatting extracted to `toToolContent` in the registry and used by both servers.
- **Rationale**: `createMcpServer()` keeps its exact contract and tests; both surfaces share dispatch and formatting, the only parts parity depends on.
- **Trade-offs**: two small Server factories instead of one.

### Decision: Rely on the CLI router for secret files
- **Context**: D2 makes cloud-deployment the only secret-file loader.
- **Selected Approach**: spec edit adds the `MCP_TOKEN_*` pattern; remote config detects unresolved `_FILE` companions and fails clearly.
- **Trade-offs**: Req 2.5 works end to end only after cloud-deployment task 1.4 lands; recorded as a task dependency.

### Decision: Compose service belongs to cloud-deployment's ComposeStack
- **Context**: Req 7.6 requires an optional compose service; the compose file is owned by cloud-deployment.
- **Selected Approach**: remote-mcp edits the cloud-deployment spec to add an optional `mcp-http` service under the compose profile `remote-mcp` (loopback port, `/healthz` healthcheck). remote-mcp documents it; it does not edit `docker-compose.yml` itself.

### Decision: Audit at two points
- **Context**: Req 6.1 to 6.3.
- **Selected Approach**: `tools/call` is audited inside the CallTool handler (outcome, duration). `initialize` and `tools/list` are audited at the HTTP layer from the parsed JSON-RPC method name(s), before handing to the transport. Only method names and client names are read.

## Synthesis Outcomes
- **Generalization**: The auth digest compare is the same technique as cloud-deployment's IngressAuth, but the two are kept separate: the ingress module does not exist yet and sharing would couple remote-mcp to the ingress closure (whose isolation test forbids the tool registry). Revisit once both exist.
- **Build vs adopt**: adopt the SDK transport; build only config parsing, auth, audit, and lifecycle (about 4 small files).
- **Simplification**: stateless JSON-response mode removes sessions, SSE, and resumability entirely.

## Risks & Mitigations
- Muse.ai may require OAuth connectors: verify before relying on it; OAuth is a follow-up spec if needed.
- Public exposure via Funnel: 32-character minimum tokens, constant-time compare, no query tokens, Origin check, no error details, audit log.
- Semantic tools load the embedding model on first call (slow first request): documented; no behavior change.
- Laptop sleep makes the endpoint unavailable: documented; server deployment via cloud-deployment.

## References
- `@modelcontextprotocol/sdk` 1.29.0 type declarations in `node_modules`.
- MCP specification, Transports (Streamable HTTP) and Authorization sections.
- Tailscale Funnel and Cloudflare Tunnel documentation (for the guide).
