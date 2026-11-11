# Brief: facebook-direct

## Problem
Facebook Messenger sync currently depends on Beeper Desktop running locally (`@beeper/desktop-api`, `BEEPER_ACCESS_TOKEN`), same as Signal did before `signal-direct`. The user wants khipuchat to fully replace Beeper as a dependency for MCP message access (not the visual client — just the sync path). This brief evaluates whether a Beeper-free Facebook Messenger path is viable, mirroring `signal-direct`'s approach.

## Current State
`src/platforms/facebook/sync.ts` implements `PlatformAdapter` over Beeper's local API (network filter = `facebook`), reusing the signal-platform pattern. `'facebook'` is in the `Platform` union. The schema, image pipeline, and ingestion helpers are platform-agnostic and reusable by any future adapter.

## Desired Outcome (if viable)
A Facebook Messenger sync path that requires no Beeper, analogous to `signal-cli` for Signal: ingest chats + text/image messages into the same `chats`/`messages` tables, selectable independently of the Beeper adapter.

## Viability Research — Conclusion: NOT RECOMMENDED

Unlike Signal, there is no maintained, sanctioned "linked device" mechanism for personal Facebook Messenger access. Every direct path found carries materially higher risk than `signal-cli`:

1. **Unofficial Facebook Chat API libraries** (`fca-unofficial` and its forks: `ws3-fca`, `@dongdev/fca-unofficial`, `@anbuinfosec/fca-unofficial`, etc.) — reverse-engineer Facebook's internal GraphQL/MQTT protocol via cookie/session emulation (login as if from a browser). Findings:
   - The most-used upstream (`dongp06/fca-unofficial`) was **archived in May 2026** — read-only, no further maintenance.
   - Numerous competing forks exist with inconsistent maintenance; none is a stable long-term dependency.
   - These libraries explicitly violate Facebook's Terms of Service (automated/unofficial access to a personal account) and have a history of triggering account checkpoints, 2FA re-challenges, and outright bans — a materially different risk class than `signal-cli`, which Signal's own ecosystem tolerates (device linking is a first-party feature).
   - They break whenever Facebook changes internal API shapes, with no advance notice (no public API contract to track).

2. **Browser automation** (Puppeteer/Playwright driving messenger.com, like `whatsapp-web.js`/`zca-js` do for WhatsApp/Zalo) — Facebook has materially more aggressive bot/automation detection than WhatsApp Web or Zalo (behavioral fingerprinting, surprise checkpoints). This increases ban risk further and would be the most fragile adapter in the project.

3. **Official Meta Graph API (Messenger Platform)** — only available for **Pages/Business accounts**, not personal 1:1 DMs. Not applicable to this use case at all.

4. **Matrix bridges** (e.g. `mautrix-meta`) — this is in fact what Beeper's own Facebook bridge is built on. Running it directly would mean self-hosting the same reverse-engineered bridge Beeper already runs and maintains for you, for no meaningful reduction in fragility or ToS exposure — only a maintenance-burden transfer, not a risk reduction.

## Recommendation
**Do not build a direct Facebook Messenger adapter.** The risk profile (account ban, ToS violation, high breakage rate, zero first-party tolerance) is categorically worse than Signal's `signal-cli` path, where device linking is an officially supported feature. Staying on Beeper for Facebook Messenger is the pragmatic choice: Beeper absorbs the reverse-engineering/maintenance burden and risk on your behalf via `mautrix-meta`, rather than you running the same unofficial bridge directly against your own account.

**Partial Beeper independence is achievable today**: Signal already has a Beeper-free path (`signal-direct`, merged). Facebook Messenger is the one remaining platform with a hard Beeper dependency; no other khipuchat-supported platform requires it.

## Scope
- **In**: this research only (brief + research docs); no requirements/design/tasks generated.
- **Out**: any implementation. If the user wants to accept the risk anyway, a future spec would need to explicitly acknowledge ToS/ban exposure as a requirement-level constraint, not an afterthought.

## Status
Discovery complete. **Not advanced to requirements** pending explicit user sign-off on the risk tradeoff.
