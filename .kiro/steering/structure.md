# Project Structure

## Organization Philosophy

Flat top-level `src/` with platform adapters isolated under `src/platforms/<name>/`. Shared infrastructure (DB, embeddings, MCP, web) lives directly in `src/`. No feature directories outside platforms.

## Directory Patterns

### Platform Adapters
**Location**: `src/platforms/<name>/`
**Purpose**: All code specific to one messaging platform
**Pattern**: Each adapter has at minimum a `sync.ts` (the runnable sync script). Complex platforms add `client.ts` (API wrapper), `contacts.ts` (contact resolution), or `image-meta.ts` (media metadata extraction from platform-specific formats). The adapter exports an object implementing `PlatformAdapter` from `src/platforms/types.ts`; the factory function that constructs it from credentials implements `AdapterFactory` (also from `types.ts`). Adapters use `AccountRegistry` to iterate over configured accounts and call `runPlatformSync` per account.

**`PlatformAdapter` interface** (from `src/platforms/types.ts`):
- `readonly platform: Platform` — identifies the platform
- `readonly account: string` — identifies the account within the platform
- `runBackfill(db)` — full re-read of all history; always required
- `startListener(db)` — begin continuous watching (called by the watch daemon)
- `syncIncremental?(db, since)` — optional; if present, called instead of `runBackfill` when incremental mode is active and `since` is known
**Implemented**: telegram, imessage, wechat, discord, slack, email, whatsapp, signal
**Example**: `src/platforms/telegram/sync.ts`, `src/platforms/discord/sync.ts`

### Shared Infrastructure
**Location**: `src/`
**Purpose**: Core modules consumed by adapters and surfaces
**Key files**:
- `src/db.ts` — schema, all exported DB functions (the only entry point adapters may call)
- `src/db-migrations.ts` — migration helpers and `columnExists` utilities extracted from `db.ts`
- `src/account-registry.ts` — loads `khipu.config.json`; exposes `AccountRegistry` with `listAccounts(platform)` and `credentialsFor(platform, account)`; falls back to legacy env-var resolution when no config file is present
- `src/query-handlers.ts` — shared query/search logic (temporal filter parsing, semantic search orchestration) shared by MCP and CLI surfaces
- `src/mcp.ts` — MCP server and tool definitions
- `src/cli.ts` — CLI entry point
- `src/embeddings.ts` — embedding generation helpers
- `src/index-embeddings.ts` — runnable script to build/rebuild the embeddings index; exports `rebuildEmbeddings(platform?)` for programmatic use
- `src/vec-db.ts` — sqlite-vec schema and vector search queries
- `src/config.ts` — environment and configuration loading
- `src/setup-claude.ts` — writes the MCP entry into Claude Desktop's config JSON; entry point for `npm run setup-claude`
- `src/khipu.ts` — command router for the `khipu` global binary; maps subcommands (`sync`, `mcp`, `web`, `index`, `setup-claude`, `setup-sync`, `list`) to the appropriate `tsx` script, and forwards query subcommands to `src/cli.ts`; exports `resolveCommand` and `ResolveDeps` interface for unit testing (dependency injection allows tests to supply a fake account registry without touching the filesystem)
- `src/cli-filters.ts` — shared CLI filter parsing (platform, date range, account, type) producing `QueryFilters`; used by `cli.ts` and `khipu-list.ts`
- `src/khipu-list.ts` — runnable entry point for `khipu list`; delegates to `query-handlers.ts` to list chats, messages, or accounts
- `src/khipu-sync-status.ts` — runnable entry point for `khipu sync` (status view); reads `sync_state` and prints per-platform/account sync timestamps

### Media Infrastructure
**Location**: `src/` (shared) + platform-specific helpers under `src/platforms/<name>/`
**Purpose**: Shared image storage, OCR, and MCP retrieval established by telegram-image-sync; reusable by future platforms
**Key files**:
- `src/media-storage.ts` — file path convention (`<MEDIA_DIR>/<platform>/<chatId>/<externalId>.<ext>`) + `storeMedia()`; idempotent, no DB contact
- `src/ocr.ts` — tesseract.js singleton worker; `extractText(Buffer|string)` never throws (returns null on failure); `terminateOcr()` for process shutdown
- `src/image-handlers.ts` — MCP `get_image` tool handler; reads `media_file_path` + `ocr_text` from DB, returns base64 content
- `src/platforms/telegram/image-sync.ts` — Telegram-specific: downloads photo messages via GramJS `client.downloadMedia()`, stores via `storeMedia`, runs OCR, writes `media_file_path` + `ocr_text` back to DB
- `src/platforms/signal/image-sync.ts` — Signal-specific: fetches attachments via Beeper's attachment API, stores via `storeMedia`, runs OCR; follows same interface as telegram image-sync
- `src/platforms/wechat/image-meta.ts` — WeChat-specific: extracts image file path and dimensions from WeChat XML message content; no download step (images are already on local disk); called inline from wechat `sync.ts`

**Pattern**: Two variants for platform image handling:
- **Remote images** (Telegram, Signal): implement `image-sync.ts` — downloads from API, calls `storeMedia`, runs OCR
- **Local images** (WeChat): implement `image-meta.ts` — extracts metadata from message content and integrates into `sync.ts` directly; no download needed since files are already on disk

### Sync Infrastructure
**Location**: `src/`
**Purpose**: Shared sync orchestration used by all platform adapters

- `src/sync-runner.ts` — exports `runPlatformSync(adapter, db, argv)` and `parseSyncArgs(argv)`; handles `sync_state` tracking, incremental vs full-backfill mode selection, FTS + embedding rebuild after sync
- `src/sync-all.ts` — serial orchestrator that spawns every platform's `sync.ts` in order; forwards `--force`/`--backfill` flags; entry point for `npm run sync`
- `src/setup-sync.ts` — installs/uninstalls a macOS LaunchAgent (`com.khipuchat.sync`) that runs `sync-all` on a schedule; entry point for `npm run setup-sync`
- `src/watch.ts` — continuous-poll daemon; iterates all configured platforms in a loop (sync => index => wait); per-platform interval configurable via `WATCH_INTERVAL_<PLATFORM>_MS` env var (default 5 min); skips platforms whose credentials are absent; used by `khipu sync all`

**Pattern**: Every platform adapter calls `runPlatformSync` from `sync-runner.ts` rather than implementing sync state logic directly. Incremental mode reads `sync_state` (keyed by platform) to fetch only messages newer than last sync. `--force` flag triggers a full re-read + FTS + embeddings rebuild.

### Web UI
**Location**: `src/web/`
**Purpose**: Express server + server-side HTML rendering
**Pattern**: `server.ts` exports `createApp()` (builds and returns the Express app) and `startServer(app, host?, port?)` (binds it; defaults to `127.0.0.1:3333`). Routes are registered in `routes.ts`. UI is plain HTML strings assembled in `ui.ts` / `ui-scroll.ts` / `ui-chats.ts`. `icons.ts` provides SVG icon helpers (simple-icons). `ui-chats.ts` handles chat list rendering with multi-account filter UI. No client-side framework.

**Parity mechanism**: `routes.ts` calls exported handler functions from `mcp.ts` directly (`handleListChats`, `handleSearchMessages`, `handleListMessages`). This is how agent-native parity is enforced at the code level: the same logic runs for MCP tools and web API routes.

### Binary Entry Point
**Location**: `bin/khipu`
**Purpose**: Executable Node.js shim registered in `package.json#bin`; resolves and spawns `tsx src/khipu.ts`; propagates child exit code. After `npm link`, `khipu` is on PATH for both local dev and Docker.

### Scripts
**Location**: `scripts/`
**Purpose**: Platform-specific setup helpers that can't be expressed as npm scripts
**Pattern**: Shell scripts and compiled C helpers for one-time or privileged operations (e.g., WeChat key extraction requires a native binary)

### CI/CD Workflows
**Location**: `.github/workflows/`
**Files**: `ci.yml` (test gate on push/PR to main), `release.yml` (multi-arch Docker image on `v*` tags)

### Documentation Assets
**Location**: `docs/`
**Purpose**: Static assets for README (demo screenshots/GIFs)

### Tests
**Location**: `tests/`
**Purpose**: Vitest test files; use `:memory:` SQLite, not mocks

## Naming Conventions

- **Files**: `kebab-case.ts` (e.g., `vec-db.ts`, `setup-claude.ts`)
- **Interfaces/Types**: PascalCase (e.g., `PlatformAdapter`, `Chat`, `Message`)
- **Functions**: camelCase
- **Platform names**: lowercase string literals matching the `Platform` union type

## Code Organization Principles

- Adapters call `db.ts` exports only — never import from other adapter directories
- `src/db.ts` is the shared seam: schema changes here propagate everywhere
- `src/platforms/types.ts` is the adapter contract: `PlatformAdapter` interface changes require all adapters to be updated
- `src/mcp.ts` is the query reference implementation: new filter/search capabilities land here first
- 200-line file limit: if a file grows past this, extract a helper module
