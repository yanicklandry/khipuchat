# Brief: zalo-full-history

## Problem
`zalo-sync` is live-sync-only: `zca-js` has no reliable DM full-history API (Zalo removed the server-side endpoint that would have supported it — confirmed by a zca-js maintainer), so a user's pre-link Zalo conversation history is a permanent blind spot in an otherwise unified local archive. This mirrors `signal-direct`'s link-forward-only limitation, listed as a separate "Zalo full-history fidelity" future candidate in the roadmap rather than folded into `zalo-sync` itself, since it needs a fundamentally different mechanism.

## Current State
`src/platforms/zalo/` implements a live/recent-window adapter via `zca-js`'s listener API (`zalo-sync` spec, done). No historical import path exists. `zca-js`'s only history-adjacent addition since `zalo-sync` was researched is `getGroupCloudChatHistory()` — confirmed **group-only**; khipuchat's Zalo scope is DM-only, so this doesn't help.

## Desired Outcome
A one-shot `khipu import zalo-history` (working title) command that reads already-synced Zalo DM history directly from the official Zalo PC desktop app (which the user already has installed and already has history synced to), and ingests it into the same `chats`/`messages` tables `zalo-sync` uses — visible to every existing query surface without any special-casing.

## Approach
Chosen over two alternatives (official per-conversation "Export Data" UI feature, and accepting the live-sync-only limit permanently — see Research Log for both). Connect to the official Zalo PC desktop app via the Chrome DevTools Protocol (CDP): launch it with `--remote-debugging-port=<port> --user-data-dir=<its own profile dir>` (Chromium 136+ requires the latter alongside the former), attach with `chrome-remote-interface` (MIT), and call into the renderer process's own in-memory message store (reverse-engineered as `Core.Message` by the prior-art Windows/Python tool `baok1210/ZaloBackup`) to paginate and extract already-decrypted DM history, bounded to whatever has synced to that desktop install.

This is a **pure local read of the user's own already-authenticated session** — no new network call to Zalo's servers, no server-facing impersonation — making it lower risk than the existing live `zca-js` adapter, not higher.

**Critical unvalidated risk (viability research):** `baok1210/ZaloBackup` is confirmed Windows-only — its README targets Windows + Python 3.14 with zero Mac testing or instructions anywhere. Zalo PC is confirmed to ship an official, Electron-based macOS build (same codebase family as Windows), and CDP attach itself has no known macOS-specific blocker (SIP/Gatekeeper restrict attaching to *someone else's* unmodified process via injection, not a voluntary `--remote-debugging-port` flag at the user's own launch) — but whether the `Core.Message` store shape, the `--user-data-dir` requirement against Zalo's bundled Chromium version, and the pagination cursor logic actually hold on Mac is **genuinely unverified, not just a porting detail**. Requirements must make empirically confirming this the first task/milestone, before committing to the full importer build — same "risk documented, not hidden" posture as `zalo-sync`'s ban-risk disclosure and `signal-direct`'s back-history disclosure.

## Scope
- **In**: CDP attach/launch wrapper for Zalo PC on macOS, a narrow mockable client over the renderer store (tests never launch a real Zalo PC instance), DM-only history pagination + mapping into existing `Chat`/`Message` shapes, ingestion via existing `src/db.ts` functions (idempotent via existing `ON CONFLICT` keys — replays/overlap with live-synced data must not duplicate), an explicit early verification milestone against a real macOS Zalo PC install.
- **Out**: group-chat history (zca-js's `getGroupCloudChatHistory()` is a separate, group-only mechanism — future candidate if ever pursued), sending messages, Windows/Linux support (this project is macOS-first per existing steering), automating the official Export Data UI (documented as a Future Candidate fallback, not built), guaranteeing the renderer-store internals survive future Zalo PC updates.

## Boundary Candidates
- CDP attach/session lifecycle (launch Zalo PC, open debugging port, connect, detach cleanly) vs. renderer-store query/pagination vs. history-to-`Message` mapping vs. ingestion — same seam shape as `signal-cli`'s transport/mapping/ingestion split in `signal-direct`.
- The empirical macOS-verification spike is its own boundary: a go/no-go gate before the rest of the importer is built.

## Out of Boundary
- `src/db.ts` schema and the existing `chats`/`messages` ingestion helpers (reused unchanged).
- `zalo-sync`'s live adapter and its `createZaloAdapter`/`PlatformAdapter` wiring (untouched; this is a separate one-shot import command, not a new `PlatformAdapter` backend).

## Upstream / Downstream
- **Upstream**: `zalo-sync` (shared `chats`/`messages` schema, `platform='zalo'` convention, media-storage conventions if images are added later), `platform-abstraction`.
- **Downstream**: none anticipated; this closes the fidelity gap `zalo-sync` explicitly left open.

## Existing Spec Touchpoints
- **Extends**: none directly (deliberately a separate spec from `zalo-sync`, per the roadmap's existing "Signal full back-history importer" precedent of treating link-forward/live-sync and full-history-recovery as separate specs with different mechanisms).
- **Adjacent**: `zalo-sync` (shares the `zalo` platform's chat/message conventions), `signal-direct` (closest structural precedent: external-process/CDP attach, narrow mockable client wrapper, explicit best-effort/unverified disclosure).

## Constraints
- macOS only (project is macOS-first per existing steering); Node 24, TS strict, files under 200 lines, self-hosted/local-only, synchronous DB.
- `chrome-remote-interface` is MIT — no license contamination.
- **Risk to document, not hide**: the macOS renderer-store shape and CDP-attach flow are unverified prior to implementation (confirmed Windows-only prior art). Requirements must codify an explicit early verification milestone, not assume porting-only effort.
- Bounded by definition: only recovers history already synced to the specific Zalo PC install read, not a guaranteed-complete mirror (same honesty standard as `signal-direct`'s 45-day/link-forward disclosure).
