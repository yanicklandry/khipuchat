# Requirements Document

## Introduction

New KhipuChat operators currently have to hand-edit `.env` and hunt across the internet to
discover *where* each platform credential comes from. `.env.example` lists only the four
Telegram variables, and Discord/Slack/Email/Beeper credentials are documented nowhere
machine-readable. `khipu setup-claude` and `khipu setup-sync` exist, but nothing helps an
operator fill `.env`.

The setup-wizard feature adds an interactive `khipu setup-env` command, backed by a
POSIX bash script, that inspects the current `.env`, determines which recognised variables
are missing or empty, and prompts for them one at a time. Every prompt shows a **precise**
acquisition link and click-path (concrete URL + what to click + which field to copy) rather
than vague advice. A single declarative variable table is the source of truth that drives
both the interactive prompts and a generated `docs/TOKENS.md` reference document, so the two
never drift. `.env.example` is expanded to list every recognised variable with a comment
link.

This feature is single-account (env-var) only. It never generates or OAuths tokens for the
operator, never validates a pasted credential against a live service, and never authors
`khipu.config.json`.

## Boundary Context

- **In scope**: the `scripts/setup-env.sh` interactive filler; the declarative variable
  metadata table (key, platform, required|optional, url, click-path, example); wiring
  `khipu setup-env` into the CLI router and USAGE text; idempotent read/merge/write of `.env`
  that never clobbers or reorders existing populated keys; skip-already-set behavior; optional
  variable handling with an explicit skip affordance; a generated `docs/TOKENS.md` reference
  doc derived from the same table; expanding `.env.example` to list every recognised variable
  with a comment link.
- **Out of scope**: generating or OAuth-ing tokens on the operator's behalf; validating that a
  pasted credential works via any live network call; a GUI/TUI beyond simple line prompts;
  authoring or editing `khipu.config.json` multi-account registries; changing how any platform
  adapter reads its credentials.
- **Adjacent expectations**: the authoritative set of recognised variables is defined by the
  existing platform adapters and the account registry (Telegram, Discord, Slack, Email/IMAP,
  and Beeper-backed Signal/Facebook Messenger), plus the optional security variables from
  security-hardening (`DB_KEY`, `WEB_USER`, `WEB_PASS`, `MCP_SECRET`). The wizard reads and
  writes only the single-account `.env`; multi-account credential resolution via
  `khipu.config.json` remains owned by the multi-account spec. `TELEGRAM_SESSION_STRING` is
  produced automatically at first Telegram login and is therefore not prompted for.

## Requirements

### Requirement 1: Discoverable `khipu setup-env` command

**Objective:** As a KhipuChat operator, I want a `khipu setup-env` subcommand alongside
`setup-claude` and `setup-sync`, so that I can discover and launch the interactive `.env`
filler from the same CLI I already use.

#### Acceptance Criteria
1. When the operator runs `khipu setup-env`, the khipu CLI shall launch the interactive
   environment setup filler.
2. When the operator runs `khipu` with no arguments or `khipu --help`, the khipu CLI shall
   list `setup-env` in its usage text with a short description alongside `setup-claude` and
   `setup-sync`.
3. When the operator runs `khipu setup-env` and the interactive filler exits successfully,
   the khipu CLI shall exit with a success status code.
4. If the interactive filler exits with a failure status, then the khipu CLI shall propagate a
   non-zero exit status to the operator.

### Requirement 2: Detect missing and empty required variables

**Objective:** As an operator, I want the wizard to inspect my current `.env` and only ask
about variables that are missing or empty, so that I never re-enter credentials I have
already configured.

#### Acceptance Criteria
1. When the wizard starts, the Setup Wizard shall read the existing `.env` file from the
   project root if it exists.
2. Where a recognised variable is already present in `.env` with a non-empty value, the Setup
   Wizard shall treat it as configured and shall not prompt for it.
3. When a recognised required variable is absent from `.env` or present with an empty value,
   the Setup Wizard shall prompt the operator for that variable.
4. If no `.env` file exists when the wizard starts, then the Setup Wizard shall proceed as if
   every recognised variable is unset and shall create `.env` when it records the operator's
   answers.
5. The Setup Wizard shall not prompt for `TELEGRAM_SESSION_STRING`, because that value is
   produced automatically at first Telegram login.

### Requirement 3: Precise acquisition guidance for every prompt

**Objective:** As an operator who does not know where a credential comes from, I want each
prompt to show the exact URL, what to click, and which field to copy, so that I can obtain the
value without searching the internet.

#### Acceptance Criteria
1. When the Setup Wizard prompts for a variable, the Setup Wizard shall display the platform
   name, a concrete acquisition URL, a step-by-step click-path, and an example value format
   for that variable.
2. The Setup Wizard shall display, for the Telegram variables, the acquisition URL
   `https://my.telegram.org/apps` and instructions to open "API development tools" and copy the
   `App api_id` and `App api_hash` fields.
3. The Setup Wizard shall display, for the Discord token, the acquisition URL
   `https://discord.com/developers/applications` and instructions to create an application, add
   a Bot, and reset/copy the bot token.
4. The Setup Wizard shall display, for the Slack user token, the acquisition URL
   `https://api.slack.com/apps` and instructions to create an app, add User Token Scopes under
   "OAuth & Permissions", install to the workspace, and copy the User OAuth Token that begins
   with `xoxp-`.
5. The Setup Wizard shall display, for the Beeper access token, instructions to open Beeper
   Desktop and create a token under Settings > Integrations > Approved connections, noting that
   this token backs the Signal and Facebook Messenger platforms.
6. The Setup Wizard shall display, for the Email/IMAP variables, guidance that the IMAP host,
   account address, and an app-specific password are required, including a concrete provider
   example (for example Gmail: host `imap.gmail.com`, and an app password from
   `https://myaccount.google.com/apppasswords`).
7. The Setup Wizard shall present every acquisition prompt as a concrete URL plus click-path
   plus field-to-copy, and shall not present vague guidance such as "get a Discord token".

### Requirement 4: Optional variable handling with a clear skip affordance

**Objective:** As an operator, I want optional security and encryption variables offered with
an obvious way to skip, so that I can enable them when I want them and press Enter to move on
when I do not.

#### Acceptance Criteria
1. When the Setup Wizard reaches an optional variable that is missing or empty, the Setup
   Wizard shall label the prompt as optional and shall state that pressing Enter skips it.
2. When the operator presses Enter at any prompt without entering a value, the Setup Wizard
   shall skip that variable and shall not write or alter it in `.env`.
3. Where the optional security variables `DB_KEY`, `WEB_USER`, `WEB_PASS`, and `MCP_SECRET` are
   missing or empty, the Setup Wizard shall offer each as a skippable optional prompt.
4. When the operator provides a value for a required variable, the Setup Wizard shall accept the
   entered value as-is without validating it against any live service.

### Requirement 5: Idempotent, non-destructive `.env` merge

**Objective:** As an operator who may run the wizard more than once, I want my answers merged
into `.env` without clobbering, reordering, or losing any existing content, so that re-running
the wizard is always safe.

#### Acceptance Criteria
1. When the operator provides a value for a variable that is absent from `.env`, the Setup
   Wizard shall append that key with its value to `.env`.
2. When the operator provides a value for a variable that exists in `.env` with an empty value,
   the Setup Wizard shall set that existing key's value in place without moving it.
3. While merging answers, the Setup Wizard shall preserve every already-populated key, comment,
   and blank line in `.env` unchanged, and shall not reorder existing entries.
4. If the operator skips a variable, then the Setup Wizard shall leave `.env` unchanged for that
   variable.
5. When the wizard completes, the Setup Wizard shall report which variables were written, which
   were skipped, and which were already configured.
6. When the operator runs the wizard a second time after a completed run, the Setup Wizard shall
   only prompt for variables that are still missing or empty and shall make no changes if
   nothing is provided.

### Requirement 6: Single source-of-truth variable table

**Objective:** As a maintainer, I want the interactive prompts and the reference documentation
generated from one declarative variable table, so that credential acquisition knowledge lives
in exactly one place and the two never drift.

#### Acceptance Criteria
1. The Setup Wizard shall derive every prompt from a single declarative variable table whose
   entries carry a key, platform, required-or-optional flag, acquisition URL, click-path, and
   example value.
2. The Setup Wizard shall generate the `docs/TOKENS.md` reference content from the same variable
   table that drives the interactive prompts.
3. When a variable entry is added, removed, or changed in the table, both the interactive prompts
   and the generated reference documentation shall reflect that change without a separate manual
   edit to either consumer.

### Requirement 7: Reference documentation for token acquisition

**Objective:** As an operator who prefers to read ahead, I want a `docs/TOKENS.md` document that
captures the same precise per-platform acquisition steps, so that I have a durable reference
outside the interactive session.

#### Acceptance Criteria
1. The setup-wizard feature shall provide a `docs/TOKENS.md` document that lists, per platform,
   each recognised variable with its acquisition URL, click-path, example value, and
   required-or-optional status.
2. The `docs/TOKENS.md` document shall cover Telegram, Discord, Slack, Email/IMAP, and the
   Beeper-backed Signal/Facebook Messenger platforms, plus the optional security variables.
3. The `docs/TOKENS.md` document shall present the same acquisition URLs and click-paths that the
   interactive prompts display for the corresponding variables.

### Requirement 8: Complete `.env.example`

**Objective:** As an operator inspecting a fresh clone, I want `.env.example` to list every
recognised variable with a comment pointing to where its value comes from, so that the template
alone tells me what can be configured.

#### Acceptance Criteria
1. The setup-wizard feature shall update `.env.example` to list every recognised variable,
   including the Telegram, Discord, Slack, Email/IMAP, and Beeper credentials and the optional
   security variables.
2. The `.env.example` file shall include, above or beside each variable, a comment referencing
   the acquisition URL or the `docs/TOKENS.md` reference for that variable.
3. The `.env.example` file shall keep the four existing Telegram variables and shall mark
   optional variables as optional.

### Requirement 9: POSIX portability and no live network calls

**Objective:** As an operator on either macOS or Linux, I want the wizard to run on the default
system shell without extra dependencies and without contacting any external service, so that it
works on a fresh clone and never leaks or transmits my credentials.

#### Acceptance Criteria
1. The Setup Wizard shall run under the macOS default `/bin/bash` version 3.2 and under Linux
   bash without requiring any additional runtime dependency.
2. The Setup Wizard shall not use shell features unavailable in bash 3.2 (for example associative
   arrays or `mapfile`).
3. While prompting and merging, the Setup Wizard shall make no outbound network calls and shall
   not transmit any entered value anywhere; all reads and writes shall be confined to the local
   `.env` file.
