#!/bin/bash
# setup-env.sh — KhipuChat interactive .env filler engine.
#
# Requires: /bin/bash 3.2+ (macOS default) or Linux bash. No associative
# arrays, no `mapfile`, no network calls. See
# .kiro/specs/setup-wizard/design.md ("Engine Layer") for the full contract.
#
# This file currently implements the `var_table` single source of truth,
# detection (`is_configured`, `resolve_env_file`), per-record prompt
# rendering (`render_prompt`), and `--dump-table` / `--dump-status` /
# `--dump-prompts` debug modes to observe them. The full interactive loop
# that wires detection + prompting into a `.env` merge/write, and the
# `--emit-docs` renderer, are implemented in later tasks on top of this
# same file.

set -eu

# var_table
# Prints one pipe-delimited record per recognised variable to stdout:
#   key|platform|required|url|example|click_path
# - required is "1" (required) or "0" (optional)
# - click_path uses " => " between steps
# TELEGRAM_SESSION_STRING is intentionally NOT a record: it is auto-managed
# at first Telegram login and must never be prompted for (R2.5).
#
# bash-3.2 safe: this is plain text; consumers parse it with
#   while IFS='|' read -r key platform required url example click_path
# No associative arrays, no mapfile.
var_table() {
  cat <<'VARTABLE'
TELEGRAM_API_ID|Telegram|1|https://my.telegram.org/apps|1234567|Open https://my.telegram.org => log in with your phone (+countrycode) and the code sent in your Telegram app => click "API development tools" => copy the "App api_id" and "App api_hash" fields
TELEGRAM_API_HASH|Telegram|1|https://my.telegram.org/apps|0123456789abcdef0123456789abcdef|Open https://my.telegram.org => log in with your phone (+countrycode) and the code sent in your Telegram app => click "API development tools" => copy the "App api_id" and "App api_hash" fields
TELEGRAM_PHONE_NUMBER|Telegram|1|https://my.telegram.org/apps|+14155552671|Open https://my.telegram.org => log in with your phone (+countrycode) and the code sent in your Telegram app => click "API development tools" => copy the "App api_id" and "App api_hash" fields
DISCORD_TOKEN|Discord|1|https://discord.com/developers/applications|MTk4N... (bot token)|Open https://discord.com/developers/applications => New Application => Bot => Reset Token => Copy. Enable "Message Content Intent" if reading message text
SLACK_USER_TOKEN|Slack|1|https://api.slack.com/apps|xoxp-...|Open https://api.slack.com/apps => Create New App => From scratch => OAuth & Permissions => add User Token Scopes (channels:history, groups:history, im:history, mpim:history, users:read) => Install to Workspace => copy the "User OAuth Token" starting with xoxp-
EMAIL_IMAP_HOST|Email/IMAP|1|(provider docs; Gmail: imap.gmail.com)|imap.gmail.com|Use your provider's IMAP host (Gmail: imap.gmail.com, port 993 SSL). Enable 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords and use it as EMAIL_IMAP_PASS (your normal password will not work)
EMAIL_IMAP_USER|Email/IMAP|1|(provider account)|you@gmail.com|Use your provider's IMAP host (Gmail: imap.gmail.com, port 993 SSL). Enable 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords and use it as EMAIL_IMAP_PASS (your normal password will not work)
EMAIL_IMAP_PASS|Email/IMAP|1|https://myaccount.google.com/apppasswords|abcd efgh ijkl mnop (app password)|Use your provider's IMAP host (Gmail: imap.gmail.com, port 993 SSL). Enable 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords and use it as EMAIL_IMAP_PASS (your normal password will not work)
BEEPER_ACCESS_TOKEN|Beeper (Signal / Facebook Messenger)|1|Beeper Desktop app|(token from Beeper Desktop)|Open Beeper Desktop => Settings => Integrations => click "+" next to Approved connections => create the token. This token backs Signal and Facebook Messenger
DB_KEY|Security (optional)|0|steering: security-hardening|(SQLCipher passphrase)|Operator-chosen; see steering security-hardening notes
WEB_USER|Security (optional)|0|operator-chosen|admin|Operator-chosen; see steering security-hardening notes
WEB_PASS|Security (optional)|0|operator-chosen|(web basic-auth password)|Operator-chosen; see steering security-hardening notes
MCP_SECRET|Security (optional)|0|operator-chosen|(MCP bearer token)|Operator-chosen; see steering security-hardening notes
VARTABLE
}

# dump_table
# Debug mode: prints every var_table record in a human-readable form,
# one block per variable, showing platform / required / url / click-path /
# example. Used to observe var_table's output without a prompt loop.
dump_table() {
  local key platform required url example click_path count
  count=0
  var_table | while IFS='|' read -r key platform required url example click_path; do
    count=$((count + 1))
    printf 'record %d: %s\n' "$count" "$key"
    printf '  platform:   %s\n' "$platform"
    printf '  required:   %s\n' "$required"
    printf '  url:        %s\n' "$url"
    printf '  example:    %s\n' "$example"
    printf '  click_path: %s\n' "$click_path"
  done
}

# render_prompt <key> <platform> <required> <url> <example> <click_path>
# Renders one prompt for a single var_table record to stdout, then reads one
# line of input from stdin into the global PROMPT_ANSWER. This is the sole
# per-record rendering primitive shared by the interactive loop (a later
# task) and the --dump-prompts debug mode below.
#
# - required vars ("1"): show platform, URL, click-path, and example.
# - optional vars ("0"): show the same, plus an explicit "optional: press
#   Enter to skip" label (R4.1, R4.3).
# - The answer is accepted as-is: no validation, no network call (R4.4, R9.3).
#   An empty answer (bare Enter) is captured as the empty string "": later
#   tasks interpret "" as skip (R4.2); this function only captures it.
#
# bash-3.2 safe: `IFS= read -r` preserves leading/trailing whitespace and
# backslashes verbatim in the captured answer.
render_prompt() {
  local key="$1" platform="$2" required="$3" url="$4" example="$5" click_path="$6"
  printf '\n%s (%s)\n' "$key" "$platform"
  if [ "$required" = "1" ]; then
    printf '  Required\n'
  else
    printf '  Optional: press Enter to skip\n'
  fi
  printf '  URL:        %s\n' "$url"
  printf '  Click-path: %s\n' "$click_path"
  printf '  Example:    %s\n' "$example"
  printf '%s: ' "$key"
  IFS= read -r answer
  PROMPT_ANSWER="$answer"
}

# is_configured <key> <file>
# Detection rule (design.md, "prompt loop"): a key is "configured" iff a
# line in <file> matches ^KEY= and the value after the = is non-empty.
# Returns 0 (true) if configured, 1 (false) if missing/empty/absent, and
# also 1 when <file> does not exist at all (R2.4: proceed as all-unset).
# bash-3.2 safe: no associative arrays; single grep + parameter expansion.
is_configured() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 1
  line=$(grep -m 1 -E "^${key}=" "$file" 2>/dev/null) || return 1
  [ -n "$line" ] || return 1
  value="${line#*=}"
  [ -n "$value" ] || return 1
  return 0
}

# resolve_env_file [override]
# Resolves the target env file path: an explicit argument wins, otherwise
# the SETUP_ENV_FILE environment variable, otherwise the default `.env`
# in the project root (R2.1, R2.4).
resolve_env_file() {
  printf '%s' "${1:-${SETUP_ENV_FILE:-.env}}"
}

# dump_status [env-file]
# Debug mode: for every var_table key (TELEGRAM_SESSION_STRING is never a
# var_table record, so it is structurally skipped — R2.5), prints whether
# the key is "configured" (present in the env file with a non-empty value)
# or "missing" (absent or empty, including when the env file itself does
# not exist — R2.1-2.4). Used to observe detection without the interactive
# prompt loop, which is implemented in a later task.
dump_status() {
  local file key platform required url example click_path status
  file="$(resolve_env_file "${1:-}")"
  var_table | while IFS='|' read -r key platform required url example click_path; do
    if is_configured "$key" "$file"; then
      status="configured"
    else
      status="missing"
    fi
    printf '%s: %s\n' "$key" "$status"
  done
}

# dump_prompts
# Debug mode: exercises render_prompt against every var_table record, driven
# by piped stdin answers (one line per record, in var_table order — blank
# lines are valid "skip" answers). For each record it prints the full
# rendered prompt to stdout, then prints the captured answer to stderr as
# `captured KEY=[answer]` so a test harness can tell rendered-prompt output
# apart from the captured-answer evidence. Writes nothing to any file — the
# `.env` merge/write is task 2.3, not this debug mode.
#
# bash-3.2 gotcha this avoids: `var_table | while read ...; do ...; done`
# would put the loop body's stdin on the var_table pipe, so a `read -r
# answer` inside the loop would consume var_table's own output instead of
# the caller's piped answers. Instead, var_table is read from a dedicated
# file descriptor (3) via process substitution, leaving fd 0 (stdin) free
# for render_prompt's `IFS= read -r answer` to consume the caller's piped
# answers one line per record, in order.
dump_prompts() {
  local key platform required url example click_path
  while IFS='|' read -r key platform required url example click_path <&3; do
    render_prompt "$key" "$platform" "$required" "$url" "$example" "$click_path"
    printf 'captured %s=[%s]\n' "$key" "$PROMPT_ANSWER" >&2
  done 3< <(var_table)
}

# merge_env_value <key> <value> <file>
# Idempotent, order-preserving, non-clobbering merge (design.md "prompt loop" ->
# "Merge (order-preserving, non-clobbering)"; R5.1-R5.3):
#   - If <file> already has a line matching ^KEY= with an EMPTY value, that exact
#     line is replaced in place with `KEY=value` (position preserved).
#   - Otherwise (key absent from the file entirely), `KEY=value` is appended at
#     the end.
#   - Every other line (populated keys, comments, blank lines) is copied
#     byte-for-byte, in order, unchanged.
# The value is written with `printf '%s'` (no `echo`, no shell re-interpretation)
# so characters like `$` or `\` survive verbatim (R9.3, "Write values with
# printf '%s'").
# Rewrites happen through a temp file (`mktemp`) in the same directory as the
# target, and only `mv`s it over the original as the LAST step, after the
# rewrite loop has fully succeeded (set -eu means any failure mid-loop aborts
# before the mv is reached, so the original file is never partially written).
# bash-3.2 safe: no associative arrays; plain line-by-line copy with a single
# "replaced yet" flag.
merge_env_value() {
  local key="$1" value="$2" file="$3" dir tmp line replaced matched
  if [ -f "$file" ]; then
    dir=$(dirname -- "$file")
  else
    dir=.
  fi
  tmp=$(mktemp "${dir}/.setup-env.XXXXXX")
  replaced=0
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      matched=0
      case "$line" in
        "${key}="*)
          matched=1
          ;;
      esac
      if [ "$matched" = "1" ] && [ "$replaced" = "0" ]; then
        printf '%s=' "$key" >>"$tmp"
        printf '%s' "$value" >>"$tmp"
        printf '\n' >>"$tmp"
        replaced=1
      else
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi
  if [ "$replaced" = "0" ]; then
    printf '%s=' "$key" >>"$tmp"
    printf '%s' "$value" >>"$tmp"
    printf '\n' >>"$tmp"
  fi
  mv -- "$tmp" "$file"
}

# run_interactive [env-file]
# The real interactive engine (design.md "Interactive fill flow"): resolves the
# target env file, iterates every var_table record in order, skips already-
# configured keys, prompts for missing/empty ones via render_prompt, and for
# each answer either skips (empty) or merges the value into the env file via
# merge_env_value. Finishes with a summary of written / skipped /
# already-configured keys (R5.5, R2.1-R2.4, R4.2).
#
# bash-3.2 gotcha (see dump_prompts): var_table must be read from a dedicated
# fd (3), leaving fd 0 free for render_prompt's `IFS= read -r answer` to
# consume the caller's piped answers one line per record, in order.
run_interactive() {
  local file key platform required url example click_path
  local written="" skipped="" configured=""
  file="$(resolve_env_file "${1:-}")"
  while IFS='|' read -r key platform required url example click_path <&3; do
    if is_configured "$key" "$file"; then
      configured="${configured}${configured:+ }${key}"
      continue
    fi
    render_prompt "$key" "$platform" "$required" "$url" "$example" "$click_path"
    if [ -z "$PROMPT_ANSWER" ]; then
      skipped="${skipped}${skipped:+ }${key}"
      continue
    fi
    merge_env_value "$key" "$PROMPT_ANSWER" "$file"
    written="${written}${written:+ }${key}"
  done 3< <(var_table)

  printf '\nSetup summary (%s):\n' "$file"
  if [ -n "$written" ]; then
    printf '  written:            %s\n' "$written"
  else
    printf '  written:            (none)\n'
  fi
  if [ -n "$skipped" ]; then
    printf '  skipped:            %s\n' "$skipped"
  else
    printf '  skipped:            (none)\n'
  fi
  if [ -n "$configured" ]; then
    printf '  already-configured: %s\n' "$configured"
  else
    printf '  already-configured: (none)\n'
  fi
}

# resolve_env_docs
# Resolves the target docs output path: the SETUP_ENV_DOCS environment
# variable wins, otherwise `docs/TOKENS.md` in the project root.
resolve_env_docs() {
  printf '%s' "${SETUP_ENV_DOCS:-docs/TOKENS.md}"
}

# unique_platforms
# Prints each distinct platform name from var_table exactly once, one per
# line, in first-seen var_table order.
#
# bash-3.2 gotcha this avoids: several platform names contain spaces
# themselves (e.g. "Beeper (Signal / Facebook Messenger)", "Security
# (optional)"), so a *space*-joined "seen" list would word-split
# incorrectly on both build and lookup if later expanded unquoted (as in a
# `for x in $list` loop). A newline is used as the join/lookup delimiter
# instead, via a literal-newline `case` pattern, and this function's own
# output is newline-delimited so callers can safely consume it with
# `while IFS= read -r line`. No associative arrays needed.
unique_platforms() {
  local key platform required url example click_path seen nl
  nl='
'
  seen=""
  var_table | while IFS='|' read -r key platform required url example click_path; do
    case "${nl}${seen}${nl}" in
      *"${nl}${platform}${nl}"*)
        continue
        ;;
    esac
    seen="${seen}${seen:+${nl}}${platform}"
    printf '%s\n' "$platform"
  done
}

# emit_docs
# Renders `docs/TOKENS.md` (or SETUP_ENV_DOCS override) from the same
# var_table records that drive the interactive prompts (design.md "Docs
# emit flow" / "emit-docs renderer"; R6.2, R6.3, R7.1-7.3). Records are
# grouped by platform, in first-seen var_table order (via unique_platforms),
# and each record's key, required/optional status, URL, click-path, and
# example are rendered. An explicit note documents that
# TELEGRAM_SESSION_STRING is auto-managed and never prompted (R2.5).
#
# Deterministic: for a fixed var_table, re-running produces byte-identical
# output (R6.3's drift test relies on this) -- no timestamps, no random
# ordering, no locale-dependent formatting.
#
# Directory creation: SETUP_ENV_DOCS may point at a path whose parent
# directory does not exist yet (e.g. a fresh temp dir in a test); that
# directory is created up front so the mktemp below has somewhere to write.
#
# bash-3.2 gotcha (see dump_prompts' comment above): var_table must be read
# from a dedicated fd (3) in the inner loop so nothing on fd 0 (stdin) is
# consumed accidentally; the outer loop reads unique_platforms' output via
# process substitution on fd 0, which is otherwise unused here.
emit_docs() {
  local out dir tmp key platform required url example click_path
  local this_platform req_label

  out="$(resolve_env_docs)"
  dir=$(dirname -- "$out")
  [ -d "$dir" ] || mkdir -p -- "$dir"
  tmp=$(mktemp "${dir}/.setup-env-docs.XXXXXX")

  {
    printf '# TOKENS.md\n\n'
    printf 'Reference for acquiring every credential recognised by `khipu setup-env`.\n'
    printf 'Generated from the single source-of-truth variable table in\n'
    printf '`scripts/setup-env.sh` (`var_table`); do not hand-edit this file, run\n'
    printf '`khipu setup-env --emit-docs` (or `scripts/setup-env.sh --emit-docs`) to\n'
    printf 'regenerate it instead.\n\n'
    printf '> **`TELEGRAM_SESSION_STRING`** is not listed below: it is auto-managed,\n'
    printf '> produced automatically at first Telegram login, and is never prompted\n'
    printf '> for by `khipu setup-env`.\n\n'

    # For each platform (in first-seen order), re-scan var_table for the
    # records belonging to it, preserving var_table's own record order
    # within the group.
    while IFS= read -r this_platform; do
      printf '## %s\n\n' "$this_platform"
      while IFS='|' read -r key platform required url example click_path <&3; do
        [ "$platform" = "$this_platform" ] || continue
        if [ "$required" = "1" ]; then
          req_label="Required"
        else
          req_label="Optional"
        fi
        printf -- '- **`%s`** (%s)\n' "$key" "$req_label"
        printf '  - URL: %s\n' "$url"
        printf '  - Click-path: %s\n' "$click_path"
        printf '  - Example: `%s`\n' "$example"
      done 3< <(var_table)
      printf '\n'
    done < <(unique_platforms)
  } >"$tmp"

  mv -- "$tmp" "$out"
}

main() {
  case "${1:-}" in
    --dump-table)
      dump_table
      ;;
    --dump-status)
      dump_status "${2:-}"
      ;;
    --dump-prompts)
      dump_prompts
      ;;
    --emit-docs)
      emit_docs
      ;;
    "")
      run_interactive
      ;;
    *)
      printf 'Usage: %s               (interactively fill .env)\n' "$0" >&2
      printf '       %s --dump-table\n' "$0" >&2
      printf '       %s --dump-status [env-file]\n' "$0" >&2
      printf '       %s --dump-prompts   (pipe one answer line per var_table record)\n' "$0" >&2
      printf '       %s --emit-docs      (write docs/TOKENS.md or $SETUP_ENV_DOCS)\n' "$0" >&2
      exit 1
      ;;
  esac
}

main "$@"
