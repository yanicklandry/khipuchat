# Brief: multi-account

## Problem
Every platform in KhipuChat assumes a single account (one set of credentials per platform, read from `.env`). Real users have multiple Slack workspaces, and often more than one Telegram or WhatsApp account. Today there is no way to archive more than one account per platform.

## Current State
- Credentials are single-valued env vars (`TELEGRAM_API_ID`, `SLACK_TOKEN`, etc.).
- Schema (`src/db.ts`) has **no account dimension**:
  - `chats(id, name, type, username, platform, last_synced_at, message_count)`
  - `messages(... chat_id, platform, UNIQUE(external_id, chat_id))`
  - `sync_state(platform TEXT PRIMARY KEY, last_synced_at)` — one row per platform.
- Each adapter runs once against the single configured credential set.

## Desired Outcome
Each platform (except WeChat) supports multiple named accounts. An operator configures accounts in `khipu.config.json`; sync, indexing, and the web UI treat every account's chats as belonging to that account, without collision.

## Approach
Introduce a `khipu.config.json` account registry: per platform, a list of named accounts, each with its own credential fields; secret values may reference env vars (`"$SLACK_WORK"`). Add an `account` dimension to the schema (default `"default"` for migrated single-account data), re-key `sync_state` by (platform, account), and make each adapter iterate over its configured accounts. WeChat is explicitly excluded (single local-DB read).

## Config Shape (illustrative)
```json
{
  "slack":    [{ "name": "work", "token": "$SLACK_WORK" },
               { "name": "personal", "token": "$SLACK_PERSONAL" }],
  "telegram": [{ "name": "main", "apiId": "$TG_API_ID", "apiHash": "$TG_API_HASH", "phone": "$TG_PHONE" }],
  "whatsapp": [{ "name": "primary" }],
  "email":    [{ "name": "gmail", "host": "imap.gmail.com", "user": "$GMAIL_USER", "pass": "$GMAIL_PASS" }]
}
```

## Scope
- **In**:
  - `khipu.config.json` schema, loader, env-var reference resolution, and validation.
  - Schema migration: add `account` to `chats` (and propagate to message identity as needed); re-key `sync_state` to (platform, account); backfill existing rows with `"default"`.
  - `PlatformAdapter` account-awareness: sync methods receive the account identity + resolved credentials; adapters loop over configured accounts.
  - Per-account incremental sync state (coordinated with `incremental-sync`).
  - **Account exposed on all three surfaces, MCP first** (see steering "Usage Surfaces"):
    - **MCP (primary)**: query/filter tools (`list_chats`, `list_messages`, search tools) accept an optional `account` filter and return account identity on results, so the LLM can scope queries per account.
    - **CLI**: `--account` filter on `khipu list`/`khipu search` (parity with MCP), owned by `khipu-cli` but consuming this spec's account model.
    - **Web**: chats disambiguated by account where relevant.
  - WeChat explicitly excluded and documented as single-account.
- **Out**:
  - The CLI surface for selecting accounts (`khipu sync slack@work`) — owned by `khipu-cli`; this spec provides the enumeration/resolution it calls.
  - New platform integrations.
  - Credential acquisition flows (OAuth/QR) beyond passing per-account credentials to existing adapter logic.

## Boundary Candidates
- Config file: schema + loader + secret resolution.
- Schema/data model: account column, uniqueness, migration of existing DBs.
- Adapter contract: threading account identity + credentials through `runBackfill`/`syncIncremental`.
- Per-account `sync_state`.

## Out of Boundary
- CLI parsing / `@account` targeting (khipu-cli).
- Embedding pipeline (semantic-search) — must remain correct across accounts but is not modified here beyond account-scoped data.

## Upstream / Downstream
- **Upstream**: `platform-abstraction` (PlatformAdapter interface + schema ownership), `incremental-sync` (`sync_state` shape).
- **Downstream**: `khipu-cli` (enumerates accounts for `khipu sync` listing and `@account` targeting), `release` (config file documented in setup).

## Existing Spec Touchpoints
- **Extends**: `platform-abstraction` (schema + adapter interface), `incremental-sync` (`sync_state` keyed by platform+account).
- **Adjacent**: `khipu-cli`, `web-ui`, `semantic-search`, all `*-sync` specs (each adapter must iterate accounts).

## Constraints
- Migration must not lose data in existing single-account databases (assign `"default"`).
- Keep files under 200 lines; DB synchronous; self-hosted, no external secret stores (env-var references only).
- WeChat remains single-account by design.
