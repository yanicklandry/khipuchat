# Requirements Document

## Project Description (Input)

KhipuChat currently assumes a single account per platform (one credential set per platform via `.env`). Real users run multiple Slack workspaces and often more than one Telegram or WhatsApp account, so there is currently no way to archive more than one account per platform.

This feature introduces a `khipu.config.json` account registry that lets an operator define any number of named accounts per platform, each with its own credential fields (secret values may reference env vars). It adds an `account` dimension to the database schema, migrates existing single-account data to `"default"`, re-keys `sync_state` by `(platform, account)`, and makes every adapter iterate over its configured accounts. All three query surfaces (MCP, CLI, Web UI) expose account identity for filtering and disambiguation. WeChat is explicitly excluded and remains single-account by design.

## Requirements

### 1. Account Configuration Registry

KhipuChat shall read a `khipu.config.json` file that maps each platform to a list of named accounts, each carrying platform-specific credential fields.

**1.1 Config file loading**

- When `khipu.config.json` is present and valid, KhipuChat shall load all defined accounts for each platform before starting any sync or query operation.
- When `khipu.config.json` is absent or contains no platform entries, KhipuChat shall fall back to legacy per-platform env-var credentials and treat them as a single account named `"default"` on each configured platform.

**1.2 Environment-variable secret resolution**

- When a credential field value in `khipu.config.json` begins with `$`, KhipuChat shall resolve it by substituting the value of the corresponding environment variable.
- If a referenced environment variable is not set at startup, KhipuChat shall report an error identifying the missing variable and the account it belongs to, and shall not start sync for that account.

**1.3 Config validation**

- If `khipu.config.json` contains two accounts on the same platform with the same name, KhipuChat shall report a duplicate-name validation error identifying the platform and conflicting name, and shall refuse to proceed.
- If an account name is an empty string, KhipuChat shall report a validation error and refuse to proceed.
- KhipuChat shall treat account names as case-sensitive for all identity comparisons.

**1.4 WeChat single-account exclusion**

- Where WeChat appears in `khipu.config.json`, KhipuChat shall not accept a list of named accounts for WeChat and shall continue to use its existing single local-DB integration.
- If an operator attempts to define more than one WeChat account in `khipu.config.json`, KhipuChat shall report a configuration error stating that WeChat does not support multiple accounts.

**1.5 Account enumeration**

- When a downstream consumer (CLI, sync runner) requests the list of configured accounts for a given platform, KhipuChat shall return the ordered list of account names as defined in `khipu.config.json`.

---

### 2. Database Schema and Migration

The archive database shall carry an `account` dimension on chat and sync-state records so that data from different accounts on the same platform cannot collide.

**2.1 Account column on chats**

- The system shall associate every chat row with an account name.
- When KhipuChat starts against an existing database that has no account column on the chats table, KhipuChat shall add the account dimension and set its value to `"default"` for all existing rows without discarding any data.
- Two chats from different accounts on the same platform may share the same external chat identifier without causing a uniqueness conflict.

**2.2 Per-account sync state**

- KhipuChat shall track the last-synced timestamp independently for each `(platform, account)` pair.
- When KhipuChat starts against an existing database where sync state is keyed by platform alone, KhipuChat shall extend the sync-state tracking to cover per-account progress and set the account to `"default"` for all existing rows without discarding any data.

---

### 3. Platform Adapter Account Awareness

Each sync operation shall be scoped to a specific account and shall use that account's resolved credentials.

**3.1 Per-account sync iteration**

- When KhipuChat runs sync for a platform that has multiple configured accounts, KhipuChat shall run a full sync cycle (backfill or incremental, as applicable) for each account in sequence.
- When syncing an account, KhipuChat shall store all retrieved chats and messages under that account's identity.
- If the sync for one account fails, KhipuChat shall record the error for that account, then continue syncing the remaining accounts on that platform.

**3.2 Credential isolation**

- When syncing an account, KhipuChat shall use only the credentials defined for that specific account and shall not mix credentials across accounts on the same platform.
- When a platform has no accounts defined in `khipu.config.json`, KhipuChat shall use legacy env-var credentials and attribute the sync result to the `"default"` account.

**3.3 Per-account incremental sync state**

- When KhipuChat runs incremental sync for a `(platform, account)` pair, it shall read the last-synced timestamp for that specific pair and update it upon successful completion.
- When an account is synced for the first time (no prior sync-state entry), KhipuChat shall perform a full backfill for that account.

---

### 4. MCP Query Surface

MCP tools shall accept an optional account filter and shall include account identity in all result objects.

**4.1 Account filter on list and search tools**

- When a caller passes an `account` parameter to `list_chats`, KhipuChat MCP server shall return only chats that belong to that account; when `account` is omitted, the server shall return chats from all accounts.
- When a caller passes an `account` parameter to `list_messages`, KhipuChat MCP server shall return only messages belonging to chats in that account; when `account` is omitted, the server shall return messages from all accounts.
- When `search_messages` is called with an `account` parameter, KhipuChat MCP server shall restrict full-text search results to that account; when `account` is omitted, search shall span all accounts.
- When semantic search tools are called with an `account` parameter, KhipuChat MCP server shall restrict similarity results to that account; when `account` is omitted, search shall span all accounts.

**4.2 Account field in results**

- The system shall include an `account` field in every chat object returned by MCP list and find tools.
- The system shall include an `account` field in every message object returned by MCP list and search tools.

---

### 5. CLI Query Surface

CLI commands that list or search shall support an `--account` option that matches the filtering behavior of the MCP surface.

**5.1 Account filter on CLI list and search**

- When the operator passes `--account <name>` to the list-chats command, KhipuChat CLI shall return only chats belonging to that account.
- When the operator passes `--account <name>` to the search command, KhipuChat CLI shall return only messages belonging to that account.
- When `--account` is omitted, the CLI shall return results spanning all accounts.
- When results from more than one account are present in CLI output, KhipuChat CLI shall display the account name alongside the platform name for each result.

---

### 6. Web UI Account Disambiguation

**6.1 Account label in chat list**

- When the archive contains chats from more than one account on the same platform, the Web UI shall display the account name alongside the platform indicator for each affected chat.
- When only one account exists per platform in the archive, the Web UI shall not display account labels for that platform.
- The Web UI shall provide a filter control that lets the user narrow the chat list to a single account.

---

### 7. Scope Boundaries

**Included in this spec:**
- `khipu.config.json` schema, loader, env-var reference resolution, and validation.
- Database migration: account dimension on chats, per-account sync state, backfill of existing rows.
- Platform adapter contract: adapters iterate over configured accounts using resolved credentials.
- Account filter and account field on all three surfaces: MCP (primary), CLI (secondary), Web UI (secondary).
- WeChat single-account exclusion with operator-visible error.

**Not included (adjacent, not owned here):**
- CLI syntax for targeting an account during sync (e.g., `khipu sync slack@work`) — owned by `khipu-cli`; this spec provides the account enumeration it calls.
- Credential acquisition flows beyond passing per-account credentials to adapters (no OAuth, no QR pairing).
- Semantic-search embedding pipeline internals — embeddings must continue to function correctly across accounts but the pipeline is not modified here.
- New platform integrations.
