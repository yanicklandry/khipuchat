# Research Log: sync-account-routing

## Discovery Scope
Extension / integration-focused (light) discovery. This is a precise bug-fix that wires an already-built multi-account foundation into six existing entrypoints and one daemon gate. No external dependencies; all investigation is codebase-local.

## Key Findings

### Finding 1: The bug is confirmed identical in all six env-based entrypoints
Each `src/platforms/<p>/sync.ts` exports an account-aware factory (`createXAdapter(account, credentials)`) AND a hardcoded module-level singleton (`xAdapter = createXAdapter('default', {VAR: process.env['VAR']})`). Each `main()` calls `runPlatformSync(xAdapter, db, process.argv)` — it never reads `--account`.
- `slack/sync.ts:115-123`, `discord/sync.ts:150-158`, `email/sync.ts:130-142`, `whatsapp/sync.ts:172-180`, `facebook/sync.ts:165-173`: same shape, small `main()`.
- `telegram/sync.ts:333-393`: same core bug (`runPlatformSync(telegramAdapter, ...)` at line 378) but `main()` also runs an interactive auth wizard (lines 363-367) and a persistent `startListener` loop (lines 385-388). File is already 393 lines (> 200 target).

### Finding 2: `resolveCommand` already spawns `--account` correctly
`src/khipu.ts:160-188` handles `sync <platform>@<account>`: it validates the account against `deps.listAccounts(platform)` and spawns `platforms/<platform>/sync.ts` with `args: ['--account', account, ...rest]`. The bare `sync <platform>` form (lines 190-196) spawns with no account flag. The child receives these in `process.argv`. No change needed here — the defect is purely downstream in the entrypoints.

### Finding 3: `runAllAccountsSync` is built, tested, and unused in production
`src/sync-runner.ts:67-90` implements `runAllAccountsSync(platform, factory, db, argv, registry = loadRegistry())` — loops `registry.listAccounts(platform)`, builds each adapter from `credentialsFor`, calls `runPlatformSync`, and collects per-account `AccountSyncOutcome` (never throws on a single account failure). It is unit-tested in `tests/sync-runner.test.ts:295+` but not called from any `src/` entrypoint. This is exactly the no-`--account` path.

### Finding 4: `watch.ts isConfigured()` double-gates and misses config-only accounts
`src/watch.ts:50-55` `isConfigured(platform)` returns true only for local-only platforms or when a `REQUIRED_ENV_VARS[platform]` legacy var is set. `main()` (lines 138-154) checks `isConfigured` FIRST, then separately checks `registry.listAccounts(platform).length === 0`. So a platform whose accounts exist only in `khipu.config.json` with custom `$VAR` names fails the `isConfigured` gate and is skipped before the registry is ever consulted. Fix: make `isConfigured` registry-aware.

### Finding 5: Registry legacy fallback semantics (no-regression anchor)
`src/account-registry.ts:147-182` `loadRegistry`: when `khipu.config.json` is absent or empty, `buildLegacyAccounts` returns a single `default` account per platform — local-only platforms always, env-based platforms only if at least one legacy var is set. So `runAllAccountsSync` on a legacy install naturally yields `[default]` (or `[]` when no vars set). This means the no-`--account` path can route through `runAllAccountsSync` uniformly and still reproduce legacy single-account behavior — no separate legacy branch is required for the five simple platforms.

### Finding 6: `slackAdapter` singleton has an external test dependency
`tests/adapter-factory.test.ts:5,81-129` imports and asserts on the `slackAdapter` legacy singleton (`account === 'default'`, `platform === 'slack'`). Therefore the exported singletons must be preserved even though `main()` will stop using them. The `discordAdapter`/`telegramAdapter` names in `tests/watch.test.ts:300,306` are local test doubles, not imports of the module singletons.

## Design Decisions

- **Centralize routing in `sync-runner.ts`** as `runSyncEntrypoint(platform, factory, db, argv, registry?)` plus a small `parseAccountArg(argv)` helper. This is the single generalization of the "repeated 6×, identical shape" boundary candidate. Keeps each simple `main()` at ~2 lines and adds ~25 lines to the 90-line `sync-runner.ts` (well within budget).
- **No-`--account` routes through `runAllAccountsSync`** for all six platforms. Legacy single-account installs get `[default]` automatically (Finding 5), so Requirement 3 is satisfied without a bespoke legacy branch for the five simple platforms.
- **Preserve exported singletons** (Finding 6) — do not delete them; just stop calling them from `main()`.
- **Telegram is a scoped exception**: route the synced adapter through `runSyncEntrypoint` so `--account` is honored and the no-account path syncs all configured accounts, but keep the first-run auth-wizard and persistent-listener behavior for the legacy default account (no config file / default account) to avoid regressing `npm run sync:telegram`. Add the minimum lines necessary given the file is already oversized.

## Synthesis Outcomes
- **Generalization found**: 5 of 6 entrypoints collapse to one shared helper call; telegram reuses the same helper for its sync phase.
- **Build-vs-adopt**: Adopt existing `runAllAccountsSync` and `loadRegistry`/`credentialsFor`; build only the thin `runSyncEntrypoint` + `parseAccountArg` seam and the `isConfigured` registry check.
- **Simplification**: The daemon's `main()` redundant double-gate is resolved by folding registry-awareness into `isConfigured`; the separate `accounts.length === 0` check can remain as a harmless guard or be simplified, but is not required to change.

## Risks
- **Telegram listener regression**: changing telegram `main()` risks breaking the auth wizard or listener. Mitigation: keep those branches intact; only swap the hardcoded adapter for routed resolution and gate wizard/listener to the legacy default path.
- **Argv coupling**: `parseAccountArg` must tolerate the full spawned argv (`node script --account work --force`). Mitigation: scan for the `--account` token and take the following token; ignore unrelated flags (mirrors `parseSyncArgs`).
