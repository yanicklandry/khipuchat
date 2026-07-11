# Brief: khipu-cli

## Problem
Operators drive KhipuChat entirely through `npm run sync:*` scripts. There is no single, discoverable, globally installable command (the project wants parity with `tukuy`). It is also unclear which commands are one-shot vs continuous, and whether syncing indexes.

## Current State
- Interface is npm scripts in package.json (`sync`, `sync:telegram`, ..., `mcp`, `web`, `cli`, `index:embeddings`).
- No `bin` field; nothing installs globally.
- The continuous daemon lives in the `sync-watcher` spec as `npm run watch` (specced, not yet built).
- `incremental-sync` provides the `--backfill` full-scan flag and per-platform `sync_state`.

## Desired Outcome
A single `khipu` command, installed for development via `npm link` and shipped as a real bin, is the operator interface. It routes subcommands and unifies sync, indexing, MCP, web, and search.

## Usage Surfaces
This tool has three consumption surfaces (see steering/roadmap.md "Usage Surfaces"); `khipu` is the single entry point to all of them:
1. **MCP (primary)** — `khipu mcp` runs the MCP server the LLM talks to. This is the most common use; the CLI must not regress it.
2. **CLI (secondary)** — `khipu search` / `khipu list` etc. are for debugging and scripted automation, and must support the same filters the MCP tools expose (date range, platform, account, type).
3. **Web (secondary)** — `khipu web` serves the browser UI for testing/browsing.

## Approach
Add a `bin` entry (`khipu` => compiled/tsx entry, e.g. `src/cli/khipu.ts`) and a lightweight subcommand router. `khipu sync all` becomes the long-running daemon (delegating loop logic to `sync-watcher`), running sync => index => wait per account. Individual `khipu sync <platform>` is one-shot for debugging. A single `--force` flag re-reads all messages and rebuilds embeddings. `--once` makes `sync all` do a single pass for cron. The query subcommands (`search`, `list`) are thin CLI wrappers over the same handler functions the MCP server uses (`src/mcp.ts`), so CLI and MCP stay at parity.

## Command Surface
```
khipu sync                       # list platforms + configured accounts + last-sync status
khipu sync all                   # daemon: for each account sync => index => wait (loop forever)
khipu sync all --once            # single pass over all accounts, then exit (cron-friendly)
khipu sync <platform>            # one-shot sync of a platform (all its accounts), debug only
khipu sync <platform>@<account>  # one-shot sync of one account, debug only
khipu sync ... --force           # re-read ALL messages from source + rebuild embeddings
khipu index [--force]            # rebuild embeddings (wraps index:embeddings)
khipu mcp                        # run MCP server (PRIMARY surface — the LLM talks to this)
khipu web                        # run web UI (testing / browsing)

# CLI query surface (debug + automation) — same filters as the MCP tools:
khipu search <query> [filters]   # semantic/keyword search
khipu list chats [filters]       # list chats/channels
khipu list messages [filters]    # list messages
# filters: --platform <p> --account <name> --since <date> --until <date> --type <t> --limit <n>
# examples:
khipu list messages --platform slack --account work --since 2026-07-01
khipu search "invoice" --platform email --until 2026-06-30
```

## Scope
- **In**: `bin` field + `khipu` entry point; subcommand router; `khipu sync` listing; `khipu sync all` daemon default + `--once`; `khipu sync <platform>[@account]` one-shot; global `--force` flag threaded to sync + index; `khipu mcp` / `khipu web` entry points; `khipu search` + `khipu list chats|messages` query subcommands that reuse the MCP handler functions and accept `--platform/--account/--since/--until/--type/--limit` filters (CLI/MCP parity); `npm link` dev workflow; help text; graceful exit codes.
- **Out**: The polling-loop internals and per-platform interval logic (owned by `sync-watcher`); incremental filtering internals (owned by `incremental-sync`); multi-account config parsing and schema (owned by `multi-account`); embedding pipeline internals (owned by `semantic-search`).

## Boundary Candidates
- CLI argument parsing + subcommand dispatch (`khipu <cmd> ...`).
- `sync` subcommand orchestration (list / all / single / flags) vs the daemon loop it delegates to.
- Bin/packaging surface (`bin` field, `npm link`, shebang, tsx-vs-build entry).

## Out of Boundary
- The watch/poll loop implementation (delegate to `sync-watcher`).
- How embeddings are computed (delegate to `semantic-search`).
- Account resolution from config (delegate to `multi-account`).

## Upstream / Downstream
- **Upstream**: `sync-watcher` (daemon loop invoked by `sync all`), `incremental-sync` (`--force`/incremental behavior), `semantic-search` (index step), `multi-account` (account enumeration for listing and `@account` targeting).
- **Downstream**: `release` (docs/Docker/CI must use `khipu`).

## Existing Spec Touchpoints
- **Extends**: `sync-watcher` (the `khipu sync all` entry point).
- **Adjacent**: `incremental-sync`, `semantic-search`, `multi-account`, `release`.

## Constraints
- Keep entry files under 200 lines; split router vs subcommands.
- Must work via `npm link` in dev (tsx) and as a packaged bin.
- Preserve existing `npm run` scripts as thin wrappers during transition; do not break current MCP/web usage.
