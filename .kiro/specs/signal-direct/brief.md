# Brief: signal-direct

## Problem
Signal sync currently depends on Beeper Desktop running locally (`@beeper/desktop-api`, `BEEPER_ACCESS_TOKEN`). Users who don't run Beeper — or don't want a third-party bridge in the loop — cannot archive Signal. A Beeper-independent path is needed that fits the self-hosted, local-only ethos.

## Current State
`src/platforms/signal/` (client.ts, sync.ts, image-sync.ts) implements `PlatformAdapter` over Beeper's local API and ingests into the shared `chats`/`messages` tables, reusing the media-storage + OCR image pipeline. `'signal'` is already in the `Platform` union. The schema, image pipeline, and ingestion helpers are all in place and platform-agnostic.

## Desired Outcome
A Signal sync path that requires no Beeper: link KhipuChat as a Signal **secondary device** and ingest chats + text messages (and images, via the existing pipeline) into the same tables, selectable independently of the Beeper adapter.

## Approach
Drive **`signal-cli`** (AsamK) in **daemon / JSON-RPC mode** as a **separate process** the adapter talks to over a UNIX/TCP socket (newline-delimited JSON-RPC): render the `sgnl://linkdevice` QR for the user to scan (link as secondary device — no phone-number ownership needed), then stream `receive` notifications into `chats`/`messages` and copy decrypted attachments through the existing media-storage/OCR path. Keep `signal-cli` a separate binary invoked over IPC — its GPLv3 license stays at arm's length (mere aggregation; do NOT vendor or link its source). Add a variant adapter (e.g. `src/platforms/signal/cli-sync.ts`) or a `SIGNAL_BACKEND` selector so Beeper vs signal-cli is configurable; reuse mapping/ingestion where possible.

**Critical limitation to design around (viability research):** a linked device authoritatively receives everything **from link-time forward**. Pre-existing back-history is **best-effort and unverified**: Signal's 2025 "synchronized start" can transfer text history at link time, but whether `signal-cli` ingests that archive is unconfirmed, and encrypted media older than **45 days** is server-deleted and unrecoverable via linking. Requirements must state: live-forward is the guarantee; full backlog is a stretch goal to empirically test. The complete-history fallback (parse a local Signal plaintext/`signalbackup-tools` export) is explicitly a **separate future spec**, not this one.

Rejected: a DIY `@signalapp/libsignal-client` Node linked-device client — infeasible (reimplements signal-cli against an unsupported private protocol) and AGPLv3 linking would contaminate the codebase. `signald` is abandoned (upstream recommends signal-cli).

## Scope
- **In**: signal-cli daemon lifecycle + JSON-RPC client, device-linking flow (QR), live message ingestion (text + images) from link-time forward, backend selection (Beeper vs signal-cli), tests (mocked JSON-RPC transport).
- **Out**: sending messages, complete pre-link back-history import (separate spec), embedding/vendoring signal-cli source, a from-scratch libsignal client, managing the JVM/signal-cli install (document the prerequisite).

## Boundary Candidates
- signal-cli process lifecycle + JSON-RPC transport vs message mapping vs ingestion.
- Backend-selection seam (Beeper vs cli) within `src/platforms/signal/`.

## Out of Boundary
- `src/db.ts` schema and the media-storage/OCR modules (reused unchanged).
- The Beeper adapter's existing behavior (must keep working).

## Upstream / Downstream
- **Upstream**: signal-platform (schema, mapping conventions, image pipeline), platform-abstraction, account-registry, media-storage/ocr.
- **Downstream**: a future "signal full back-history importer" (local-backup parser) covers the pre-link + old-media gap.

## Existing Spec Touchpoints
- **Extends**: signal-platform (adds a second, Beeper-free backend for the same platform).
- **Adjacent**: signal-image-sync (reuses its download+OCR pipeline), telegram-image-sync (shared media conventions).

## Constraints
- Node 24, TS strict, files under 200 lines, synchronous DB, local-only.
- `signal-cli` is an external GPLv3 binary (requires a JVM); keep it a separate process (IPC only) so licensing stays at arm's length. Document the install prerequisite.
- Guarantee scope: authoritative from link-time forward; back-history explicitly best-effort/unverified with a 45-day media ceiling.
