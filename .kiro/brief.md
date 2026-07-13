# Brief: KhipuChat CLI + Operational Quality Pass

Master brief for the 2026-07-11 quality pass. Captures the operator-facing changes requested and how they decompose into new specs and corrections to existing specs. No code changes are made from this brief; implementation is done later in a batch (tukuy).

## Problem
KhipuChat works but does not feel like a finished, operable tool:
- Every action is an `npm run sync:*` script. There is no single, discoverable, globally installable command the way `tukuy` is.
- Sync semantics are inconsistent to reason about: it is unclear which commands are one-shot vs continuous, whether syncing also indexes, and how to force a full re-read.
- Each platform assumes a single account. Real users have multiple Slack workspaces, and often more than one Telegram or WhatsApp account.

## Current State
- Commands are npm scripts: `npm run sync`, `sync:telegram`, `sync:imessage`, `sync:wechat`, `sync:discord`, `sync:slack`, `sync:email`, `sync:whatsapp`, `mcp`, `web`, `cli`, `index:embeddings`, plus a specced-but-unbuilt `watch` daemon (`sync-watcher`).
- `incremental-sync` (specced) makes each adapter fetch only messages newer than `sync_state.last_synced_at`, with a `--backfill` flag for a full scan.
- `sync-watcher` (specced) adds a long-running `npm run watch` daemon that polls all configured platforms. It does **not** run embedding indexing after each poll.
- `semantic-search` provides local ONNX embeddings + `npm run index:embeddings`.
- No `bin` entry in package.json; nothing is globally installable.
- Schema (`src/db.ts`): `chats`, `messages`, and `sync_state` have **no account dimension**. `sync_state` PK is `platform` only.

## Desired Outcome
- A single global command `khipu`, installed for development via `npm link` (and shipped as a real bin), replaces the `npm run` surface for operators.
- Sync is incremental by default everywhere; `khipu sync all` runs continuously as a service (sync => index => wait), and can do a single pass for cron via `--once`.
- Running one platform (`khipu sync telegram`) is a one-shot, for debugging only.
- A single `--force` flag re-reads every message from the source AND rebuilds embeddings.
- Every platform except WeChat supports multiple named accounts, configured in a config file.

## Usage Surfaces (priority order)
The tool is consumed three ways; specs must reflect this priority (also recorded in steering/roadmap.md):
1. **MCP (primary, most common)** — an LLM (Claude) queries the archive: specific lookups (list chats/channels, list messages, get thread) and semantic search. This is the day-to-day use. Query/filter features land here first and must be platform- and account-aware.
2. **CLI (secondary)** — mainly debugging, but also scripted automation: list/search messages filtered by date range, platform, account, type. CLI filtering should reach parity with the MCP tools.
3. **Web (secondary)** — browser UI for testing and manual browsing.
Agent-native parity: whatever the archive can answer via MCP should be answerable via CLI and Web, with MCP as the reference implementation. This priority affects `khipu-cli` (CLI filters + `khipu mcp`/`khipu web` entry points) and `multi-account` (account dimension exposed on all three surfaces, MCP first).

## Operator Requests (verbatim intent)
1. Global command `khipu` (like `tukuy`); dev via `npm link`. Use `khipu sync telegram`, not `npm run sync:telegram`.
2. `khipu sync` lists available/configured platforms; `khipu sync all` syncs all configured platforms.
3. Sync looks for new messages => syncs them => indexes them => waits for new messages.
4. All chats fetch only new messages (incremental). If a source cannot filter server-side, document in README that it is slower.
5. Optional `--force` flag re-reads all messages (and rebuilds embeddings), instead of only new ones.
6. Individual `khipu sync <platform>` is for debugging; normal operation is `khipu sync all` run as a service or cron job.
7. All platforms except WeChat support multiple accounts (Slack most common; also multiple Telegram / WhatsApp).

## Decisions (confirmed with operator)
- **`khipu sync all` execution model**: daemon by default (loops sync => index => wait forever). `--once` performs a single pass and exits, for cron. `khipu sync <platform>` is always one-shot.
- **Full re-read flag**: a single `--force` flag re-reads all messages from the source AND rebuilds embeddings. (Reconciles the existing `incremental-sync` `--backfill` flag: `--backfill` is renamed/aliased to `--force`, and `--force` additionally triggers reindex.)
- **Multi-account config**: a `khipu.config.json` file lists named accounts per platform, each with its own credentials; secret values may reference environment variables (e.g. `"$SLACK_WORK"`). Not per-account suffixed env vars.

## Command Surface (target)
```
khipu sync                     # list platforms + configured accounts + status
khipu sync all                 # daemon: for each account, sync => index => wait (loop)
khipu sync all --once          # single pass over all accounts, then exit (cron)
khipu sync <platform>          # one-shot sync of a platform (all its accounts), debug
khipu sync <platform>@<account># one-shot sync of a single account, debug
khipu sync ... --force         # re-read ALL messages + rebuild embeddings
khipu mcp                      # run MCP server (replaces npm run mcp)
khipu web                      # run web UI (replaces npm run web)
khipu search <query> [...]     # search from terminal (replaces npm run cli)
khipu index [--force]          # rebuild embeddings (replaces npm run index:embeddings)
```
Existing `npm run` scripts may remain as thin wrappers during transition but are no longer the documented interface.

## Scope
- **In**:
  - New `khipu` bin + subcommand router; `bin` field in package.json; `npm link` dev workflow.
  - `khipu sync all` daemon that runs indexing after each successful platform/account sync (extends `sync-watcher`).
  - `--force` flag semantics (full re-read + reindex), reconciled with `incremental-sync`.
  - Multi-account support: `khipu.config.json`, account dimension in schema, per-account `sync_state`, adapters iterating configured accounts (WeChat excluded).
  - README documentation of incremental-only behavior and any per-platform slow-path (client-side filtering).
- **Out**:
  - Sending messages on any platform.
  - New platform integrations beyond those already on the roadmap.
  - Multi-account for WeChat (explicitly excluded — direct local-DB read, single install).
  - Cloud sync / hosted service.

## New Specs
- **khipu-cli** — the global command, subcommand router, `khipu sync`/`sync all`/`sync <platform>`, `--force`/`--once`, and folding the watcher daemon behavior in as `khipu sync all`. Owns the operator-facing CLI surface.
- **multi-account** — config file, schema account dimension, per-account sync state, per-account adapter iteration.

## Existing Spec Corrections
- **sync-watcher** — poll cycle must also run embedding indexing after a successful sync (sync => index => wait). Entry point becomes `khipu sync all` (loop logic stays here; CLI surface owned by khipu-cli). Support `--once` single-pass.
- **incremental-sync** — rename/alias `--backfill` to `--force`; `--force` additionally rebuilds embeddings. `sync_state` becomes keyed by (platform, account) once multi-account lands.
- **semantic-search** — indexing is invoked automatically by the watch loop after each sync and by `--force`; note the `khipu index` entry point.
- **release** — Docker, README, and CI must reference the `khipu` CLI (global install / `npm link`) instead of `npm run sync:*` and raw `tsx` invocations.

## Upstream / Downstream
- **Upstream**: `platform-abstraction` (PlatformAdapter, schema), `incremental-sync` (sync_state), `sync-watcher` (daemon loop), `semantic-search` (indexing).
- **Downstream**: `release` (packaging/docs must reflect the CLI and multi-account config).

## Constraints
- Keep each source file under 200 lines.
- DB operations remain synchronous (better-sqlite3); MCP over stdio only; self-hosted, no external services.
- Schema changes must migrate existing single-account databases without data loss (default account, e.g. `"default"`).

## Specs
- [x] platform-abstraction
- [x] imessage-sync
- [x] whatsapp-sync
- [x] incremental-sync
- [x] web-ui-enhancements
- [x] multi-account
- [x] semantic-search
- [x] web-ui
- [x] discord-sync
- [x] email-sync
- [x] slack-sync
- [x] security-hardening
- [x] release
- [x] sync-watcher
- [x] khipu-cli
- [x] image-support
- [x] signal-platform
- [x] signal-image-sync
- [x] telegram-image-sync
- [x] wechat-sync
- [ ] wechat-image-sync
