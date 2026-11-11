# Implementation Plan

- [x] 1. Add shared account-routing helper to `src/sync-runner.ts`
- [x] 1.1 Implement `parseAccountArg` and `runSyncEntrypoint`
  - Add `parseAccountArg(argv: readonly string[]): string | null` that returns the token following `--account` (or `null` when the flag is absent), ignoring unrelated flags such as `--force`/`--backfill`.
  - Add `runSyncEntrypoint(platform, factory, db, argv, registry = loadRegistry()): Promise<AccountSyncOutcome[]>` that, when an account is named, calls `credentialsFor(platform, account)`, builds `factory(account, creds)`, runs `runPlatformSync`, and returns `[{ account, ok: true }]`; otherwise delegates to `runAllAccountsSync(platform, factory, db, argv, registry)`.
  - Do not add a `default` fallback for a named-but-missing account: let `credentialsFor` throw and propagate.
  - Observable: `runSyncEntrypoint` is exported from `src/sync-runner.ts` and `tsc`/`tsx` loads it with no type errors; `sync-runner.ts` stays under 200 lines.
  - _Requirements: 1.1, 1.4, 1.5, 2.1, 2.4, 5.2_
  - _Boundary: sync-runner_
- [x] 1.2 Unit-test the routing helper
  - Test `parseAccountArg`: value after `--account`, `null` when absent, and correct handling when `--force` surrounds the flag.
  - Test `runSyncEntrypoint` named-account path with a fake registry (reuse `makeRegistry` in `tests/sync-runner.test.ts`): exactly one `runPlatformSync` runs on an adapter whose `account === 'work'` using the `work` credentials.
  - Test no-account path delegates to `runAllAccountsSync` across all registry accounts.
  - Test named-but-missing account rejects and never runs a `default` sync.
  - Observable: new tests appear in `tests/sync-runner.test.ts` and pass under `npm test`.
  - _Requirements: 1.2, 1.4, 2.1, 6.1, 6.2_
  - _Boundary: sync-runner_
  - _Depends: 1.1_

- [x] 2. Wire the five simple env-based entrypoints
- [x] 2.1 Route `slack`, `discord`, `email`, `whatsapp`, `facebook` `main()` through `runSyncEntrypoint` (P)
  - In each `src/platforms/<p>/sync.ts`, replace `runPlatformSync(<p>Adapter, db, process.argv)` in `main()` with `runSyncEntrypoint('<p>', create<P>Adapter, db, process.argv)`.
  - Keep each exported module-level singleton (`slackAdapter`, `discordAdapter`, `emailAdapter`, `whatsappAdapter`, `facebookAdapter`) so legacy tests still resolve them.
  - Observable: `khipu sync slack@<account>` (and the other four) resolves the named account's credentials and labels persisted data with that account; `khipu sync slack` with no config syncs the legacy `default`; each file stays under 200 lines.
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 3.1, 3.2, 3.4, 5.1_
  - _Boundary: platform-entrypoints_
  - _Depends: 1.1_

- [x] 3. Wire the telegram entrypoint (scoped exception)
- [x] 3.1 Honor `--account` in `telegram` `main()` while preserving wizard + listener
  - Parse the account via `parseAccountArg(process.argv)`. When an account is named: sync it through `runSyncEntrypoint('telegram', createTelegramAdapter, db, process.argv)` (adapter connects with that account's session/api fields), run `terminateOcr()`, and exit without the auth wizard or persistent listener.
  - When no account is named: preserve legacy default behavior — run the auth wizard only when `config.sessionString` is empty, sync via `runSyncEntrypoint('telegram', createTelegramAdapter, db, process.argv)`, then keep the existing `startListener` loop for the default account unless `--backfill-only` is set.
  - Add the minimum lines required; the file is already over the 200-line target so avoid unrelated growth.
  - Observable: `khipu sync telegram@<account>` syncs that account and exits; `khipu sync telegram` with no config still runs the wizard/listener default path as before.
  - _Requirements: 1.1, 1.2, 3.1, 5.1, 5.3, 5.4_
  - _Boundary: platform-entrypoints_
  - _Depends: 1.1_

- [x] 4. Make the daemon configuration gate registry-aware
- [x] 4.1 Update `isConfigured` in `src/watch.ts`
  - Change the signature to `isConfigured(platform, registry = loadRegistry())` and return `true` when any legacy `REQUIRED_ENV_VARS[platform]` is set OR `registry.listAccounts(platform).length > 0`, keeping the local-only short-circuit and the `false` default.
  - Update the single call site in `main()` (`if (!isConfigured(platform))`) to pass the already-loaded `registry`; leave the per-account loop otherwise unchanged.
  - Observable: a platform with accounts defined only in `khipu.config.json` (custom `$VAR` names, no legacy env var) is no longer skipped by `khipu sync all`.
  - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - _Boundary: watch_
- [x] 4.2 Test registry-aware `isConfigured`
  - Add tests to `tests/watch.test.ts`: `isConfigured` returns `true` for a platform with registry accounts but no legacy env var, `false` when it has neither, and preserves `true` for legacy-var and local-only platforms.
  - Observable: new `isConfigured` cases pass and existing `watch.test.ts` cases still pass.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 6.3_
  - _Boundary: watch_
  - _Depends: 4.1_

- [x] 5. Full-suite validation
- [x] 5.1 Run the complete test suite and confirm no regressions
  - Run `npm test` under Node 24 and confirm all pre-existing tests pass, specifically `tests/adapter-factory.test.ts` (legacy `slackAdapter` singleton) and `tests/watch.test.ts`, alongside the new routing and `isConfigured` tests.
  - Observable: `npm test` exits 0 with the new tests included and zero failures.
  - _Requirements: 3.4, 5.1, 6.4_
  - _Depends: 1.2, 2.1, 3.1, 4.2_

## Implementation Notes

- `runSyncEntrypoint` is a thin dispatcher: named `--account` => resolve via `registry.credentialsFor` + `factory(account, creds)` + `runPlatformSync` (returns `[{ account, ok: true }]`); no account => delegate to existing `runAllAccountsSync`. `parseAccountArg` uses `argv.indexOf('--account')` and returns `argv[idx+1] ?? null` (null when the flag is last with no value). `sync-runner.ts` ended at 126 lines.
- The five simple entrypoints (slack/discord/email/whatsapp/facebook) became two-line `main()` bodies calling `runSyncEntrypoint('<p>', create<P>Adapter, db, process.argv)`. The `runPlatformSync` import was swapped for `runSyncEntrypoint` in each. Module-level singletons (`slackAdapter`, etc.) are still exported for the legacy `adapter-factory.test.ts` assertions but are no longer used by `main()`.
- Telegram (scoped exception): `main()` now parses the account first. Named-account path syncs via `runSyncEntrypoint` then `terminateOcr()` and returns early — no auth wizard, no persistent listener. The no-account path is unchanged legacy behavior (wizard when `config.sessionString` empty, sync, then `startListener` unless `--backfill-only`), except the sync call is `runSyncEntrypoint` instead of `runPlatformSync(telegramAdapter, ...)`. File grew 393 => 403 lines (+10, minimal).
  - Note: legacy telegram accounts from `buildLegacyAccounts` carry only `TELEGRAM_API_ID/HASH/PHONE_NUMBER` (not `TELEGRAM_SESSION_STRING`), so the fresh adapter's `credentials.fields['TELEGRAM_SESSION_STRING']` is `undefined` and correctly falls back to `config.sessionString` — which `saveSessionString` mutates after the wizard runs.
- `watch.ts isConfigured` gained a `registry = loadRegistry()` param and now returns `true` when a legacy env var is set OR `registry.listAccounts(platform).length > 0`. Local-only short-circuit preserved. The single call site in `main()` passes the already-loaded `registry` (no second load). The pre-existing `accounts.length === 0` guard below it is left intact (harmless).
- Out of scope and untouched as designed: `imessage`/`signal` entrypoints still call `runPlatformSync` directly (not among the six env-based platforms); `account-registry.ts`, `khipu.ts resolveCommand`, adapters, and schema unchanged.
- Full suite: 45 files, 985 tests, all passing under Node 24. No `tsc` gating (known-broken).
