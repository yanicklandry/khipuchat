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
- `src/vec-db.ts` — sqlite-vec schema and vector search queries
- `src/config.ts` — environment and configuration loading

### Web UI
**Location**: `src/web/`
**Purpose**: Express server + server-side HTML rendering
**Pattern**: `server.ts` registers routes from `routes.ts`. UI is plain HTML strings assembled in `ui.ts` / `ui-scroll.ts`. No client-side framework.

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
