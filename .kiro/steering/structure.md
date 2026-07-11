# Project Structure

## Organization Philosophy

Flat top-level `src/` with platform adapters isolated under `src/platforms/<name>/`. Shared infrastructure (DB, embeddings, MCP, web) lives directly in `src/`. No feature directories outside platforms.

## Directory Patterns

### Platform Adapters
**Location**: `src/platforms/<name>/`
**Purpose**: All code specific to one messaging platform
**Pattern**: Each adapter has at minimum a `sync.ts` (the runnable sync script). Complex platforms add `client.ts` (API wrapper) and `contacts.ts` (contact resolution). The adapter exports an object implementing `PlatformAdapter` from `src/platforms/types.ts`.
**Example**: `src/platforms/telegram/sync.ts`, `src/platforms/imessage/sync.ts`

### Shared Infrastructure
**Location**: `src/`
**Purpose**: Core modules consumed by adapters and surfaces
**Key files**:
- `src/db.ts` — schema, migrations, all exported DB functions (the only entry point adapters may call)
- `src/mcp.ts` — MCP server and tool definitions
- `src/cli.ts` — CLI entry point
- `src/embeddings.ts` — embedding generation helpers
- `src/index-embeddings.ts` — runnable script to build/rebuild the embeddings index; exports `rebuildEmbeddings(platform?)` for programmatic use
- `src/vec-db.ts` — sqlite-vec schema and vector search queries
- `src/config.ts` — environment and configuration loading

### Sync Infrastructure
**Location**: `src/`
**Purpose**: Shared sync orchestration used by all platform adapters

- `src/sync-runner.ts` — exports `runPlatformSync(adapter, db, argv)` and `parseSyncArgs(argv)`; handles `sync_state` tracking, incremental vs full-backfill mode selection, FTS + embedding rebuild after sync
- `src/sync-all.ts` — serial orchestrator that spawns every platform's `sync.ts` in order; forwards `--force`/`--backfill` flags; entry point for `npm run sync`
- `src/setup-sync.ts` — installs/uninstalls a macOS LaunchAgent (`com.khipuchat.sync`) that runs `sync-all` on a schedule; entry point for `npm run setup-sync`

**Pattern**: Every platform adapter calls `runPlatformSync` from `sync-runner.ts` rather than implementing sync state logic directly. Incremental mode reads `sync_state` (keyed by platform) to fetch only messages newer than last sync. `--force` flag triggers a full re-read + FTS + embeddings rebuild.

### Web UI
**Location**: `src/web/`
**Purpose**: Express server + server-side HTML rendering
**Pattern**: `server.ts` registers routes from `routes.ts`. UI is plain HTML strings assembled in `ui.ts` / `ui-scroll.ts`. `icons.ts` provides SVG icon helpers (simple-icons). No client-side framework.

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
