# Requirements Document

## Introduction

The one-shot debug sync command `khipu sync <platform>[@<account>]` silently syncs the wrong account. `src/khipu.ts resolveCommand` validates the requested account and spawns the platform entrypoint with `--account <name>` (for example `src/platforms/slack/sync.ts --account personal`), but every env-based platform `main()` ignores `process.argv` and runs a hardcoded module-level adapter (`createSlackAdapter('default', { SLACK_USER_TOKEN: process.env['SLACK_USER_TOKEN'] })`). The result is data pulled with the wrong credentials and mislabeled `account='default'`.

The same class of defect is confirmed in all six env-based platform entrypoints: `slack`, `discord`, `email`, `whatsapp`, `telegram`, and `facebook`. A second, related defect lives in the daemon path: `src/watch.ts isConfigured()` gates each platform on legacy environment variables only, so a platform whose accounts are defined purely in `khipu.config.json` (with custom `$VAR` names) is treated as unconfigured and skipped.

The multi-account foundation already exists and is not changed by this spec: `src/account-registry.ts` (`loadRegistry`, `listAccounts`, `credentialsFor`, legacy fallback), `src/sync-runner.ts` (`runPlatformSync`, and the built-but-unused `runAllAccountsSync`), and the account-aware adapter factories. This spec wires that foundation into the one-shot entrypoints and makes the daemon registry-aware, closing the last production gap of the multi-account feature without regressing legacy single-account installs.

## Boundary Context
- **In scope**: The `main()` account-resolution logic of the six env-based platform sync entrypoints (`src/platforms/{slack,discord,email,whatsapp,telegram,facebook}/sync.ts`); a shared account-routing helper in `src/sync-runner.ts`; registry-awareness in `src/watch.ts isConfigured()`; routing tests.
- **Out of scope**: Adapter internals and factories (already account-aware), the account-registry parser (already implemented by the multi-account spec), the `signal` entrypoint (not in the six named env-based platforms), the CLI resolver in `src/khipu.ts` (already spawns `--account` correctly), the daemon per-account loop in `watch.ts main()` (already correct), and any database schema change.
- **Adjacent expectations**: Depends on `runPlatformSync`/`runAllAccountsSync` preserving their current per-`(platform, account)` `sync_state` and labeling behavior; depends on `resolveCommand` continuing to pass `--account <name>` for the `@account` form and no account flag for the bare-platform form.

## Requirements

### Requirement 1: Single-account one-shot routing
**Objective:** As an operator debugging a specific account, I want `khipu sync <platform>@<account>` to sync exactly that account with its registry-resolved credentials, so that the archived data uses the correct token and is labeled with the correct account.

#### Acceptance Criteria
1. When a platform entrypoint's `main()` is invoked with `--account <name>` in `process.argv`, the system shall load the account registry, resolve credentials for `(platform, name)` via `credentialsFor`, construct the adapter for that account via the platform factory, and run the sync through `runPlatformSync`.
2. When the resolved adapter runs, the system shall label all persisted chats and messages with `account` equal to the requested `<name>` (not `default`).
3. When `--account <name>` is supplied and the account uses a custom `$VAR` credential field defined in `khipu.config.json`, the system shall sync using the value resolved from that variable rather than any legacy environment variable.
4. If `--account <name>` names an account that is not present in the registry for that platform, then the system shall fail with a non-zero exit code and an error message identifying the platform and account, and shall not sync the `default` account as a fallback.
5. Where a `--force` (or legacy `--backfill`) flag accompanies `--account`, the system shall forward that flag to `runPlatformSync` for the resolved account unchanged.

### Requirement 2: All-accounts one-shot routing
**Objective:** As an operator, I want `khipu sync <platform>` with no `@account` to sync every configured account for that platform, so that a single command refreshes all accounts of a platform on demand.

#### Acceptance Criteria
1. When a platform entrypoint's `main()` is invoked with no `--account` argument and `khipu.config.json` defines one or more accounts for that platform, the system shall sync every listed account by delegating to `runAllAccountsSync(platform, factory, db, argv)`.
2. When `runAllAccountsSync` runs across multiple accounts and one account fails, the system shall continue syncing the remaining accounts and shall not abort the whole run on a single account failure.
3. While iterating configured accounts, the system shall construct each account's adapter from its own registry-resolved credentials and label persisted data with that account's name.
4. Where a `--force`/`--backfill` flag is supplied without `--account`, the system shall forward that flag to each account's `runPlatformSync` invocation.

### Requirement 3: Legacy single-account fallback (no regression)
**Objective:** As an existing single-account user with no `khipu.config.json`, I want `khipu sync <platform>` to keep working exactly as before, so that upgrading to this fix introduces no behavior change for my install.

#### Acceptance Criteria
1. When no `khipu.config.json` file is present and a platform entrypoint's `main()` runs with no `--account`, the system shall sync the legacy `default` account resolved from the platform's legacy environment variables.
2. When the legacy `default` account is synced, the system shall label persisted chats and messages with `account='default'`, preserving the pre-fix data shape.
3. If a required legacy credential is absent for the `default` account, then the system shall emit the platform's existing missing-credential message and exit non-zero, matching current behavior.
4. The system shall preserve the existing exported module-level singleton adapters (for example `slackAdapter`) that legacy tests depend on, without requiring `main()` to use them.

### Requirement 4: Daemon registry-aware configuration gate
**Objective:** As an operator running the sync daemon, I want `khipu sync all` to poll platforms whose accounts are defined only in `khipu.config.json`, so that config-file-only accounts are not silently skipped.

#### Acceptance Criteria
1. When `isConfigured(platform)` is evaluated for a platform that has one or more accounts in the registry, the system shall return `true` even if none of that platform's legacy environment variables are set.
2. When `isConfigured(platform)` is evaluated for a platform with legacy environment variables present, the system shall continue to return `true` as it does today.
3. When `isConfigured(platform)` is evaluated for a local-only platform (`imessage`, `whatsapp`), the system shall return `true` as it does today.
4. If a platform has neither legacy environment variables nor any registry account, then `isConfigured(platform)` shall return `false` so the daemon skips it with the existing "not configured" log.

### Requirement 5: Cross-platform consistency
**Objective:** As a maintainer, I want the account-routing fix applied uniformly across all six env-based platform entrypoints, so that no platform retains the hardcoded-`default` bug and the routing logic is not duplicated inconsistently.

#### Acceptance Criteria
1. The system shall apply single-account and all-accounts routing (Requirements 1 and 2) to each of the six env-based entrypoints: `slack`, `discord`, `email`, `whatsapp`, `telegram`, and `facebook`.
2. Where account-routing logic is identical across entrypoints, the system shall centralize it in a single shared helper in `src/sync-runner.ts` rather than re-implementing it per platform.
3. Where the `telegram` entrypoint has additional lifecycle behavior (first-run auth wizard and persistent listener), the system shall honor `--account` for the synced adapter while preserving that entrypoint's legacy default-account auth-wizard and listener behavior.
4. The system shall keep each modified source file within the project's 200-line target where the file was already compliant, and shall not increase the size of the already-oversized `telegram/sync.ts` beyond what the routing change strictly requires.

### Requirement 6: Verifiable routing behavior
**Objective:** As a maintainer, I want automated tests proving that `<platform>@<account>` resolves the right credentials and label, so that the fix is guarded against regression.

#### Acceptance Criteria
1. The system shall include a test asserting that invoking the shared routing helper with `--account work` resolves the `work` account's credentials and runs `runPlatformSync` on an adapter whose `account` is `work`.
2. The system shall include a test asserting that invoking the shared routing helper with no `--account` delegates to `runAllAccountsSync` across all registry accounts.
3. The system shall include a test asserting that `isConfigured(platform)` returns `true` for a platform that has registry accounts but no legacy environment variables, and `false` when it has neither.
4. When the full test suite is run, the system shall pass all pre-existing tests (including `tests/adapter-factory.test.ts` legacy-singleton assertions and `tests/watch.test.ts`) alongside the new routing tests.
