# Brief: sync-watcher

## Problem
There is no way to keep the message archive up-to-date automatically. Users must manually run `npm run sync:*` for each platform whenever they want new messages. The existing `sync` script runs all platforms once but does not loop. Setting up OS-level daemons (LaunchAgent) is complex and not obvious from the README.

## Current State
- `npm run sync` does a one-shot sequential backfill of all platforms
- `npm run sync:platform` runs one platform once (useful for manual/debug)
- `src/setup-sync.ts` generates a macOS LaunchAgent plist — but this re-runs the one-shot script, not a true watcher
- No built-in polling loop or "watch for new messages" mode

## Desired Outcome
- `npm run watch` starts a long-running daemon that:
  - Polls each configured platform on a per-platform configurable interval (default: 5 min)
  - Uses `syncIncremental` (from `incremental-sync`) so only new messages are fetched each cycle
  - Logs `[platform] synced N new messages` or `[platform] up to date` each cycle
  - Gracefully handles per-platform errors (one failing platform does not crash others)
  - Shuts down cleanly on SIGINT/SIGTERM
- Individual `npm run sync:platform` scripts remain unchanged for manual/debug use
- A platform is skipped in the watcher if its required credentials/config are absent

## Approach
Single `src/watch.ts` entry point. Maintains a map of `{ platform → intervalMs }` read from env/config. On each interval tick, calls the platform adapter's `syncIncremental` (or `runBackfill` as fallback). Error per platform is caught and logged without stopping the loop. Process signal handlers trigger a graceful drain before exit.

## Scope
- **In**: `src/watch.ts`, `npm run watch` script, per-platform polling interval config (env vars), graceful shutdown, per-platform error isolation, skip-if-unconfigured logic
- **Out**: Real-time push/webhook (still polling), changing `sync:*` scripts, adding new platforms, UI for watcher status

## Boundary Candidates
- Watcher loop: `src/watch.ts` — platform registry, interval management, error isolation
- Config: interval env vars (`WATCH_INTERVAL_WECHAT_MS` etc.) with sensible defaults
- Platform skip detection: reuse existing credential-check logic from each adapter

## Out of Boundary
- Does not modify any platform adapter internals
- Does not expose a status endpoint or UI
- Does not replace the LaunchAgent setup (that still works for one-shot scheduling)

## Upstream / Downstream
- **Upstream**: `incremental-sync` (provides `syncIncremental` on each adapter + sync_state tracking)
- **Downstream**: None — leaf feature

## Existing Spec Touchpoints
- **Extends**: none (new entry point, no existing spec modified)
- **Adjacent**: all `*-sync` specs (calls their adapters but does not modify them)

## Constraints
- Single file `src/watch.ts` ≤ 200 lines
- No new dependencies — use Node.js built-in `setInterval` + process signals
- Must not crash the process on per-platform errors — catch + log only
- Credentials absence = silent skip with a one-time startup log line
