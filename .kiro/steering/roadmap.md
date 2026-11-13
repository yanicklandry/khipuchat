# Roadmap

## Overview
KhipuChat is a self-hosted multi-platform message archive with an MCP server and web UI. Goal: sync all your conversations locally, query them with Claude, search them in a browser. Your messages never leave your machine.

## Usage Surfaces (priority order)
The archive is consumed through three surfaces. Specs that expose data or queries MUST serve them in this priority:
1. **MCP (primary)** — the main way the archive is used: an LLM (Claude) queries it, from specific lookups (list chats, list messages, get thread) to semantic search. New query/filter capabilities land here first and must be account-aware and platform-aware.
2. **CLI (secondary)** — mainly for debugging, but also for scripted automation: list/search messages with filters (date range, platform, account, type). The CLI should reach parity with MCP filtering so anything the LLM can query, an operator can query from the terminal.
3. **Web (secondary)** — a browser UI for testing and manual browsing of the archive.
Whatever the archive can answer through one surface should be answerable through the others (agent-native parity), with MCP as the reference implementation.

Phase 1 (Telegram sync + MCP) and Phase 2 (iMessage sync + platform abstraction) are complete. This roadmap tracks the remaining phases: web UI, additional platform integrations, semantic search, security hardening, and release.

## Approach Decision
- **Chosen**: Vertical slices — each phase delivers independently useful functionality on top of the shared platform-abstraction foundation
- **Why**: Every phase ships something usable. No phase depends on a future phase. Platform adapters follow the established PlatformAdapter interface.
- **Rejected alternatives**:
  - Big-bang all platforms at once: too risky, no intermediate value
  - Web UI last: users can't browse messages until very late

## Scope
- **In**: Web UI, Discord/Email/Slack/WhatsApp sync, semantic search, security hardening, Docker release
- **Out**: Sending messages on any platform, Instagram, Facebook Groups, mobile app, cloud sync (Facebook Messenger 1:1/group DMs are now in scope via the facebook-messenger spec)

## Constraints
- All DB operations remain synchronous (better-sqlite3)
- MCP server communicates via stdio only
- Keep each source file under 200 lines
- Self-hosted only — no external services, no cloud
- Each phase must have passing tests before the next starts

## Boundary Strategy
- **Why this split**: Each platform adapter is isolated in `src/platforms/<name>/`. `src/db.ts` is the shared boundary — adapters only call exported db functions, never touch the schema.
- **Shared seams to watch**: `src/db.ts` (schema), `src/mcp.ts` (tool descriptions), `src/platforms/types.ts` (PlatformAdapter interface)

## Specs (dependency order)
- [x] platform-abstraction -- Generalize schema, reorganize src/platforms/, rename telegram_id→external_id, update MCP tools. Dependencies: none
- [x] imessage-sync -- Read ~/Library/Messages/chat.db, map to generic schema, add npm run sync:imessage. Dependencies: platform-abstraction
- [x] semantic-search -- Local ONNX embeddings (all-MiniLM-L6-v2) + sqlite-vec; new MCP tools semantic_find_contacts and semantic_search_messages; incremental indexing pipeline. Dependencies: platform-abstraction
- [x] web-ui -- Express + plain HTML search UI served at localhost:3333, chat list sidebar, message thread view, platform badges. Dependencies: platform-abstraction, imessage-sync
- [x] discord-sync -- Discord bot token, sync DMs and non-broadcast channels, npm run sync:discord. Dependencies: platform-abstraction
- [x] email-sync -- IMAP via imapflow, sync sent+received threads as messages, npm run sync:email. Dependencies: platform-abstraction
- [x] slack-sync -- Personal Slack app OAuth, sync DMs and channels, npm run sync:slack. Dependencies: platform-abstraction
- [x] whatsapp-sync -- whatsapp-web.js QR-code session, sync DMs, npm run sync:whatsapp. Dependencies: platform-abstraction
- [x] security-hardening -- SQLCipher encryption, web UI basic-auth, MCP bearer token, localhost-only binding. Dependencies: web-ui
- [x] release -- Dockerfile + docker-compose, GitHub Actions CI/publish, SECURITY.md, demo GIF. Dependencies: web-ui, discord-sync, email-sync, slack-sync, whatsapp-sync, security-hardening
- [x] incremental-sync -- Extend PlatformAdapter with lastSyncAt tracking; sync_state table; all sync scripts fetch only messages newer than last successful sync. `--force` full re-read + reindex; per-account sync_state. Dependencies: platform-abstraction.
- [x] web-ui-enhancements -- Chat-window scroll layout (oldest top, newest bottom, auto-scroll to newest, load-older on scroll-up) + semantic search input in web UI. Dependencies: web-ui, semantic-search
- [x] sync-watcher -- Daemon that polls all configured platforms continuously; sync => index => wait; `khipu sync all` entry point; `--once` single-pass. Dependencies: incremental-sync.
- [x] multi-account -- khipu.config.json account registry; add `account` dimension to schema; per-account sync_state; adapters iterate configured accounts. Dependencies: platform-abstraction, incremental-sync
- [x] khipu-cli -- Global `khipu` command (bin + npm link) replacing `npm run sync:*`; `khipu sync` (list), `khipu sync all` (daemon: sync=>index=>wait, `--once` for cron), `khipu sync <platform>[@account]` (one-shot debug), `--force` (re-read all + reindex). Dependencies: sync-watcher, incremental-sync, semantic-search, multi-account
- [x] telegram-image-sync -- Download Telegram photo messages via GramJS `client.downloadMedia()`, store locally, OCR with local model, add `ocr_text` column + `get_image` MCP tool; establishes shared image storage convention. Dependencies: platform-abstraction
- [x] image-support -- Umbrella: make image messages (across platforms) visible to search, semantic search, and MCP. Combines telegram-image-sync infrastructure with iMessage attachment extraction and Signal image sync. Dependencies: telegram-image-sync, signal-platform
- [x] signal-platform -- Sync Signal chats and text messages via Beeper Desktop MCP connector (not direct DB access); implements `PlatformAdapter`; ingests into `chats`/`messages` tables using existing MCP tools. Dependencies: platform-abstraction
- [x] signal-image-sync -- Download and OCR Signal image attachments via Beeper's attachment API, reusing storage + OCR pipeline from telegram-image-sync. Dependencies: signal-platform, telegram-image-sync
- [x] setup-wizard -- Interactive `khipu setup-env` bash script that detects missing `.env` variables and prompts for each with a precise generation link (URL + click path), plus a per-platform token-acquisition doc. Dependencies: multi-account
- [x] facebook-messenger -- Sync Facebook Messenger chats + text/image messages via Beeper Desktop API (network filter = facebook), mirroring the signal-platform adapter; registers a new `facebook` platform. Dependencies: signal-platform, platform-abstraction

## Phase 3 (2026-09-11 last-day batch) — Specs (dependency order)
All Phase 1/2 specs above are implemented and validated. This phase adds new query surfaces and platform reach. Discovery + viability research recorded in each spec's brief.md.
- [x] ollama-mcp -- Local-LLM query surface: `khipu ask "<question>"`. Extract shared `tool-registry.ts` (`TOOL_DEFINITIONS` + `dispatchTool`) from mcp.ts, add `src/ask.ts` Ollama tool-call loop reusing all 9 query handlers, add `ask-parity` test. Dependencies: none (reuses existing handlers)
- [x] sync-account-routing -- Fix the one-shot per-platform sync entrypoints (`khipu sync <platform>@<account>`) to honor `--account` via loadRegistry/credentialsFor instead of the hardwired `default` adapter; generalizes across all 6 env-based platforms; fix `watch.ts isConfigured()` to treat config-file-only accounts as configured. Closes the "Slack multi-account" candidate. Dependencies: multi-account
- [x] zalo-sync -- Zalo personal adapter via `zca-js` (MIT) QR-session, whatsapp-web.js-style; live capture + best-effort recent-window backfill (NOT full history); registers `zalo` platform. Dependencies: platform-abstraction
- [x] signal-direct -- Beeper-independent Signal path: `signal-cli` daemon (JSON-RPC over socket, run as a separate GPLv3 process) linked as a secondary device; live-from-link-forward sync into existing chats/messages tables + image pipeline. Full back-history is best-effort/unverified (45-day media cap). Dependencies: signal-platform, platform-abstraction

## Phase 4 (2026-11-12 discovery) — Specs
Discovery + viability research recorded in each spec's brief.md/research.md.
- [ ] zalo-full-history -- Recover full Zalo DM history (not just live-sync/recent-window) by reading the official Zalo PC desktop app's already-decrypted renderer store via the Chrome DevTools Protocol (CDP) — a pure local read of the user's own authenticated session, no new server-facing calls, lower risk than the existing live zca-js adapter. DM full-history APIs were confirmed removed server-side by Zalo; this is the only viable recovery mechanism found. **Unverified on macOS** (prior art `baok1210/ZaloBackup` is Windows-only) — first task/milestone is an explicit go/no-go spike confirming the renderer-store shape and CDP-attach flow against a real macOS Zalo PC install before the rest of the importer is built. Dependencies: zalo-sync. Next: `/kiro-spec-init zalo-full-history`.
- [x] facebook-direct -- Discovery concluded **not recommended**: no first-party "linked device" mechanism exists for Facebook Messenger (unlike Signal); every technical path (unofficial fca-unofficial-style session emulation, browser automation) is a ToS violation with real account-ban risk, and the main unofficial library was archived May 2026. Staying on the Beeper adapter for Facebook Messenger is the pragmatic choice. No requirements/design/tasks generated; not proceeding unless the risk tradeoff is explicitly revisited.

## Phase 5 (2026-11-12 discovery): Important-message alerting
Scenario driving this phase: a new transaction lands in Slack `#08-expedition`, which means an ADV report must be generated. khipuchat, always running on a cloud server, sees the message within minutes, an intermediate LLM (Muse Spark, or a local Ollama model) triages it with knowledge of whether the user's phone and laptop are together and where, decides it is important, and pushes a notification to the right device (and, later, kicks off the action itself).

### Phase 5 approach decision
- **Chosen**: Cloud VM hub. khipuchat runs on a Linux server the user controls (Docker). Sources that work on Linux run there (Slack, Telegram, Discord, Email, Signal via signal-cli). macOS-only sources (iMessage, WhatsApp session, Zalo) stay on the Mac and are out of scope for the cloud box in this phase.
- **Slack access**: browser session token (`xoxc-` + `d` cookie) backend as the default, already accepted by `src/platforms/slack/client.ts`. Works on every workspace the user can log into, admin or not, with no app install. Official `xoxp` app remains an option where installable. Polling, short interval for watched channels.
- **Triage LLM**: Muse Spark via Meta Model API (OpenAI-compatible, tool calling, US-only preview) behind a provider abstraction; Ollama stays as the local option. Note: `muse.ai` (Meta's consumer Muse agent) has no public API, so it cannot be the intermediate assistant.
- **Location**: phone via OwnTracks (HTTP mode, posts to khipuchat), laptop via a launchd user agent wrapping CoreLocationCLI. Co-location computed server-side (distance + staleness thresholds).
- **Notifications**: ntfy as the hub, Pushover for critical iOS alerts that bypass Do Not Disturb, Telegram bot as a cheap fallback.
- **Why**: matches the "always on, in the cloud" requirement and khipuchat's goal of REPLACING Beeper (no Beeper dependency added anywhere in this phase).
- **Rejected alternatives**:
  - Beeper Slack bridge / headless Beeper Desktop: rejected, khipuchat exists to replace Beeper.
  - Own Slack app (`xoxp`) only: blocked on workspaces with "require app approval"; non-Marketplace apps throttled to ~1 req/min for history since 2026-03-03.
  - Reading Slack desktop's local cache (LevelDB/IndexedDB): incomplete, undocumented, Mac-only; kept as a possible later spike (CDP read like zalo-full-history) only.
  - Apple Find My cache for location: encrypted since macOS 14.4, fragile decryptors.
  - Home Mac Mini hub: keeps all sources but is not the requested cloud server; Hybrid (Mac collector + cloud brain): most coverage, most moving parts, deferred.

### Phase 5 constraint changes (supersede the Constraints section above for this phase)
- **"Self-hosted only, no external services, no cloud" is rewritten**: khipuchat MAY run on a cloud server the user controls, and MAY send message content to an opted-in cloud LLM (Muse Spark) and to notification services (ntfy/Pushover/Telegram). Each outbound flow is explicit, configured, and logged. Local-only remains the default when nothing is configured.
- **"MCP communicates via stdio only"** stays for MCP. New HTTP ingress (location reports, notification action callbacks) is a separate authenticated endpoint, never the MCP channel.
- **"Sending messages on any platform" stays out of scope**: notifications go to the user only. Replying on Slack is not in this phase.
- No new Beeper dependency.

### Phase 5 specs (dependency order)
Cross-spec decisions binding all Phase 5 specs: `.kiro/specs/phase5-cross-spec-decisions.md`.
- [x] cloud-deployment -- (P1) Make khipuchat run unattended on a Linux server: fix Dockerfile (Node 24), DB volume path, compose sync loop; Linux-safe platform gating replacing hardcoded `LOCAL_ONLY_PLATFORMS`; authenticated HTTP ingress for later specs; secrets and backup guidance. Dependencies: none
- [x] message-events -- (P1) Durable "new message" event stream: `insertMessage` distinguishes insert vs update, `pollCycle` records new rows into a `message_events` outbox with consumer cursors (at-least-once); consumers are pluggable. Dependencies: none (owns `src/schema-registry.ts`, `src/daemon-services.ts`, `src/daemon-wiring.ts`, the CLI-entry pattern (D14), and the daemon sync-time write formerly listed as watch-lastsync)
- [x] llm-provider -- (P1) Provider abstraction behind `ask.ts`'s `AskClient`: Ollama (existing), OpenAI-compatible (Muse Spark via Meta Model API as first target), structured-output support; per-provider config and an explicit "content leaves the machine" opt-in. Dependencies: none
- [x] slack-all-workspaces -- (P1) Slack access on every workspace the user belongs to without admin: session-token (`xoxc`+`d`) backend as default with token-expiry detection and re-auth flow, `xoxp` kept where installable; thread replies (`conversations.replies`); per-channel poll interval so watched channels are near-realtime; fix `is_sender` and channel type mapping. Dependencies: cloud-deployment, message-events
- [x] presence-context -- (P2) Phone + laptop location ingestion (OwnTracks HTTP endpoint, laptop launchd reporter), `device_locations` table, co-location + place resolution, `get_presence` tool on MCP/CLI/ask surfaces. Dependencies: cloud-deployment, message-events (schema registry)
- [x] triage-agent -- (P1) Consume message-events, rule prefilter (watchlist e.g. `#08-expedition`, keywords, senders), build context (message + thread + presence), LLM returns structured verdict {important, urgency, reason, suggested_action}; decision log for audit/tuning; `khipu triage` CLI to replay/test. Dependencies: message-events, llm-provider, presence-context, cloud-deployment; soft: slack-all-workspaces (rules lint)
- [x] notifier -- (P1) Delivery channels ntfy / Pushover / Telegram bot; presence-aware routing (together = laptop/desktop, apart = phone; critical = Pushover); dedupe, rate limit, quiet hours; delivery log. Dependencies: triage-agent, presence-context, cloud-deployment (ingress + signed capability links), message-events, slack-all-workspaces (account health)
- [x] action-runner -- (P3) "Do the action": allowlisted action registry (first: generate ADV report by invoking a user-provided command), ask-first approval via notification action buttons, optional auto mode per action; run log. The ADV report generator itself is not owned here. Dependencies: triage-agent, notifier, cloud-deployment, message-events (daemon-services, daemon-wiring, schema-registry), presence-context (launchd plist helper)

### Phase 5 direct implementation candidates (found during discovery scan)
- [x] watch-lastsync -- absorbed by message-events (decision D1): `src/watch.ts` never calls `setPlatformLastSyncedAt`, so the daemon's `since` never advances; without it every daemon event is `backfill` and triage ignores it.
- [ ] setup-sync-stale-path -- `src/setup-sync.ts` launchd plist points `SYNC_SCRIPT` at nonexistent `src/sync.ts`. Use presence-context's shared `src/launchd-plist.ts` helper once it exists (decision D9).
- [x] ci-node-24 -- absorbed by cloud-deployment task 7.4 (Node 24 + `[master, main]` triggers); do not open a separate PR.
- [ ] beeper-base-url -- not needed for Phase 5; noted only: `http://localhost:23373` is hardcoded in 3 legacy Beeper clients, which are slated for replacement anyway.

## Existing Spec Updates
- [x] web-ui -- extended by web-ui-enhancements (chat layout + semantic search UI)
- [x] platform-abstraction -- extended by incremental-sync (PlatformAdapter interface addition)
- [x] platform-abstraction -- extended by multi-account (schema `account` dimension + account-aware adapter interface)

## Existing Spec Corrections (2026-07-11 quality pass — see .kiro/brief.md)
- [x] sync-watcher -- poll cycle must ALSO run embedding indexing after a successful sync (sync => index => wait); entry point becomes `khipu sync all`; support `--once` single-pass. Correction appended to requirements.md.
- [x] incremental-sync -- rename/alias `--backfill` to `--force`; `--force` additionally rebuilds embeddings; `sync_state` keyed by (platform, account) once multi-account lands. Correction appended to requirements.md.
- [x] semantic-search -- indexing is invoked automatically by the watch loop after each sync and by `--force`; add `khipu index` entry point. Correction appended to requirements.md.
- [x] release -- Docker, README, and CI must use the `khipu` CLI (global install / npm link) instead of `npm run sync:*` and raw `tsx`. Correction appended to requirements.md.

## Direct Implementation Candidates
- [x] mcp-test-script -- `scripts/test-mcp.sh` (portable stdio JSON-RPC smoke test for all 8 MCP tools) + `.claude/skills/mcp-testing/SKILL.md`. Implemented 2026-09-11; verified against the live 950MB DB (server starts, lists all tools, handlers return valid JSON).

## Future Candidates (not yet scoped)
- Facebook Groups (research needed: API access model)
- SMS sync (research needed: macOS/Android bridge)
- React web UI (vs current plain HTML; tradeoff: complexity vs richer UX)
- Remote/cloud deployment option (Mac Mini, VPS)
- Signal full back-history importer (local plaintext-backup / signalbackup-tools parser — the only route to complete text + pre-45-day images; fallback for signal-direct's link-forward limitation)
