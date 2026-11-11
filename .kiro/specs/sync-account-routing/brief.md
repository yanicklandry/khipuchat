# Brief: sync-account-routing

## Problem
`khipu sync <platform>@<account>` (the one-shot, single-account debug command) silently syncs the wrong account. `khipu.ts` validates the account and spawns e.g. `src/platforms/slack/sync.ts --account personal`, but the platform `main()` ignores `process.argv` and runs a module-level adapter hardwired to `createSlackAdapter('default', { SLACK_USER_TOKEN: process.env['SLACK_USER_TOKEN'] })`. Result: `khipu sync slack@personal` uses whatever `SLACK_USER_TOKEN` points at and labels the data `account='default'` — wrong token, wrong label. This is the concrete "Slack multi-account" gap, and it is identical across all six env-based platforms (slack, discord, email, whatsapp, telegram, facebook).

## Current State
Multi-account is otherwise fully built: `src/account-registry.ts` parses `khipu.config.json`, resolves `$VAR` fields, exposes `listAccounts(platform)` / `credentialsFor(platform, account)`, and falls back to a single legacy `default` account when no config exists. The daemon path (`khipu sync all` => `src/watch.ts`) already loops `for (const account of registry.listAccounts(platform))` and syncs every configured account correctly. `src/sync-runner.ts` has `runAllAccountsSync()` — built and unit-tested but never called from any `src/` entrypoint (dead in production). The adapter factories are already account-aware.

Two defects:
1. **One-shot entrypoints ignore `--account`** (`src/platforms/*/sync.ts` `main()`), using a hardcoded `default` adapter.
2. **`watch.ts isConfigured()`** gates each platform only on the legacy env var (e.g. `SLACK_USER_TOKEN`). Accounts defined purely in `khipu.config.json` with custom var names (`$SLACK_WORK_TOKEN`) make `isConfigured('slack')` return false, so the daemon skips the platform despite valid config.

## Desired Outcome
- `khipu sync slack@work` syncs exactly the `work` account with its registry-resolved token, labeled `account='work'`. Same for all six env-based platforms.
- `khipu sync slack` (no `@account`) syncs every configured account for that platform (via the existing `runAllAccountsSync`), or the legacy `default` when no config file exists.
- `watch.ts` treats a platform as configured when it has legacy env vars **or** ≥1 registry account.

## Approach
In each `src/platforms/<p>/sync.ts` `main()`, replace the hardcoded module-level adapter with: parse `--account` from argv; `loadRegistry()`; `credentialsFor(platform, account)`; `createXAdapter(account, credentials)`; `runPlatformSync(adapter, db, argv)`. When `--account` is omitted, call the existing `runAllAccountsSync(platform, createXAdapter, db, argv)`. Fix `watch.ts isConfigured()` to also return true when `registry.listAccounts(platform).length > 0`. Add a routing test asserting `slack@work` resolves the `work` token and account label (extend `tests/sync-runner.test.ts` / a new routing test).

## Scope
- **In**: the six env-based platform `sync.ts` entrypoints, `watch.ts isConfigured()`, wiring `runAllAccountsSync` into the no-account one-shot path, tests.
- **Out**: adapter internals (already account-aware), the registry parser (done), Beeper-based platforms whose account model differs (signal/facebook already route via Beeper token — include only if their `main()` shares the same hardcoded-default bug), schema changes.

## Boundary Candidates
- Per-platform entrypoint account resolution (repeated 6×, identical shape).
- Daemon `isConfigured()` registry-awareness.
- One-shot "all accounts vs single account" dispatch.

## Out of Boundary
- Multi-account schema / registry format (already implemented by multi-account spec).
- Adapter sync logic.

## Upstream / Downstream
- **Upstream**: `account-registry.ts`, `sync-runner.ts` (`runPlatformSync`, `runAllAccountsSync`), `khipu.ts` (`resolveCommand`), `watch.ts`.
- **Downstream**: correct per-account labeling flows into all query surfaces (MCP/CLI/web `account` filter).

## Existing Spec Touchpoints
- **Extends**: multi-account (closes its last production gap), khipu-cli (the `sync <platform>@<account>` command contract).
- **Adjacent**: sync-watcher (daemon path — already correct, only `isConfigured` changes).

## Constraints
- Node 24, TS strict, files under 200 lines, synchronous DB.
- Preserve legacy single-account behavior when `khipu.config.json` is absent (no regression for existing users).
