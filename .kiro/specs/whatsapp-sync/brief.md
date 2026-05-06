# Brief: whatsapp-sync

## Problem
WhatsApp has no official export API. Users want their WhatsApp DMs in the local archive without manual chat export.

## Current State
No WhatsApp integration. Platform abstraction is ready. This is the highest-risk adapter due to the unofficial API.

## Desired Outcome
`npm run sync:whatsapp` launches a headless WhatsApp Web session (QR code on first run, session saved after), fetches all DM and group chats, stores them as `platform='whatsapp'` records, and is idempotent.

## Approach
`whatsapp-web.js` — the most widely used unofficial WhatsApp Web automation library. QR scan once, session string saved to .env as `WHATSAPP_SESSION`. Puppeteer runs headless. Map `Message` objects from whatsapp-web.js to the shared Message schema.

## Scope
- **In**: `src/platforms/whatsapp/sync.ts`, whatsapp-web.js client, QR code display on first run, session persistence, `npm run sync:whatsapp`, env var `WHATSAPP_SESSION`, tests with mocked client, deduplication via message `id._serialized` as external_id
- **Out**: Sending messages, media download, WhatsApp Business API (separate product), real-time listener beyond initial session

## Boundary Candidates
- WhatsApp client init + QR flow — handles session lifecycle
- Message mapping — whatsapp-web.js Message → shared Message interface
- Backfill runner — fetch all chats, paginate messages per chat, injectable mock for testing

## Out of Boundary
- DB schema changes — platform-abstraction owns the schema
- Any guarantee of long-term API stability (risk accepted, documented)

## Upstream / Downstream
- **Upstream**: platform-abstraction (PlatformAdapter interface, db functions)
- **Downstream**: release (packaged)

## Existing Spec Touchpoints
- **Extends**: src/platforms/types.ts (add 'whatsapp' to Platform union)
- **Adjacent**: src/db.ts — call only exported functions

## Constraints
- whatsapp-web.js is unofficial — may break on WhatsApp updates (risk accepted, documented in README)
- Puppeteer adds significant disk/memory footprint — acceptable for self-hosted desktop use
- WHATSAPP_SESSION in .env (auto-written after QR scan)
- macOS/Linux only (Puppeteer dependency)
