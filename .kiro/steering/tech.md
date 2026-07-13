# Technology Stack

## Architecture

Single Node.js process per role (MCP server, web server, sync scripts). All persistent state lives in one SQLite file (`khipuchat.db`). Platform adapters are isolated scripts that call shared `src/db.ts` functions — they never touch the schema directly.

## Core Technologies

- **Language**: TypeScript 5, strict mode, `noImplicitAny`
- **Runtime**: Node.js 20+, executed with `tsx` (no build step in development)
- **Database**: `better-sqlite3-multiple-ciphers` — synchronous SQLite with optional SQLCipher encryption; all DB operations are synchronous by design
- **MCP**: `@modelcontextprotocol/sdk` — communicates via stdio only (never HTTP)
- **Embeddings**: `@huggingface/transformers` with local ONNX model (all-MiniLM-L6-v2) + `sqlite-vec` for vector similarity search
- **Web server**: Express 5 serving plain HTML (no frontend framework)
- **Testing**: Vitest with `--pool=forks --poolOptions.forks.singleFork`

## Key Libraries

| Library | Role |
|---|---|
| `better-sqlite3-multiple-ciphers` | SQLite driver (sync, optional encryption) |
| `sqlite-vec` | Vector extension loaded at runtime into SQLite |
| `@modelcontextprotocol/sdk` | MCP server/tool registration |
| `@huggingface/transformers` | Local ONNX inference for embeddings |
| `telegram` | Telegram MTProto client |
| `whatsapp-web.js` | WhatsApp QR-code session client |
| `imapflow` | IMAP email sync |
| `tesseract.js` | Local OCR for image messages (singleton worker, never throws to caller) |
| `@beeper/desktop-api` | Signal sync via Beeper Desktop local API (`http://localhost:23373`); requires `BEEPER_ACCESS_TOKEN` |
| _(none)_ | Slack and Discord adapters call REST APIs directly via `globalThis.fetch`; no third-party SDK needed |

## Development Standards

### Type Safety
TypeScript strict mode. No `any`. DB row types are typed interfaces in `src/db.ts`. Platform type is a union (`'telegram' | 'imessage' | ...`) defined in `src/platforms/types.ts`.

### Code Quality
No linter configured; rely on TypeScript strict mode. Keep source files under 200 lines.

### Testing
Vitest. Tests use `:memory:` SQLite database (real DB, not mocked). Test files live in `tests/`.

Surface-parity tests (`surface-e2e.test.ts`, `query-parity.test.ts`) seed a shared `:memory:` DB and run the same queries through all three surfaces (MCP handlers, CLI helpers, web routes) to verify agent-native parity. These are the canonical integration tests for filter and search correctness.

## Deployment

### Docker
Two-stage build (Alpine builder + runtime). The runtime image runs `npm link` so `khipu` is on PATH; the default `CMD` is `khipu mcp` (stdio MCP server).

`docker-compose.yml` defines two services sharing named volumes:
- `web` (`khipu web`, port `127.0.0.1:3333`)
- `sync` (poll loop: `khipu sync all` every `$SYNC_INTERVAL` seconds, default 3600)

Shared volumes: `db-data` (database), `hf-cache` (HuggingFace ONNX model), `media-data` (image attachments).

Claude Desktop can connect via stdio with:
```bash
docker run -i --rm -v khipuchat_db-data:/app/khipuchat.db <image> khipu mcp
```

### CI/CD (GitHub Actions)
- `ci.yml`: triggers on push/PR to `main`; runs `npm ci` + `npm test` on `ubuntu-latest`, Node 20
- `release.yml`: triggers on `v*` tags; multi-arch build (`linux/amd64,linux/arm64`) via QEMU + Buildx; pushes to `ghcr.io` using `GITHUB_TOKEN` only (no manual secrets); tags image with version + `latest`

## Common Commands

After `npm link` (or `npm install -g .`), the `khipu` binary is the primary entry point:

```bash
# Run MCP server
khipu mcp

# Sync all platforms (serial)
khipu sync                 # incremental by default; pass --force for full re-read + reindex

# Sync a single platform
khipu sync telegram
khipu sync imessage
# (same pattern: discord, slack, email, wechat, whatsapp)

# Rebuild embeddings index
khipu index

# Web UI
khipu web

# Query (forwarded to src/cli.ts)
khipu <cli-args>

# Setup
khipu setup-claude         # configure Claude Desktop MCP entry
khipu setup-sync           # install macOS LaunchAgent for automatic background sync

# Tests
npm test
```

`npm run <script>` equivalents remain available for development (e.g. `npm run sync`, `npm run mcp`); `khipu` is preferred for production/Docker use.

## Key Technical Decisions

- **Synchronous DB**: `better-sqlite3` keeps sync semantics simple; no async/await in DB layer
- **No build step**: `tsx` runs TypeScript directly; `dist/` output is for Docker only
- **Local embeddings**: No external API calls for semantic search; model downloaded once at runtime
- **stdio MCP**: Claude Desktop spawns the MCP process; no HTTP server needed for LLM access
- **Encryption optional**: `DB_KEY` env var enables SQLCipher; omitting it leaves plain SQLite
- **Web basic-auth optional**: `WEB_USER` + `WEB_PASS` env vars enable HTTP Basic Auth on `/api/*` routes; omitting them leaves the web UI open (localhost-only by design)
- **MCP bearer token optional**: `MCP_SECRET` env var enables Bearer token auth on every MCP tool call (checked via `_meta.authorization`); omitting it leaves MCP open (stdio only by default)
- **Incremental sync**: `sync_state` table tracks last successful sync per (platform, account); `runPlatformSync` in `sync-runner.ts` chooses incremental vs full mode; `--force` triggers full re-read + FTS + embeddings rebuild. All adapters delegate to this shared runner.
- **Media fields**: `messages` schema includes `media_file_path`, `media_url`, `media_width`, `media_height` columns (nullable) for image and media messages; added via migration using `columnExists` from `src/db-migrations.ts`.
- **Multi-account**: `khipu.config.json` is the canonical account registry (optional). When absent, the system falls back to legacy single-account env-var resolution. WeChat is limited to one account. The `account` column on messages/chats distinguishes accounts within a platform.
