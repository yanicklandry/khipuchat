# Brief: slack-all-workspaces

## Problem
The user is a member of several Slack workspaces and is admin on only some. Important operational messages (e.g. `#08-expedition` transactions that require a new ADV report) arrive in workspaces where they cannot install a Slack app. The current adapter depends on an installed personal app, polls slowly, and misses thread replies.

## Current State
- `src/platforms/slack/client.ts` sends `Authorization: Bearer <SLACK_USER_TOKEN>` and optionally `Cookie: d=<SLACK_COOKIE>`, so both `xoxp-` (installed app) and `xoxc-` + `d` cookie (browser session) technically work, but only the `xoxp` path is documented (`docs/TOKENS.md`).
- Multi-account works through `khipu.config.json` (one account entry = one workspace).
- Never calls `conversations.replies` (no thread replies), `is_sender` always 0, non-IM channels mapped to type `'user'` (bug), `process.exit(1)` on missing token, fixed 1200 ms throttle, every cycle re-lists all conversations.
- Slack (2025-05-29 changelog) throttled `conversations.history/replies` to ~1 req/min for non-Marketplace distributed apps; enforcement on existing installs since 2026-03-03. An `xoxp` app installed in someone else's workspace may fall in this bucket.
- Workspaces with "Require app approval" block `xoxp` entirely for non-admins.

## Desired Outcome
Every Slack workspace the user can log into in a browser syncs into khipuchat, including threads, without any admin action, and messages in watched channels land within ~1 to 2 minutes.

## Approach
Make the session-token backend (`xoxc-` + `d`) the documented default: a guided capture flow (`khipu slack login` printing exact browser devtools steps, or reading token+cookie from the Slack desktop app's local storage on the Mac as an optional helper), token validity check via `auth.test`, clear `invalid_auth` / `enterprise_is_restricted` handling that marks the account "needs re-auth" and raises an event (so notifier can tell the user). Keep `xoxp` as an alternative backend. Add `conversations.replies` for threaded messages, per-channel poll tiers (watched channels short interval, others long), use `conversations.list` caching between cycles, and fix `is_sender`/type mapping. Realtime websocket (the web client's own socket) is a stretch goal behind a flag; polling is the baseline.

## Scope
- **In**: session-token backend + docs, auth health check and re-auth signaling, thread replies, per-channel poll tiers / watchlist config, conversation-list caching, mapping fixes, tests with mocked API.
- **Out**: Beeper Slack bridge (khipuchat replaces Beeper), sending/replying on Slack, file downloads, Slack Connect edge cases beyond best effort, Enterprise Grid org-wide export.

## Boundary Candidates
- Auth backends (session token vs app token) behind one client interface
- Poll scheduler / channel tiering
- Thread reply fetching and mapping

## Out of Boundary
- Deciding which messages are important (triage-agent); emitting events (message-events owns the outbox, this spec only inserts messages as today).

## Upstream / Downstream
- **Upstream**: slack-sync, multi-account, sync-account-routing, incremental-sync, cloud-deployment.
- **Downstream**: message-events / triage-agent consume Slack messages; notifier reports re-auth needed.

## Existing Spec Touchpoints
- **Extends**: slack-sync (backend, threads, mapping fixes).
- **Adjacent**: sync-watcher (per-channel intervals inside one platform poll), setup-wizard (token capture docs).

## Constraints
- Session tokens are unofficial: document ToS risk; tokens rotate on Enterprise Grid within hours and die on logout or "unusual access" detection (higher risk from a cloud IP). Never log tokens/cookies.
- Respect rate limits (Tier 3 for history with session tokens); back off on 429 with Retry-After.
- Files under 200 lines, TS strict, no `any`.
