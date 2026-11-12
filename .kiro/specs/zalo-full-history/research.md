# Research & Design Decisions

## Summary
- **Feature**: `zalo-full-history`
- **Discovery Scope**: New spec (full-history recovery mechanism, separate from `zalo-sync`'s live adapter)
- **Key Findings**:
  - Zalo's server-side DM full-history API was deliberately removed (confirmed by a `zca-js` maintainer on GitHub) — no live-sync-library or web-scraping path can recover DM history.
  - The only viable path is reading the official Zalo PC desktop app's own already-decrypted renderer store via the Chrome DevTools Protocol (CDP) — a pure local read of the user's own authenticated session, no new server-facing calls.
  - Prior art (`baok1210/ZaloBackup`) proves the mechanism works on Windows but is confirmed to have zero macOS validation — this project is macOS-first, so the macOS port is a genuine unvalidated research question, not a routine porting task.

## Research Log

### DM full-history via zca-js or Zalo Web scraping
- **Context**: Does any existing library or web-automation approach expose full Zalo DM history?
- **Sources Consulted**: `RFS-ADRENO/zca-js` GitHub repo and issue #374; zca-js PR #397 (`getGroupCloudChatHistory()`); `web.zalo.me` behavior analysis.
- **Findings**: `zca-js` added `getGroupCloudChatHistory()` using `getrecentv2`/`getoldv2` cursor pagination, but a maintainer confirmed in issue #374 this is **group-only** — "Zalo has removed that [1:1] API," with cross-device sync cited as an unreleased future replacement. `web.zalo.me`'s scroll-up lazy-load uses the same underlying cloud cursor pagination internally, so it's just a slower, more fragile proxy for the same removed/restricted endpoint — no advantage, higher automation-detection surface.
- **Implications**: DM history cannot be recovered via any network-facing API (official or unofficial). Ruled out as infeasible, matching the precedent of `signal-cli`'s own documented history-transfer gap in `signal-direct`.

### Zalo PC desktop app local storage
- **Context**: Does the official desktop client expose a local, already-decrypted data source?
- **Sources Consulted**: `thenewnet/zalo-swift-re` (reverse-engineered architecture notes); `baok1210/ZaloBackup` README.
- **Findings**: Zalo PC (Electron-based) stores conversations in SQLCipher-encrypted SQLite shards on disk — direct file parsing is blocked without keys. However, the *running* app decrypts everything into an in-memory renderer-process store for its own UI, reachable via CDP since Electron apps expose a standard Chromium debug port. `ZaloBackup` confirms this is real: it launches Zalo PC with `--remote-debugging-port`, attaches via CDP, and calls the renderer's own store API (observed as `Core.Message`) to paginate `(userId, sendDttm, msgId)`.
- **Implications**: This is the only confirmed-working mechanism for DM full history. It is bounded by definition — only recovers whatever has already synced to the specific desktop install being read, same honesty constraint `signal-direct` applies to its 45-day/link-forward limit.

### Official "Export Data" feature (rejected alternative)
- **Context**: Is there a zero-risk, fully-official export mechanism instead?
- **Findings**: Zalo PC has a genuine built-in Settings → Data → Export Data feature (also a separate "Backup messages" sync feature), zero ban-risk. But it is UI-driven, one conversation at a time, with no documented bulk/automatable API, and export format varies by build version.
- **Implications**: Viable only as a manual, best-effort supplementary path for a single conversation at a time — rejected as the primary mechanism given khipuchat's premise of unified, low-friction archiving. Documented as a Future Candidate fallback, not built.

### macOS viability of the CDP approach (verification pass)
- **Context**: `baok1210/ZaloBackup` targets Windows + Python only. Confirm the mechanism transfers to macOS before committing to full implementation.
- **Sources Consulted**: zalo.me/pc download page (confirms official macOS build); Chromium issue 417456892 (Chrome 136+ `--remote-debugging-port` behavior change); `chrome-remote-interface` npm page (license).
- **Findings**:
  - Zalo PC ships an official macOS build from the same Electron/Chromium codebase family as Windows — not a native rewrite. Confirmed, not a blocker.
  - Chromium 136+ (2025) requires `--user-data-dir` alongside `--remote-debugging-port` when not using the default profile directory — a Chromium-level change that may apply depending on which Chromium version Zalo's current Electron build embeds. Untested against Zalo PC's actual bundled version.
  - `chrome-remote-interface` is MIT-licensed — no contamination risk.
  - No evidence of Zalo detecting/blocking remote debugging; since the flag is passed at the user's own voluntary launch (not process injection), macOS SIP/Gatekeeper/notarization are not expected to block attachment — those restrict attaching to *someone else's* unmodified process, not a self-opened loopback debug port.
  - `ZaloBackup`'s README explicitly states "Built around Zalo PC v26.8.20 on Windows, Python 3.14," ships a prebuilt `.exe`, and gives zero Mac instructions or testing claims anywhere.
- **Implications**: No disqualifying blocker found, but the `Core.Message` store shape and pagination cursor behavior on macOS's Zalo build are **genuinely unverified** — this must be the first task/milestone (an explicit go/no-go spike), not an assumed detail folded into general implementation estimates.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| CDP read of Zalo PC's own renderer store (chosen) | Launch/attach to the official desktop app via CDP, read its already-decrypted in-memory message store | Pure local read of an already-authenticated session; no new server-facing calls; lower risk than the existing live `zca-js` adapter | macOS behavior unverified (Windows-only prior art); bounded to history already synced to that device; depends on reverse-engineered, undocumented renderer internals that could change on a Zalo PC update | Closest structural precedent: `signal-direct`'s external-process/narrow-client-wrapper shape |
| Official Export Data UI automation | Parse files from Zalo PC's built-in per-conversation export feature | Zero risk, fully official | No bulk/automatable export API; one conversation at a time; format varies by build | Rejected as primary; kept as a documented manual fallback |
| zca-js / web-scraping DM history | Reuse the existing live adapter's library, or scroll-scrape web.zalo.me | Would reuse existing `zalo-sync` infrastructure | Server-side DM history API confirmed removed by Zalo; scraping is a fragile proxy for the same removed/restricted endpoint with higher automation-detection risk | Rejected as infeasible (confirmed, not speculative) |
| Accept live-sync-only, no new spec | Document the limitation permanently, like the `facebook-direct` outcome | Zero effort | Leaves a real, closeable gap unaddressed when a lower-risk mechanism exists | Rejected — unlike Facebook Messenger, a viable lower-risk path exists here |

## Design Decisions

### Decision: CDP-based desktop-app reader, with an explicit macOS verification milestone as the first task
- **Context**: The only confirmed-working mechanism for DM full history is a reverse-engineered, Windows-validated-only technique; this project targets macOS.
- **Selected Approach**: Treat empirically confirming the renderer-store shape and CDP-attach flow against a real macOS Zalo PC install as a go/no-go gate before building the rest of the importer, rather than assuming the Windows implementation ports cleanly.
- **Rationale**: Matches the project's established "risk documented, not hidden" standard (`zalo-sync`'s ban-risk disclosure, `signal-direct`'s back-history disclosure) — the scope estimate must reflect a real chance the first milestone is "confirm this works on Mac at all."
- **Trade-offs**: If the macOS verification spike fails (renderer-store shape differs, CDP attach is blocked in some unforeseen way), the spec may need to be revisited or closed similarly to `facebook-direct`'s "not recommended" outcome — this is an accepted, explicit possibility, not a hidden risk.

## Design-Phase Research (2026-11-12)

### Zalo PC on this Mac (read-only bundle inspection, app not driven)
- **Findings**: `/Applications/Zalo.app`, bundle `com.vng.zalo`, version 26.11.10, Electron 22.3.9 / Chromium 108.0.5359.215, universal binary, hardened runtime. Runs with `--user-data-dir=~/Library/Application Support/ZaloData`. `app.asar` contains `webpackJsonp`, modules `XS0u` / `fBUP` / `z0WU`, and `getMessageFromConversationByLimit`, `countTotalMessageOfConversation`, `getConversations`. No `remote-debugging` string (the app does not block the flag). Calls `requestSingleInstanceLock`, so Zalo must be fully quit before relaunching with flags.
- **Implications**: The ZaloBackup mechanism very likely transfers to macOS (LIKELY, not run live). The Chromium 136 `--user-data-dir` rule does not apply (Chromium 108). The go/no-go task remains mandatory.

### ZaloBackup (baok1210/ZaloBackup) observations
- **Findings**: Store via `window.webpackJsonp.push([[Math.random()],{},[["XS0u"]]]).default`. `getUserId()`, `getMe()`, `getConversations()`, `getMessageFromConversationByLimit(uid, 500, {count, fromMsg:{sendDttm,msgId}})` returns rows newest first. History ends on a short page. Rows: `msgId`, `cliMsgId`, `fromUid` ("0" = me), `toUid`, `sendDttm` (ms string), `msgType` (2 photo, 7 sticker, 18 video, 19 file, 6 link/call), `message` (string or object), `dName`, `serverTime`. Multi-device duplicates share `cliMsgId`, and the phone copy's `msgId` carries a `_NNN` suffix. `countTotalMessageOfConversation` is unreliable. `fBUP.getHistoryMessage` is group-only (404 for DMs).
- **Licence**: none declared. Reimplement from observations only; do not copy code.

### Build vs adopt: CDP client
- **Options**: `chrome-remote-interface` 0.34.0 (MIT, maintained), puppeteer-core (already transitive via whatsapp-web.js), or Node 24 global `WebSocket` + `fetch`.
- **Decision**: Built-in. Only `/json/list`, `/json/version`, and `Runtime.evaluate` are needed. Zero new dependencies, and easy to fake in tests. `chrome-remote-interface` is the documented fallback.

### Codebase integration findings
- `insertMessage` returns void and its conflict branch updates, so added vs present is counted with a `getMessageIdByExternalId` pre-check (no `db.ts` change).
- No Zalo own-uid is persisted anywhere. Introduce an optional `ZALO_UID` account field for the mismatch check (5.4).
- `mapChat`/`mapMessage` in `zalo/sync.ts` are pure and are reused for identity parity. `mapMessage` emits `other` and drops captions for non-text, so the importer refines type and text afterwards.
- `sync_state('zalo', account)` is written only by `runPlatformSync`, so the importer avoids that path (5.6).

## Synthesis Outcomes
- **Generalization**: None worth taking. A generic "Electron app history reader" has no second consumer.
- **Build vs adopt**: Adopt the zalo-sync mappers and db helpers. Build the minimal CDP client (above).
- **Simplification**: No separate "transport" vs "session" layer. One `cdp.ts`, with process control isolated in `app-control.ts` so tests fake it. No dry-run mode, filters, or throttling (removed in requirements review).

## macOS go/no-go result (2026-11-12): **GO**

Probe: a throwaway CDP script (scratchpad, not committed) using `src/platforms/zalo/history/cdp.ts`, run 4 times against this Mac. No message text was printed. After every run Zalo PC was quit and relaunched normally.

- **Environment**: Zalo PC 26.11.10, `Chrome/108.0.5359.215`. Quitting via `osascript` worked every time (no force-kill needed). Launching `Contents/MacOS/Zalo --remote-debugging-port=<random>` works; no `--user-data-dir` is needed.
- **Targets**: 3 `page` targets: `pc-dist/index.html` (the one to use), `pc-dist/znotification.html`, `pc-dist/shared-worker.html`. Match on `/index.html`, not just `index.html`.
- **Store**: `window.webpackJsonp` exists and module `XS0u` resolves. `getUserId`, `getMe`, `getConversations`, `getMessageFromConversationByLimit` and `countTotalMessageOfConversation` are all functions. `getUserId()` returns the logged-in uid. The store needs a few seconds after page load before `getUserId()` is non-empty, so poll it.
- **Conversations**: 123 in total. `getConversations()` returns an array, and the conversation id is in `userId`.
  - Groups: `isGroup === true` on exactly 2 conversations, which are also the only 2 with a `g` id prefix (type 1).
  - **Official Accounts**: `oaInfo` is truthy (types 5 and 7; 7 conversations).
  - DMs: type 0 or type undefined, with no `oaInfo`.
  - `isGroup` is never null here.
- **Message rows**:
  - `msgId`, `cliMsgId`, `fromUid`, `toUid`, `sendDttm` (epoch ms), `serverTime` and `dName` are all non-empty strings, `msgType` is a number, and `toUid` equals the conversation uid.
  - Direction: `fromUid` is `"0"` for sent messages and the contact's uid for received ones.
  - **Text** (msgType 1): `message` is a string; `content` and `msgText` are null.
  - Location (17): `message` is an object with `title`, `desc`, `lat`, `lo`.
  - Card/link (25): `message` is an object with `title`, `description`, `href`.
  - **Captions must check `title`, then `description`, then `desc`.**
  - Other msgTypes seen: 21 and 52 (one bulk sender), not mapped. The ZaloBackup mapping (2 image, 7 sticker, 18 video) was not observed on this install and remains unverified.
- **Ordering and paging**: inside a page, rows come **oldest first**. Each next page (cursor = `{sendDttm, msgId}` of the oldest row) is strictly older, the cursor row is excluded, and there are no duplicates.
  - With `LIMIT=20`: 52 messages in 3 pages and 199 messages in 10 pages (back to 2022-11-10). Both totals match `countTotalMessageOfConversation`.
  - The history ends on a short page.
  - No `_NNN`-suffixed msgIds appeared in these chats, so the multi-device collapse is still unexercised.
- **msgId parity with zalo-sync: CONFIRMED**. 3 of 3 live-captured ids (2 received, 1 sent) are identical to Zalo PC's `msgId`. `cliMsgId` differs. Dedupe on `(external_id = msgId, chat_id)` works with no `db.ts` change.
- **Fidelity observation**: Zalo PC only holds what has synced to this install. The test DM goes back only 3 days; the largest DM has 199 messages. Users wanting deeper history must first use Zalo PC's own "sync messages from phone" feature. Document this in 4.1.
- **Verdict: GO.** No design change required. Implementation notes recorded in tasks.md.
