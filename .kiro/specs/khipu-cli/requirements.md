# Requirements Document

## Project Description (Input)
A single `khipu` command, installed for development via `npm link` and shipped as a real bin, is the operator interface. It routes subcommands and unifies sync, indexing, MCP, web, and search.

Operators currently drive KhipuChat through `npm run sync:*` scripts with no single discoverable entry point. The desired outcome is a `khipu` CLI with a lightweight subcommand router that covers:
- `khipu sync` (list / all daemon / one-shot / --force / --once)
- `khipu index [--force]`
- `khipu mcp` (primary surface)
- `khipu web`
- `khipu search <query> [filters]`
- `khipu list chats|messages [filters]`

The query subcommands (`search`, `list`) reuse MCP handler functions to maintain CLI/MCP parity. The daemon (`sync all`) delegates its loop to the `sync-watcher` spec. Account enumeration, incremental filtering, and embedding pipeline internals remain owned by their respective specs.

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
