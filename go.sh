#!/usr/bin/env bash
set -euo pipefail

# Runs tukuy on the specs that still have open tasks.
# Fully-completed specs are intentionally omitted:
#   done: discord-sync, email-sync, imessage-sync, incremental-sync,
#         multi-account, platform-abstraction, security-hardening,
#         semantic-search, signal-image-sync, slack-sync, web-ui,
#         whatsapp-sync

# The 8 incomplete specs are queued in .tukuy/queue.json (ready list), in
# dependency order. Queue mode processes them one by one, re-running each
# spec's pipeline; already-approved phases no-op and /kiro-impl finishes the
# remaining tasks. Queue mode resets per-spec run state, which avoids the
# stale-state pitfalls of `tukuy --spec`.
tukuy
