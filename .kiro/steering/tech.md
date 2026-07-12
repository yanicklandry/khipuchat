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

## Development Standards

### Type Safety
TypeScript strict mode. No `any`. DB row types are typed interfaces in `src/db.ts`. Platform type is a union (`'telegram' | 'imessage' | ...`) defined in `src/platforms/types.ts`.

### Code Quality
No linter configured; rely on TypeScript strict mode. Keep source files under 200 lines.

### Testing
Vitest. Tests use `:memory:` SQLite database (real DB, not mocked). Test files live in `tests/`.

## Common Commands

```bash
# Run MCP server
npm run mcp

# Sync all platforms (serial)
npm run sync               # incremental by default; pass --force for full re-read + reindex

# Sync a single platform
npm run sync:telegram
npm run sync:imessage
# (same pattern for discord, slack, email, wechat, whatsapp)

# Rebuild embeddings index
npm run index:embeddings

# Web UI
npm run web

# CLI
npm run cli -- <args>

# Setup
npm run setup-claude       # configure Claude Desktop MCP entry
npm run setup-sync         # install macOS LaunchAgent for automatic background sync
npm run setup:wechat       # WeChat-specific setup script

# Tests
npm test
```

## Key Technical Decisions

- **Synchronous DB**: `better-sqlite3` keeps sync semantics simple; no async/await in DB layer
- **No build step**: `tsx` runs TypeScript directly; `dist/` output is for Docker only
- **Local embeddings**: No external API calls for semantic search; model downloaded once at runtime
- **stdio MCP**: Claude Desktop spawns the MCP process; no HTTP server needed for LLM access
- **Encryption optional**: `DB_KEY` env var enables SQLCipher; omitting it leaves plain SQLite
- **Incremental sync**: `sync_state` table tracks last successful sync per (platform, account); `runPlatformSync` in `sync-runner.ts` chooses incremental vs full mode; `--force` triggers full re-read + FTS + embeddings rebuild. All adapters delegate to this shared runner.
- **Media fields**: `messages` schema includes `media_file_path`, `media_url`, `media_width`, `media_height` columns (nullable) for image and media messages; added via migration using `columnExists` from `src/db-migrations.ts`.
- **Multi-account**: `khipu.config.json` is the canonical account registry (optional). When absent, the system falls back to legacy single-account env-var resolution. WeChat is limited to one account. The `account` column on messages/chats distinguishes accounts within a platform.
