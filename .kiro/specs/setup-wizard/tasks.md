# Implementation Plan

- [ ] 1. Foundation: single-source variable table
- [ ] 1.1 Define the declarative variable table inside the bash engine
  - Scaffold the setup-env bash engine and add a `var_table` function that emits one
    pipe-delimited record (`key|platform|required|url|example|click_path`) per recognised
    variable: the three Telegram vars, Discord, Slack, the three Email/IMAP vars, Beeper, and the
    four optional security vars.
  - Carry the verified acquisition URL, click-path, and example for each variable exactly as
    specified in the design (Telegram my.telegram.org/apps; Discord developer portal; Slack
    api.slack.com/apps; Beeper Settings > Integrations > Approved connections; Gmail app password).
  - Mark each record required (`1`) or optional (`0`); exclude `TELEGRAM_SESSION_STRING` from the
    table (auto-managed, never prompted).
  - Use only bash 3.2 constructs (no associative arrays, no `mapfile`); records parsed with
    `while IFS='|' read -r`.
  - Observable completion: running the engine in a table-dump/debug mode prints all 13 records,
    each showing its platform, URL, click-path, and example.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 6.1, 9.2_

- [ ] 2. Core: detection, prompting, merge, docs, and wrapper
- [ ] 2.1 Detect missing/empty variables and skip configured or managed ones
  - Read the target env file (honoring a `SETUP_ENV_FILE` override, default `.env`) and classify
    each recognised key as configured (present with a non-empty value) or missing/empty.
  - Iterate the variable table, skipping configured keys and never prompting for
    `TELEGRAM_SESSION_STRING`; proceed as all-unset when no env file exists.
  - Observable completion: with a fixture `.env` where `TELEGRAM_API_ID` is set, that key is
    reported already-configured and not prompted, while an empty/absent key is queued for a prompt.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - _Depends: 1.1_

- [ ] 2.2 Render required and optional prompts with acquisition guidance and skip affordance
  - For each queued required variable, display the platform, concrete URL, step-by-step click-path,
    and example, then read one line of input; for optional variables, additionally label the prompt
    optional and state that pressing Enter skips it.
  - Accept the entered value as-is with no validation and no network call.
  - Observable completion: the prompt for `DISCORD_TOKEN` shows the Discord developer-portal URL and
    click-path, and the prompt for `DB_KEY` is labelled optional with an explicit Enter-to-skip note.
  - _Requirements: 3.1, 4.1, 4.3, 4.4_
  - _Depends: 1.1_

- [ ] 2.3 Merge answers into the env file idempotently and non-destructively
  - Append answered keys that are absent; fill answered keys that exist with an empty value in place;
    copy every populated key, comment, and blank line verbatim and preserve ordering by rewriting
    through a temp file and moving it over the original only on full success.
  - Treat an empty answer as a skip that leaves the file unchanged for that variable; write values
    with `printf '%s'`; make no outbound network call.
  - Print a closing summary listing which variables were written, skipped, and already-configured.
  - Observable completion: a fixture with `DISCORD_TOKEN=` (empty) plus surrounding comments gets the
    value filled in place with all comments/blank lines/order preserved, and the summary is printed;
    re-running with no input makes zero changes.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.3_
  - _Depends: 2.1_

- [ ] 2.4 Render docs/TOKENS.md from the same variable table
  - Add an `--emit-docs` mode that iterates the identical `var_table` records and writes
    grouped-by-platform markdown (honoring a `SETUP_ENV_DOCS` override, default `docs/TOKENS.md`),
    including each variable's URL, click-path, example, and required/optional status plus the
    `TELEGRAM_SESSION_STRING` auto-managed note.
  - Observable completion: running `--emit-docs` to a temp path produces markdown containing every
    recognised key with its URL and click-path, covering Telegram, Discord, Slack, Email/IMAP,
    Beeper, and the optional security vars.
  - _Requirements: 6.2, 6.3, 7.1, 7.2, 7.3_
  - _Depends: 1.1_

- [ ] 2.5 (P) Add the TypeScript wrapper that spawns the bash engine
  - Create the `setup-env` wrapper that resolves the project root and script path and spawns
    `/bin/bash scripts/setup-env.sh` with inherited stdio and the project root as cwd, propagating
    the child's exit code via `process.exit`.
  - Observable completion: invoking the wrapper launches the interactive engine and the process exit
    code equals the engine's exit code (success on clean exit, non-zero on failure).
  - _Requirements: 1.1, 1.3, 1.4_
  - _Boundary: setup-env wrapper_

- [ ] 3. Integration: router, template, and generated doc
- [ ] 3.1 Wire `khipu setup-env` into the CLI router and usage text
  - Register `setup-env` as an operational subcommand so the router resolves it to the wrapper, and
    add a `setup-env` line to the usage text alongside `setup-claude`/`setup-sync`.
  - Observable completion: `khipu --help` lists `setup-env`, and resolving the `setup-env` argument
    routes to the wrapper script.
  - _Requirements: 1.1, 1.2_
  - _Depends: 2.5_

- [ ] 3.2 (P) Expand `.env.example` to list every recognised variable
  - List all recognised variables (the three Telegram vars plus the auto-managed
    `TELEGRAM_SESSION_STRING`, Discord, Slack, the three Email/IMAP vars, Beeper, and the four
    optional security vars), each preceded by a comment referencing its acquisition URL or the
    `docs/TOKENS.md` reference; keep the existing Telegram vars and mark optional vars as optional.
  - Observable completion: `.env.example` contains every recognised variable with a per-variable
    comment link and clearly marks the optional security vars.
  - _Requirements: 8.1, 8.2, 8.3_
  - _Boundary: .env.example_
  - _Depends: 1.1_

- [ ] 3.3 Generate the committed docs/TOKENS.md artifact
  - Produce `docs/TOKENS.md` by running the `--emit-docs` mode so the committed reference is a
    generated artifact of the variable table.
  - Observable completion: `docs/TOKENS.md` exists and byte-equals a fresh `--emit-docs` run.
  - _Requirements: 6.3, 7.1_
  - _Depends: 2.4_

- [ ] 4. Validation: tests
- [ ] 4.1 Test router registration and usage text
  - Assert the resolver routes the `setup-env` argument to the wrapper script and that the usage/help
    output includes a `setup-env` line.
  - Observable completion: the routing and help-text assertions pass under the project test runner.
  - _Requirements: 1.1, 1.2_
  - _Depends: 3.1_

- [ ] 4.2 Test the bash engine end-to-end over fixtures
  - Invoke the bash engine under `/bin/bash` with piped answers against temp-dir fixtures to verify:
    missing/empty detection and skip-configured; managed `TELEGRAM_SESSION_STRING` never prompted or
    written; in-place fill preserving comments/blank lines/order; append of absent keys; empty-answer
    skip; idempotent re-run; and the written/skipped/already-configured summary.
  - Assert bash 3.2 compatibility (no associative arrays/`mapfile`; executes under `/bin/bash`) and
    that the script performs no network calls (no `curl`/`wget`/`nc`).
  - Observable completion: all engine integration assertions pass, including a re-run that makes zero
    changes.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.2, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.1, 9.2, 9.3_
  - _Depends: 2.3, 2.4_

- [ ] 4.3 Test docs generation, drift, and `.env.example` coverage
  - Assert an `--emit-docs` run covers every recognised variable with its URL, click-path, example,
    and required/optional status plus the session-string note; assert the committed `docs/TOKENS.md`
    byte-equals a fresh emit; and assert `.env.example` lists every recognised variable with a
    per-variable comment link.
  - Observable completion: the docs-coverage, drift, and `.env.example` assertions pass.
  - _Requirements: 6.2, 6.3, 7.1, 7.2, 7.3, 8.1, 8.2, 8.3_
  - _Depends: 3.2, 3.3_
