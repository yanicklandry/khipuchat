# Code Review & Testing Report

_Generated 2026-07-14. Scope: current `master`, focus on recently-added image-sync features and overall test coverage._

## Summary

- Full suite: **975 tests / 44 files, all passing** on Node 24 (the pinned version).
- Added **1 new test file** (`tests/web-icons.test.ts`, 5 tests) covering the one genuinely-untested pure module found.
- The remaining coverage gaps are **not unit-testable without live platform credentials** or a browser DOM. They are listed as a manual/integration TODO below.

## What I fixed / added this pass

### 1. Environment: native module was built for the wrong Node
`better-sqlite3-multiple-ciphers` was compiled against Node 26, but the repo pins Node 24 (`.nvmrc`). Every DB-backed test failed with `NODE_MODULE_VERSION 147 vs 137` until I ran `npm rebuild better-sqlite3-multiple-ciphers` under Node 24. Node 26 additionally crashes V8 during the run.

**Recommendation (code review):** add an `engines` field to `package.json` and document the rebuild step, so `npm install` under the wrong Node fails loudly instead of at test time:
```json
"engines": { "node": ">=24 <25" }
```

### 2. New unit test: `web/icons.ts`
`buildPlatformIconMap()` was the only pure, self-contained function with **zero** test coverage (it's embedded into the web UI as `PLATFORM_ICONS`). Added `tests/web-icons.test.ts` asserting: known platforms present, unknown platforms (slack/signal) omitted for letter-fallback, 16px sizing, `currentColor` fill, `xmlns` stripped, and JSON-serialisability.

## Coverage map (source ↔ tests)

Well-covered (unit + e2e): `db`, `db-migrations`, `vec-db`, `embeddings`, `ocr`, `media-storage`, `image-handlers`, `mcp`, `cli`, `cli-filters`, `khipu*`, `query-handlers`, `sync-runner`, `sync-all`, `watch`, `account-registry`, `config`/`saveSessionString`, and all platform `sync.ts` modules (mocked clients).

New image-sync features — **unit-tested with mocked transports**: `telegram/image-sync`, `signal/image-sync`. Image support is only implemented for **telegram, signal** (whatsapp/discord/slack/email/imessage do not store media yet).

### Remaining untested code (and why)

| Area | Why not unit-tested | Recommended test type |
|---|---|---|
| `web/ui-scroll.ts` (`SCROLL_JS`) | Browser JS string blob: `IntersectionObserver`, `fetch`, DOM. Infinite-scroll + retry logic has **zero** coverage. | jsdom component test or Playwright e2e |
| `web/ui-chats.ts` (`CHATS_JS`) | Browser JS string blob: chat list render, platform filter. | jsdom or Playwright |
| Live platform transports (`*/client.ts`) | Require real accounts/tokens or Beeper Desktop; only mocked interfaces are tested. | Manual/integration (see below) |

## TODO — manual / integration testing of remaining features

You have **Telegram** and **WhatsApp** configured. The unit tests mock every transport, so the real network/credential paths for the other platforms have never actually run. Work through these per platform.

### Can do now (you have credentials)
- [ ] **Telegram image sync (newest feature):** run `npm run sync:telegram`, then confirm images land in `MEDIA_DIR`, thumbnails/paths resolve in the web UI (`npm run web`), and OCR text is searchable via `khipu search`. This is the highest-value manual check since it's the last thing built.
- [ ] **WhatsApp:** `npm run sync:whatsapp` (needs `WHATSAPP_SESSION` / QR pairing). Verify chats + messages import and are idempotent on a second run. (No image support implemented yet — confirm that's expected.)
- [ ] **Web UI infinite scroll:** open a long thread in `npm run web`, scroll up, confirm older messages page in, scroll position is preserved, and the Retry button appears on a forced network error. (Compensates for the untested `SCROLL_JS`.)

### Needs credentials/config you don't have yet
For each: set the env vars (or `khipu.config.json` entry), run the sync, then verify import + idempotency + web UI rendering.

- [ ] **Signal** — `BEEPER_ACCESS_TOKEN`, Beeper Desktop running. Also verify **Signal image sync** (implemented, only mock-tested). `npm run sync:signal`.
- [ ] **Discord** — `DISCORD_TOKEN`. `npm run sync:discord`.
- [ ] **Slack** — `SLACK_USER_TOKEN` (per-account for multi-account). `npm run sync:slack`.
- [ ] **Email/IMAP** — `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASS`. `npm run sync:email`.
- [ ] **iMessage** — local `chat.db` access (Full Disk Access for the terminal); always full-scan. `npm run sync:imessage`. Verify contact-name resolution (`imessage/contacts.ts`).

### Suggested automated follow-ups (optional, larger effort)
- [ ] Add **jsdom** to devDeps and unit-test `CHATS_JS` render + `SCROLL_JS` paging against a fake DOM/`fetch`, so the two browser blobs stop being a coverage black hole.
- [ ] Or wire up **Playwright** (a `playwright-test` skill already exists here) for one end-to-end web-UI smoke: load `/`, filter by platform, open a thread, scroll to page older messages.
- [ ] Add a thin **integration harness per platform** gated behind an env flag (e.g. `KHIPU_LIVE=1`) so live syncs can be exercised on demand without polluting the default `npm test` run.
