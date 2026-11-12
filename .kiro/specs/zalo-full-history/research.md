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
