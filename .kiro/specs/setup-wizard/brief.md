# Brief: setup-wizard

## Problem
New KhipuChat operators must hand-edit `.env` and, worse, hunt across the internet to
figure out *where* each credential comes from. Vague guidance like "get a Discord token"
leaves them stuck. There is no single interactive path from a fresh clone to a working
`.env`, and the token-acquisition steps are undocumented or scattered.

## Current State
- Credentials are read from `.env` (single-account) or `khipu.config.json` (multi-account).
- `.env.example` lists only the four Telegram vars; Discord/Slack/Email/Beeper vars are
  documented nowhere machine-readable.
- README has scattered mentions but no precise click-path instructions and no interactive
  filler. `khipu setup-claude` and `khipu setup-sync` exist, but nothing helps fill `.env`.

## Desired Outcome
- `khipu setup-env` (backed by a bash script) inspects the current `.env`, determines which
  variables are missing or empty, and interactively prompts for each one.
- Every prompt shows a **precise** acquisition link and click-path, not vague advice:
  e.g. "Go to https://my.telegram.org/apps, log in with your phone, click 'API development
  tools', copy the value shown as `api_id`", then paste.
- Skips variables already set; supports optional vars (encryption/auth) with a clear "press
  Enter to skip" affordance. Writes results back to `.env` without clobbering existing keys.
- A companion doc (`docs/TOKENS.md` or a README section) captures the same per-platform
  acquisition steps for reference.

## Approach
A POSIX-compatible bash script (`scripts/setup-env.sh`) driven by a declarative table of
variables: `{ key, platform, required|optional, url, click_path, example }`. The script
reads existing `.env`, loops over the table, prompts only for missing/empty required vars
(and offers optional ones), and appends/updates keys in `.env` idempotently. Wire it as
`khipu setup-env` in the `khipu.ts` router (operational subcommand) so it is discoverable
alongside `setup-claude` / `setup-sync`. Generate `docs/TOKENS.md` from the same table so
docs and script never drift. Chosen because it is dependency-free, matches the existing
bash/tsx tooling style, and keeps the acquisition knowledge in exactly one place.

## Scope
- **In**: `scripts/setup-env.sh` interactive filler; the variable/link/click-path table;
  `khipu setup-env` router entry; idempotent `.env` read/merge/write; skip-already-set and
  optional-var handling; `docs/TOKENS.md` (or README section) with precise per-platform
  steps for Telegram, Discord, Slack, Email/IMAP, and Beeper (Signal/Facebook Messenger);
  updating `.env.example` to list every recognised variable with a comment link.
- **Out**: Actually generating/OAuth-ing tokens for the user; validating that a pasted token
  works (no live API calls); GUI/TUI beyond simple prompts; multi-account
  `khipu.config.json` generation (env-var single-account only for this spec).

## Boundary Candidates
- The variable metadata table (key + url + click-path) — the single source of truth.
- The interactive prompt/merge engine (`.env` read, diff, prompt, write).
- The reference documentation generator/section.

## Out of Boundary
- Token/credential *generation* or OAuth flows.
- `khipu.config.json` multi-account authoring (owned by multi-account).
- Live credential verification.

## Upstream / Downstream
- **Upstream**: account-registry / config.ts (authoritative list of env vars per platform);
  khipu.ts router (subcommand registration).
- **Downstream**: onboarding docs; the release spec (README setup section can link to it);
  facebook-messenger (its `BEEPER_ACCESS_TOKEN` step should be added to the table).

## Existing Spec Touchpoints
- **Extends**: none directly; complements `release` (onboarding) and `multi-account` (env vars).
- **Adjacent**: `khipu-cli` (subcommand routing pattern), `security-hardening` (optional
  `DB_KEY` / `WEB_USER` / `WEB_PASS` / `MCP_SECRET` vars should appear as optional prompts).

## Constraints
- POSIX bash, no extra dependencies; must run on macOS default `/bin/bash` (3.2) and Linux.
- Must never overwrite or reorder existing populated keys in `.env`; append/patch only.
- Env-var names are the post-normalization canonical set (`TELEGRAM_API_ID`,
  `TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER`, `DISCORD_TOKEN`, `SLACK_USER_TOKEN`,
  `EMAIL_IMAP_HOST/USER/PASS`, `BEEPER_ACCESS_TOKEN`).
- Links must be concrete URLs with click-paths, verified reachable at authoring time.
