# Remote MCP endpoint

KhipuChat's MCP server normally runs over stdio: Claude Desktop (or another local client) starts `khipu mcp` itself and talks to it through a pipe. That only works for clients running on the same machine.

The remote MCP endpoint is an opt-in second mode. `khipu mcp --http` serves the same tools over MCP Streamable HTTP on its own port, so a cloud service (for example Muse.ai, or any hosted agent that supports remote MCP servers) can query your archive over the internet.

Use it when:

- a cloud client needs read access to your archive and cannot spawn a local process, and
- you are willing to publish one HTTPS URL through a tunnel (Tailscale Funnel or Cloudflare Tunnel).

If every client you use runs on your Mac, keep using stdio. Nothing about the stdio mode changes when the remote endpoint exists, and the remote endpoint never starts unless you pass `--http`.

What the endpoint does:

- Serves `POST /mcp` (MCP Streamable HTTP, stateless, JSON responses) and an unauthenticated `GET /healthz`.
- Requires a per-client bearer token on every request except `/healthz`.
- Limits each client to an optional allowlist of tools.
- Is read-only: it runs the same tool handlers as stdio and never modifies the archive.
- Writes one audit line per request to stderr.
- Listens on `127.0.0.1:3335` by default, with no TLS. TLS comes from the tunnel that publishes it.

## Generate a token

Each client gets its own random token. Tokens must be at least 32 characters, and two clients may not share a token.

```bash
openssl rand -hex 32
```

This prints 64 hex characters. Generate a new one for every client.

## Configure clients

A client is defined by one setting, `MCP_TOKEN_<CLIENT>`. `<CLIENT>` must be 1 to 32 characters of uppercase letters, digits, or underscores (for example `MUSE`, `AGENT_2`). The client's name in logs is `<CLIENT>` in lowercase (`muse`).

Add the settings to your `.env`:

```bash
# Muse.ai: limited to three tools
MCP_TOKEN_MUSE=<64-hex-character token>
MCP_TOOLS_MUSE=search_messages,list_chats,get_chat_summary

# Another client with access to every tool (no MCP_TOOLS_ setting)
MCP_TOKEN_AGENT=<another 64-hex-character token>
```

`MCP_TOOLS_<CLIENT>` is optional. When it is set, the client sees and can call only the listed tools (comma-separated). When it is absent, the client can use every tool. Available tool names:

| Tool | Notes |
|---|---|
| `list_chats` | Lists chats by recent activity |
| `find_chat_by_name` | Finds chats by name or username |
| `list_messages` | Lists messages in a chat or across the archive |
| `search_messages` | Full-text search |
| `get_chat_summary` | Stats and recent texts for one chat |
| `semantic_find_contacts` | Needs `khipu index` first |
| `semantic_search_messages` | Needs `khipu index` first |
| `get_image` | Returns the stored image bytes (base64) as well as its OCR text |

Note that `get_image` sends the actual image files to the client. Leave it out of the allowlist unless the client really needs photos.

Startup fails (exit status 1, with a message naming the setting) when:

- no `MCP_TOKEN_<CLIENT>` is set,
- a client name is invalid,
- a token is shorter than 32 characters, or two clients share a token,
- an `MCP_TOOLS_<CLIENT>` lists no tools, names an unknown tool, or has no matching `MCP_TOKEN_<CLIENT>`,
- `MCP_HTTP_PORT` is not an integer from 1 to 65535.

The stdio setting `MCP_SECRET` is not used by the remote endpoint.

### Token files (`_FILE`)

`MCP_TOKEN_<CLIENT>_FILE=/path/to/token` (reading the token from a file instead of the environment) works only once the cloud-deployment spec's secret-file loader exists, and only when the endpoint is started through the `khipu` CLI, which runs that loader. Until then, or when the endpoint is started any other way, the file is not read and startup fails naming the unresolved setting:

```
Remote MCP: MCP_TOKEN_MUSE_FILE is set but its token was not loaded; start through the khipu CLI so secret files are resolved.
```

For now, put tokens directly in `.env`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `MCP_TOKEN_<CLIENT>` | none (at least one required) | Bearer token for one client; 32 characters minimum, unique per client |
| `MCP_TOKEN_<CLIENT>_FILE` | none | Path to a file holding the token; needs the cloud-deployment secret-file loader and a start through `khipu` |
| `MCP_TOOLS_<CLIENT>` | all tools | Comma-separated allowlist of tool names for that client |
| `MCP_HTTP_HOST` | `127.0.0.1` | Address to listen on. Keep the loopback default when publishing through a tunnel |
| `MCP_HTTP_PORT` | `3335` | Port to listen on (1 to 65535) |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated list of allowed `Origin` values (for example `https://<client-host>`). Requests without an `Origin` header are allowed; requests with an `Origin` not in this list get 403 |

If `MCP_HTTP_HOST` is not a loopback address, the endpoint logs a warning at startup: it is then reachable from your network without TLS.

## Start the endpoint

```bash
khipu mcp --http
```

It uses the same archive as the stdio server. On startup it prints the listen URL and one line per client with its tool count (never a token):

```
remote MCP listening on http://127.0.0.1:3335/mcp
client=agent tools=8/8
client=muse tools=3/8
```

Ctrl+C (or SIGTERM) stops it gracefully: in-flight requests get up to 10 seconds to finish. If the port is already in use, it exits with status 1 and names the address.

Check it locally:

```bash
curl http://127.0.0.1:3335/healthz
# {"status":"ok"}
```

## Publish with Tailscale Funnel

Tailscale Funnel gives the endpoint a public HTTPS URL on your tailnet's domain (`https://<machine>.<tailnet>.ts.net`).

```bash
tailscale funnel --bg 3335
tailscale funnel status
```

`funnel status` shows the public URL and confirms it is marked as Funnel (public), not only Serve.

Requirements:

- HTTPS certificates and MagicDNS must be enabled for the tailnet (admin console, DNS settings).
- Funnel must be allowed for the machine in the tailnet ACL policy (the `funnel` node attribute). The first `tailscale funnel` run prints a link to enable it if it is missing.

Why not Tailscale Serve? `tailscale serve` publishes the port only inside your tailnet. A cloud service is not a member of your tailnet, so it cannot reach a Serve URL at all. Only Funnel makes the URL reachable from the public internet.

To stop publishing: `tailscale funnel reset`.

## Publish with Cloudflare Tunnel

For a stable hostname on a domain you manage in Cloudflare, create a named tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create khipu-mcp
cloudflared tunnel route dns khipu-mcp <host>
```

Then add an ingress rule in `~/.cloudflared/config.yml` that sends the hostname to the local endpoint:

```yaml
tunnel: khipu-mcp
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: <host>
    service: http://127.0.0.1:3335
  - service: http_status:404
```

Run it:

```bash
cloudflared tunnel run khipu-mcp
```

For a quick test without a domain, a temporary tunnel prints a random `https://<random>.trycloudflare.com` URL:

```bash
cloudflared tunnel --url http://127.0.0.1:3335
```

Quick tunnels change URL on every start, so use a named tunnel for a real client.

## Verify end to end

Run these against the public URL, not localhost, so the tunnel is part of the test. Replace `<host>` with your Funnel or Cloudflare hostname and `<token>` with one client's token.

Health (no token needed), expect 200:

```bash
curl -i https://<host>/healthz
# HTTP/2 200
# {"status":"ok"}
```

No token, expect 401:

```bash
curl -i -X POST https://<host>/mcp
# HTTP/2 401
# www-authenticate: Bearer
# {"error":"unauthorized"}
```

Valid token with an MCP `initialize` request, expect 200:

```bash
curl -i -X POST https://<host>/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
# HTTP/2 200
# {"result":{"protocolVersion":...,"serverInfo":{...}},"jsonrpc":"2.0","id":1}
```

To see which tools that client gets, send `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` with the same headers. An allowlisted client lists only its allowed tools.

All three headers matter: the endpoint refuses a request without the `Accept` value above (406) or without a JSON `Content-Type` (415).

## Connect a cloud client

In the client's MCP or connector settings:

- Server URL: `https://<host>/mcp`
- Transport: Streamable HTTP (sometimes called "HTTP" or "remote MCP")
- Header: `Authorization: Bearer <token>`

The client must let you set a custom request header with a static bearer token. Connectors that only support OAuth sign-in are not supported: the endpoint has no OAuth flow.

For Muse.ai specifically, check in its connector settings that it accepts a custom `Authorization` header before you rely on it. If it only offers OAuth, it cannot connect to this endpoint.

If the client sends an `Origin` header (browser-based clients usually do), add that origin to `MCP_ALLOWED_ORIGINS` or its requests get 403.

## Uptime

The endpoint is reachable only while the machine running `khipu mcp --http` is on, awake, and online, and while the tunnel is running. On a Mac that means the client gets errors whenever the Mac sleeps or is closed. Keep the Mac awake (for example with `caffeinate -s` while on power, or the Energy settings) if a client needs it during the day.

For always-on access, run the endpoint on a server through the cloud-deployment setup. Sources that only work on macOS (iMessage, WhatsApp, Zalo) still sync on the Mac; the server holds the archive that the remote endpoint reads.

## Privacy and revocation

- Every configured client can read whatever its tools return. With no allowlist that is your whole archive: message text, contact names, chat lists, and (through `get_image`) stored photos. Those results leave your machine and are stored and processed under the client service's own policies.
- Prefer an allowlist (`MCP_TOOLS_<CLIENT>`) with only the tools the client needs.
- Tokens are credentials. Anyone holding a token has that client's access until the setting is removed. Keep tokens out of chats, issues, and screenshots, and never pass them in the URL (a query-string token is rejected and logged as an auth failure).
- To revoke a client: delete its `MCP_TOKEN_<CLIENT>` (and `MCP_TOOLS_<CLIENT>`) from `.env` and restart `khipu mcp --http`. To rotate, replace the token and restart. Changes take effect only on restart.
- To take the endpoint offline entirely, stop `khipu mcp --http` or the tunnel.

### Audit log

Every request writes one line to stderr, prefixed `[remote-mcp]`, with an ISO timestamp and `key=value` fields:

```
[remote-mcp] ts=2026-11-13T09:15:02.114Z client=muse op=initialize
[remote-mcp] ts=2026-11-13T09:15:02.380Z client=muse op=tools/list
[remote-mcp] ts=2026-11-13T09:15:03.021Z client=muse op=tools/call tool=search_messages outcome=ok ms=42
[remote-mcp] ts=2026-11-13T09:15:04.500Z client=muse op=tools/call tool=get_image outcome=denied ms=0
[remote-mcp] ts=2026-11-13T09:15:05.733Z client=agent op=tools/call tool=list_messages outcome=error ms=3
[remote-mcp] ts=2026-11-13T09:15:05.733Z client=agent op=tool-error tool=list_messages error=Error
[remote-mcp] ts=2026-11-13T09:16:10.002Z op=auth-failed reason=unknown-token method=POST path=/mcp addr=127.0.0.1
```

- `outcome` is `ok`, `denied` (tool not in the client's allowlist), or `error` (the tool failed).
- `tool-error` records only the error type name, never its message, because error messages can echo arguments.
- `auth-failed` `reason` is one of `origin`, `missing`, `malformed`, `unknown-token`, `query-token`. `path` never includes the query string.
- The log never contains tool arguments, tool results, message content, or tokens.

Behind a tunnel, `addr` is the caller's address taken from the `X-Forwarded-For` header, which is trusted only when the connection comes from loopback (where Tailscale Funnel and cloudflared connect from). A direct connection shows its socket address.

## Troubleshooting

| Status | Body | Cause and fix |
|---|---|---|
| 401 | `{"error":"unauthorized"}` | Token missing, not `Authorization: Bearer <token>`, unknown, or sent in the query string. All cases get the same answer; the audit line's `reason` tells them apart. Check the header, and restart after editing `.env` |
| 403 | `{"error":"forbidden"}` | The request had an `Origin` header not listed in `MCP_ALLOWED_ORIGINS`. Add the client's origin (scheme and host, for example `https://<client-host>`) and restart |
| 406 | JSON-RPC error | The `Accept` header is missing or wrong. Send `Accept: application/json, text/event-stream` |
| 413 | `{"error":"payload too large"}` | Request body over 1 MiB. No tool ran |
| 415 | `{"error":"unsupported media type"}` | `Content-Type` is not `application/json` (or uses an unsupported charset or encoding) |
| 400 | `{"error":"bad request"}` | Body is not valid JSON |
| 405 | `{"error":"method not allowed"}` | `GET` or `DELETE /mcp`. The endpoint is stateless and accepts only `POST /mcp` |
| 404 | `{"error":"not found"}` | Wrong path. Use `/mcp` (and `/healthz` for health) |
| 503 | `{"status":"unavailable"}` | `/healthz` could not query the archive |

A tool outside the client's allowlist does not produce an HTTP error: the response is a JSON-RPC error "Tool not available". A tool that throws returns "Tool failed".

If the client cannot connect at all, check in order: `curl http://127.0.0.1:3335/healthz` on the Mac, then `curl https://<host>/healthz` from another network, then `tailscale funnel status` or the `cloudflared` logs.

## Docker compose

Once the cloud-deployment spec is implemented, its compose stack provides an optional `mcp-http` service under the `remote-mcp` profile. It runs `khipu mcp --http`, publishes the port only on the host's loopback interface (`127.0.0.1:3335`), and is health-checked through `/healthz`:

```bash
docker compose --profile remote-mcp up -d mcp-http
```

Publish it with Tailscale Funnel or Cloudflare Tunnel from the host exactly as above. The web UI's ingress server never exposes MCP; the remote endpoint is always its own process on its own port.
