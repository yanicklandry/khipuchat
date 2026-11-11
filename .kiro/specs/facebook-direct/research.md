# Research & Design Decisions

## Summary
- **Feature**: `facebook-direct` (evaluated, not pursued)
- **Discovery Scope**: Viability research only — evaluating a Beeper-free Facebook Messenger path analogous to `signal-direct`.
- **Key Findings**:
  - No first-party "linked device" or personal-API mechanism exists for Facebook Messenger, unlike Signal's `signal-cli`.
  - The main unofficial Node.js Facebook Chat API (`dongp06/fca-unofficial`) was **archived May 2026**; forks exist but maintenance is inconsistent and none offers a stable long-term contract.
  - All viable technical paths (unofficial session-emulation APIs, browser automation) are reverse-engineered, violate Facebook's ToS, and carry real account-ban/checkpoint risk — a different risk class than Signal device linking.
  - Facebook's bot/automation detection is materially more aggressive than WhatsApp Web's or Zalo's, making a `whatsapp-web.js`/`zca-js`-style browser-automation adapter the most fragile and highest-risk option in the project.
  - The official Meta Graph API's Messenger Platform only covers Pages/Business accounts, not personal DMs — not applicable.
  - Beeper's own Facebook bridge runs on `mautrix-meta`, a maintained Matrix bridge built on the same class of reverse-engineering this research would otherwise reimplement. Self-hosting it directly transfers maintenance burden without reducing ToS/ban risk.

## Research Log

### Unofficial Facebook Chat API libraries (Node.js)
- **Context**: Is there a `zca-js`/`whatsapp-web.js`-equivalent for Facebook Messenger?
- **Sources Consulted**: GitHub search for `fca-unofficial` and forks (`dongp06/fca-unofficial`, `yohannzapata/fca-unofficial`, `@dongdev/fca-unofficial` on npm, `@anbuinfosec/fca-unofficial`, `XaviaTeam/fca-unofficial`).
- **Findings**: `dongp06/fca-unofficial` (the most-referenced fork, v4.0.3) was archived May 9, 2026 — read-only. `yohannzapata/fca-unofficial` is an early-stage TypeScript rewrite that "cannot receive messages yet" per its own README. Several other forks exist on npm with varying, generally low, maintenance activity. No search hit for "ws3-fca" specifically, suggesting it is not (or no longer) a distinct prominent project.
- **Implications**: There is no single library in this space with the maintenance stability `zca-js` or `whatsapp-web.js` offer. Betting a sync adapter on any fork risks total breakage with no upstream fix path.

### Risk class vs. signal-cli
- **Context**: Compare the ToS/ban risk profile against the Signal device-linking approach that `signal-direct` already shipped.
- **Findings**: Signal's secondary-device linking (`sgnl://linkdevice`) is an official, first-party feature of the Signal protocol/ecosystem — `signal-cli` is a legitimate client implementing it. Facebook has no equivalent first-party personal-access mechanism; every technical option found is an unofficial reverse-engineering of private, unversioned internal APIs or a browser-automation session against a service with explicit anti-automation measures.
- **Implications**: The two platforms are not analogous in risk. Replicating `signal-direct`'s approach 1:1 for Facebook is not possible because the underlying legitimacy gradient doesn't exist on Facebook's side.

### Official Graph API scope
- **Context**: Does Meta's official Messenger Platform cover personal 1:1 DMs?
- **Findings**: The Messenger Platform (Graph API) is scoped to Pages/Business messaging, not personal user-to-user conversations. No official API surface exists for what khipuchat needs here.
- **Implications**: Ruled out — not a path to personal-account message sync at all.

### What Beeper actually does for Facebook
- **Context**: Understand what dependency "replacing Beeper" would actually be removing.
- **Findings**: Beeper's Facebook/Instagram bridge is built on `mautrix-meta`, itself a reverse-engineered bridge against Facebook's internal APIs (the same risk class as the Node.js fca-unofficial forks, just Go-based and maintained by a dedicated team).
- **Implications**: Self-hosting `mautrix-meta` (or an equivalent) directly would not reduce ToS exposure — it would only move the maintenance burden from Beeper's team onto the user, while keeping the same underlying risk. Not a meaningful win.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Unofficial fca-* library adapter | New `PlatformAdapter` using a Node fca-unofficial fork | Would reuse the existing `PlatformAdapter`/ingestion/media pipeline | Primary upstream archived; forks unstable; ToS violation; account-ban risk; breaks silently on FB API changes | Rejected |
| Browser automation (Puppeteer/Playwright on messenger.com) | Mirror `whatsapp-web.js`/`zca-js` shape | Reuses session-based adapter pattern already proven for WhatsApp/Zalo | Facebook's bot detection is the most aggressive of any platform in this project; highest fragility and ban risk | Rejected |
| Self-host `mautrix-meta` directly | Run the same bridge Beeper runs, but locally | No Beeper dependency in name | Same ToS/ban risk as Beeper's bridge, now on the user's own infra; pure maintenance-burden transfer, not a risk reduction | Rejected |
| Stay on Beeper for Facebook (chosen) | Keep `@beeper/desktop-api` as-is for this one platform | Beeper absorbs maintenance + risk; already working | Facebook Messenger remains the one platform requiring Beeper | Recommended |

## Design Decisions

### Decision: Do not pursue a direct Facebook Messenger adapter
- **Context**: User wants khipuchat to fully replace Beeper for MCP message access.
- **Selected Approach**: Decline to build; document why; leave `facebook` on the existing Beeper adapter.
- **Rationale**: Every alternative found is strictly worse than staying on Beeper on both maintenance-stability and risk-to-the-user's-own-account axes — unlike Signal, there is no first-party-sanctioned alternative to reach for.
- **Trade-offs**: Full Beeper independence is not achievable for this one platform without accepting meaningfully higher risk than every other adapter in the project. Signal (`signal-direct`) is the only platform where Beeper has been fully removed as a dependency.
