# Requirements Document

## Introduction

The `khipu` CLI is the single operator-facing entry point for KhipuChat. It provides a unified, globally installable command that routes to sync, index, MCP server, web UI, and query surfaces, replacing the current fragmented `npm run sync:*` script interface with a discoverable binary. The query subcommands (`search`, `list`) maintain filter parity with the MCP server so any MCP query can be reproduced from the terminal.

## Boundary Context

- **In scope**: The `khipu` binary and `bin` field registration; subcommand router; `khipu sync` status listing; `khipu sync all` daemon and `--once` flag; `khipu sync <platform>[@account]` one-shot; `--force` flag threaded to sync and index; `khipu index [--force]`; `khipu mcp` and `khipu web` entry points; `khipu search` and `khipu list chats|messages` with `--platform/--account/--since/--until/--type/--limit` filters; help output and exit codes; `npm link` dev workflow.
- **Out of scope**: Sync daemon polling loop and per-platform interval logic (owned by `sync-watcher` spec); incremental filtering and `sync_state` internals (owned by `incremental-sync` spec); multi-account config parsing and account enumeration (owned by `multi-account` spec); embedding computation pipeline (owned by `semantic-search` spec).
- **Adjacent expectations**: `khipu sync all` depends on the sync-watcher spec's daemon loop; `--force` and incremental behavior depend on incremental-sync; account listing and `@account` targeting depend on multi-account; `khipu index` depends on semantic-search for the rebuild implementation. The `setup-claude` and `setup-sync` subcommands already exist and the router must continue to dispatch them, but their implementation is not in this spec's scope.

## Requirements

### Requirement 1: CLI Binary and Subcommand Router

**Objective:** As an operator, I want a single `khipu` command installed globally, so that I can access all KhipuChat operations without looking up npm scripts.

#### Acceptance Criteria

1. The khipu CLI shall be registered as a `bin` entry in `package.json` so that `npm link` makes the `khipu` command available on the operator's PATH.
2. When the operator runs `khipu` with no arguments or `khipu --help`, the khipu CLI shall display a list of available subcommands with brief descriptions and exit with code 0.
3. When the operator runs `khipu <subcommand> --help`, the khipu CLI shall display usage text specific to that subcommand and exit with code 0.
4. When the operator passes an unrecognized subcommand, the khipu CLI shall print an error identifying the unknown subcommand, display the list of available subcommands, and exit with a non-zero code.
5. The khipu CLI shall work in development via `npm link` using direct TypeScript execution without requiring a separate build step.

### Requirement 2: Sync Status Listing (`khipu sync`)

**Objective:** As an operator, I want `khipu sync` with no arguments to show the state of all configured sync targets, so that I can see which platforms are configured and when they last synced.

#### Acceptance Criteria

1. When the operator runs `khipu sync` with no arguments, the khipu CLI shall display each configured platform, its configured accounts, and the timestamp of the last successful sync for each account.
2. When a platform has no configured accounts, the khipu CLI shall omit it from the sync status listing.
3. When a platform account has never been synced, the khipu CLI shall display a "never" indicator in place of a timestamp.

### Requirement 3: Sync Daemon (`khipu sync all`)

**Objective:** As an operator, I want `khipu sync all` to run a continuous background sync daemon, so that the archive stays current automatically.

#### Acceptance Criteria

1. When the operator runs `khipu sync all`, the khipu CLI shall start a continuous daemon that iterates all configured accounts (sync then index then wait per account), running indefinitely until interrupted.
2. When the operator runs `khipu sync all --once`, the khipu CLI shall perform exactly one pass over all configured accounts and exit with code 0.
3. When `--force` is appended to `khipu sync all` or `khipu sync all --once`, the khipu CLI shall trigger a full re-read of all messages and a full embeddings rebuild rather than an incremental update.
4. When the daemon receives SIGINT or SIGTERM, the khipu CLI shall exit cleanly with code 0.

### Requirement 4: Single-Platform One-Shot Sync (`khipu sync <platform>`)

**Objective:** As an operator, I want to sync a single platform or account on demand, so that I can debug or backfill a specific source without running the full daemon.

#### Acceptance Criteria

1. When the operator runs `khipu sync <platform>`, the khipu CLI shall perform a one-shot incremental sync of all configured accounts for that platform and exit on completion.
2. When the operator runs `khipu sync <platform>@<account>`, the khipu CLI shall perform a one-shot incremental sync of the specified account only and exit on completion.
3. When `--force` is appended, the khipu CLI shall perform a full re-read of all messages and rebuild embeddings for the targeted platform or account.
4. If the specified platform is not a recognized platform name, the khipu CLI shall display an error listing the valid platform names and exit with a non-zero code.
5. If the specified `@account` is not configured for the given platform, the khipu CLI shall display an error and exit with a non-zero code.

### Requirement 5: Index Subcommand (`khipu index`)

**Objective:** As an operator, I want to rebuild the embeddings index on demand, so that I can recover from a corrupted index or add embeddings for messages that were synced without indexing.

#### Acceptance Criteria

1. When the operator runs `khipu index`, the khipu CLI shall trigger an incremental embeddings build covering only messages that currently lack embeddings and exit when complete.
2. When the operator runs `khipu index --force`, the khipu CLI shall rebuild the full embeddings index from scratch and exit when complete.
3. While indexing, the khipu CLI shall display progress or status output so the operator can confirm the operation is running.

### Requirement 6: MCP Server Subcommand (`khipu mcp`)

**Objective:** As an operator, I want `khipu mcp` to start the MCP server, so that Claude Desktop and other LLM clients can connect to the archive.

#### Acceptance Criteria

1. When the operator runs `khipu mcp`, the khipu CLI shall start the MCP server communicating over stdio and keep the process running until interrupted.
2. When interrupted via SIGINT or SIGTERM, the khipu CLI shall exit cleanly with code 0.

### Requirement 7: Web UI Subcommand (`khipu web`)

**Objective:** As an operator, I want `khipu web` to start the web interface, so that I can browse archived messages in a browser.

#### Acceptance Criteria

1. When the operator runs `khipu web`, the khipu CLI shall start the web server and display the URL at which it is accessible.
2. While the web server is running, the khipu CLI shall keep the process running until interrupted.
3. When interrupted via SIGINT or SIGTERM, the khipu CLI shall exit cleanly with code 0.

### Requirement 8: Search Subcommand (`khipu search`)

**Objective:** As an operator, I want to search the message archive from the terminal with the same filters available in MCP, so that I can script and debug queries without running the full MCP server.

#### Acceptance Criteria

1. When the operator runs `khipu search <query>`, the khipu CLI shall perform a search over the archive and display matching messages.
2. The khipu CLI shall accept `--platform <p>` to filter results to a single platform.
3. The khipu CLI shall accept `--account <name>` to filter results to a single account within a platform.
4. The khipu CLI shall accept `--since <date>` and `--until <date>` to filter results to a date range using the same date parsing supported by the MCP search tool.
5. The khipu CLI shall accept `--type <t>` to filter results to a specific message type.
6. The khipu CLI shall accept `--limit <n>` to cap the number of results returned.
7. When the same query and filters are applied, the khipu CLI shall return the same results as the equivalent MCP tool invocation.
8. If no results match, the khipu CLI shall display an empty-results message and exit with code 0.
9. If the `<query>` argument is missing, the khipu CLI shall display usage text for the search subcommand and exit with a non-zero code.

### Requirement 9: List Subcommand (`khipu list`)

**Objective:** As an operator, I want to list chats and messages from the terminal with the same filters available in MCP, so that I can audit and script against the archive.

#### Acceptance Criteria

1. When the operator runs `khipu list chats`, the khipu CLI shall display the list of chats in the archive.
2. When the operator runs `khipu list messages`, the khipu CLI shall display messages from the archive.
3. The khipu CLI shall accept `--platform`, `--account`, `--since`, `--until`, `--type`, and `--limit` filters for both `list chats` and `list messages`, applying the same semantics as the corresponding MCP tools.
4. When the same filters are applied, the khipu CLI shall return the same results as the equivalent MCP tool invocation.
5. When the operator runs `khipu list` without `chats` or `messages`, the khipu CLI shall display usage text for the list subcommand and exit with a non-zero code.
6. If no items match the applied filters, the khipu CLI shall display an empty-results message and exit with code 0.

### Requirement 10: CLI/MCP Filter Parity

**Objective:** As an operator, I want all query and list operations on the CLI to accept the same filters as MCP, so that any MCP query can be reproduced exactly from the terminal.

#### Acceptance Criteria

1. The khipu CLI shall accept `--platform`, `--account`, `--since`, `--until`, `--type`, and `--limit` as filter flags on every query subcommand (`search`, `list chats`, `list messages`).
2. The khipu CLI shall accept the same set of platform values as the MCP server (`telegram`, `imessage`, `discord`, `slack`, `whatsapp`, `wechat`, `email`).
3. When a filter value is not recognized (e.g., an invalid platform name or non-numeric limit), the khipu CLI shall display an error message and exit with a non-zero code.
4. The khipu CLI shall not expose query or filter capabilities that are absent from the MCP server, and the MCP server shall not expose query or filter capabilities that are absent from the khipu CLI.
