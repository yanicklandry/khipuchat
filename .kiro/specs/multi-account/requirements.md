# Requirements Document

## Project Description (Input)
KhipuChat currently assumes a single account per platform (one credential set per platform via `.env`). Real users run multiple Slack workspaces and often more than one Telegram or WhatsApp account, so there is currently no way to archive more than one account per platform.

This feature introduces a `khipu.config.json` account registry that lets an operator define any number of named accounts per platform, each with its own credential fields (secret values may reference env vars). It adds an `account` dimension to the database schema, migrates existing single-account data to `"default"`, re-keys `sync_state` by `(platform, account)`, and makes every adapter iterate over its configured accounts. All three query surfaces (MCP, CLI, Web UI) expose account identity for filtering and disambiguation. WeChat is explicitly excluded and remains single-account by design.

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
