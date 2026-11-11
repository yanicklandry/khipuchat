# Brief: zalo-sync

## Problem
Zalo is the dominant messaging app in Vietnam. A user with significant Zalo conversation history has no way to archive it into KhipuChat alongside their other platforms, leaving a blind spot in a tool whose whole premise is a unified local message archive.

## Current State
KhipuChat has 9 platform adapters implementing `PlatformAdapter` (`src/platforms/types.ts`): telegram, imessage, discord, slack, whatsapp, email, signal, facebook. WhatsApp (`whatsapp-web.js`) establishes the QR-code web-session pattern that maps cleanly onto Zalo. No Zalo integration exists. The `Platform` union in `types.ts` does not include `'zalo'`.

## Desired Outcome
`khipu sync zalo` (and `sync all`) logs in via a QR-code Zalo Web session, captures direct-message conversations, and ingests them into the shared `chats`/`messages` tables labeled `platform='zalo'` — visible to FTS, semantic search, MCP, CLI, and web like any other platform.

## Approach
New adapter `src/platforms/zalo/` using **`zca-js`** (npm, MIT license, Node ≥18 — runs on Node 24; the old native `sharp` dep was removed in v2.0.0, so no native-ABI lock). Pattern mirrors the whatsapp adapter: QR/session login (persist session/cookies under a config dir), map Zalo conversations to `Chat` and messages to `Message`, ingest via existing `src/db.ts` functions, implement `runBackfill` + `startListener` (+ `syncIncremental` if a reliable cursor exists). Register `'zalo'` in the `Platform` union and any platform maps (mcp tool descriptions, watch `REQUIRED_ENV_VARS`, khipu.ts). `openzca` (also permissive, built on zca-js with a SQLite store) is prior art to reference for the sync loop.

**Fidelity is deliberately bounded** (see viability research): `zca-js` is live/listener-oriented (`api.listener.on('message')`) and offers only a shallow **recent-window** backfill delivered as a per-user stream, not clean per-thread full history. So the deliverable is authoritative live capture + best-effort recent backfill — NOT a complete historical mirror. This must be stated in requirements and README.

## Scope
- **In**: `src/platforms/zalo/` adapter (client/session + sync), `zalo` platform registration, live message capture, best-effort recent-window backfill, DM conversations, tests (against a mocked zca-js client).
- **Out**: sending messages, Zalo groups/OA (Official Account) broadcast channels, complete deep-history export (not reliably retrievable), image/attachment OCR (defer to a follow-up like the telegram/signal image specs), guaranteeing ban-safety.

## Boundary Candidates
- Session/auth (QR login + persistence) vs message mapping vs ingestion — same seams as the whatsapp adapter.
- `Platform` union + platform-registration touchpoints (shared seam).

## Out of Boundary
- `src/db.ts` schema (adapters call exported functions only).
- Image pipeline (separate future spec, reuse media-storage/ocr conventions when added).

## Upstream / Downstream
- **Upstream**: platform-abstraction (`PlatformAdapter`, `src/db.ts`), account-registry (credentials), sync-runner.
- **Downstream**: a future `zalo-image-sync` could reuse the shared media-storage + OCR pipeline.

## Existing Spec Touchpoints
- **Extends**: platform-abstraction (`Platform` union addition, mirroring how facebook/signal were added).
- **Adjacent**: whatsapp-sync (closest structural template).

## Constraints
- Node 24, TS strict, files under 200 lines, self-hosted/local-only, synchronous DB.
- **Risk to document, not hide**: `zca-js` is unofficial; account lock/ban risk is real and library-acknowledged; the web protocol can break and require library updates and QR re-auth. Acceptable for a private personal archive; requirements must call this out.
- License: `zca-js` MIT — no GPL/AGPL contamination.
