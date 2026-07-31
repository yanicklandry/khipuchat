# Backlog notes

Issues added to the tukuy queue backlog on 2026-07-16 after a full-project status review.
All 19 feature specs are implemented and 868/868 tests pass under the pinned Node 24
(`.nvmrc` = 24). These two items are the only genuine remaining engineering issues found.

## RESOLVED 2026-07-30

Both items below are fixed. `npm run typecheck` now passes clean (exit 0) and
868/868 tests still pass.

- **node-engines-pin** — added `"engines": { "node": ">=24 <25" }` to package.json.
- **tsconfig-typecheck-fix** — removed the `rootDir`/`outDir` from tsconfig.json
  (nothing does a `tsc` emit build; everything runs via `tsx`), added `"noEmit": true`,
  and added a `"typecheck": "tsc --noEmit"` npm script.

**Correction to the original note:** the claim below of "zero real type errors, all
TS6059" was wrong. Once the TS6059 noise was cleared, `tsc` surfaced **59 genuine
pre-existing type errors** (masked because tsc never completed and `tsx` skips type
checking): 17 in `src/` + 42 in `tests/`. All 59 were fixed. Notably this included a
real latent bug in `src/platforms/email/sync.ts` — `Array.from(seenChats)` on a
`Map<string,number>` produced `[string,number][]` entries instead of the numeric chat
IDs passed to `embedNewMessages`/`embedNewChats`; fixed to `Array.from(seenChats.values())`.
The rest were library-boundary casts (telegram gramjs types, transformers pipeline
output) and test-mock shape mismatches (missing `startListener`, widened `process.exit`
mock signatures, etc.).

## tsconfig-typecheck-fix

**Problem:** `tsc --noEmit` fails with 43 `TS6059` errors ("File ... is not under rootDir 'src'").
`tsconfig.json` sets `"rootDir": "src"` but `"include": ["src/**/*", "tests/**/*"]`, so every
file under `tests/` is a hard error. There is also no `typecheck` npm script, so the breakage
is never surfaced by CI or local runs (everything runs through `tsx`, which ignores rootDir).

**Fix direction:**
- Exclude `tests/**` from the build tsconfig (or drop `rootDir`, or add a separate
  `tsconfig.test.json` that extends the base with no `rootDir`).
- Add `"typecheck": "tsc --noEmit"` to package.json scripts and wire it into CI.

**Evidence:** `node_modules/.bin/tsc --noEmit` => 43 errors, all `TS6059`, zero real type errors.

## node-engines-pin

**Problem:** The native module `better-sqlite3-multiple-ciphers` is compiled per Node ABI.
`.nvmrc` pins Node 24 (ABI 137), but `package.json` has no `engines` field. Running the test
suite / CLI under any other Node (e.g. the machine default Node 26, ABI 147) fails with
`ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. Nothing enforces the Node version.

**Fix direction:**
- Add `"engines": { "node": ">=24 <25" }` to package.json.
- Optionally add a `postinstall` note / preflight check that rebuilds the native module if the
  running ABI does not match, and document `nvm use` in the README setup section.

**Evidence:** Full suite under Node 22 => 453 failures (all `NODE_MODULE_VERSION 137 vs 127`).
Under Node 24 on PATH => 868/868 pass.

## Non-issue (bookkeeping only, no action needed for code)

6 specs still have unchecked `- [ ]` boxes in their `tasks.md` even though the deliverables
exist and tests pass: image-support, release, signal-platform, web-ui-enhancements,
telegram-image-sync, sync-watcher. These are stale checkboxes, not missing work
(e.g. `src/watch.ts`, `src/platforms/signal/sync.ts`, `src/web/ui-chats.ts` all present;
`src/web/ui.ts` is 177 lines, under the 200-line target).
