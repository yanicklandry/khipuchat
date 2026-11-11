# Implementation Plan

- [x] 1. Foundation: dependency and transport
- [x] 1.1 Confirm QR-rendering dependency is present (no package.json change)
  - `qrcode-terminal` and `@types/qrcode-terminal` are already installed (used by the whatsapp adapter); import `qrcode-terminal` directly. Do NOT edit `package.json` and do NOT add a local ambient `.d.ts` (it would collide with the installed `@types/qrcode-terminal`).
  - Observable completion: the project typechecks with a `qrcode-terminal` import present under strict mode with no `any`, and `npm ls qrcode-terminal @types/qrcode-terminal` resolves — with no diff to `package.json`.
  - _Requirements: 3.1_
  - _Boundary: cli-link_

- [x] 1.2 Build the signal-cli JSON-RPC socket transport
  - Connect to the signal-cli daemon over a UNIX socket (default `$XDG_RUNTIME_DIR/signal-cli/socket`, overridable via `SIGNAL_CLI_SOCKET`), buffering input by newline and parsing each line as JSON-RPC 2.0.
  - Correlate responses to requests by `id`; dispatch `receive` notifications (no `id`) to a registered handler; expose an explicit close that releases the socket.
  - Return a typed connect result distinguishing "unreachable" from a usable client, without importing any signal-cli source.
  - Observable completion: a unit test feeds a multi-line buffer and confirms request/response correlation, `receive` notification dispatch, and that close frees the socket.
  - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 10.4_
  - _Boundary: cli-client_

- [x] 2. Core: mapping, media, linking
- [x] 2.1 (P) Implement pure envelope-to-record mapping
  - Resolve chat identity for group vs one-to-one conversations and produce a stable chat external id, display name, and private/group type.
  - Map an envelope to a message record with sender name, unix-second timestamp, sender-vs-received direction (own sends arrive as sync-sent), reply reference, and `text`/`image`/`other` classification; return nothing for non-ingestable envelopes (receipts, typing, empty).
  - Observable completion: unit tests over representative fixtures assert correct chat resolution, direction, classification, reply mapping, and null for non-content envelopes.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.4, 5.5_
  - _Boundary: cli-mapping_

- [x] 2.2 (P) Ingest image attachments through the shared media pipeline
  - Resolve each decrypted attachment file from the signal-cli attachments directory by its id, store it via the shared media store, run OCR, and persist the local path, dimensions, and OCR text; skip work when media is already stored (idempotent).
  - Treat a missing/expired file or an OCR failure as a per-item skip that does not abort the run.
  - Observable completion: with a fixture image on disk the message row gains a media path and OCR text; with a missing file the message is archived without media and processing continues.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Boundary: cli-image-sync_

- [x] 2.3 (P) Implement the secondary-device linking flow
  - Obtain a `sgnl://linkdevice` device-link URI from the daemon and present it both as the raw URI and as a scannable terminal QR code.
  - Complete linking as a secondary device (no phone-number registration), awaiting primary approval within a bounded window, and report linked/already-linked/timeout/failure without ingesting any messages.
  - Observable completion: against a mocked transport, a successful link returns a linked outcome and a non-response within the window returns a timeout outcome, with the QR/URI emitted.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - _Boundary: cli-link_
  - _Depends: 1.2_

- [x] 3. Integration: adapter, selection, and wiring
- [x] 3.1 Implement the signal-cli platform adapter
  - Provide backfill and incremental behaviors that connect, verify a device is linked (guide and write nothing when not), seed chats from the daemon's group/contact enumeration, drain queued messages with a bounded timeout, and ingest chats/messages (dedup) plus image attachments and new-row embeddings. `startListener` is a no-op, exactly like every other adapter; the watch daemon achieves live-from-link-forward ingestion by calling `syncIncremental` on each poll cycle (a bounded drain per poll), not via a continuous listener. A streaming `subscribeReceive` listener is out of scope (it would require a daemon-level change to `pollCycle`).
  - Guarantee only link-time-forward capture: ingest any volunteered pre-link history via the same path without claiming completeness and without attempting a local-backup import; complete as a clean no-op when nothing is queued; surface daemon-unreachable as a single clear error and always release the socket.
  - Observable completion: over a mocked transport a drain ingests fixture chats/messages once into a `:memory:` DB, an empty queue reports "nothing new" with zero rows, and an unreachable transport yields a typed error.
  - _Requirements: 4.1, 4.2, 4.3, 4.6, 5.2, 5.3, 6.1, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5, 10.1, 10.3, 10.5_
  - _Boundary: cli-sync_
  - _Depends: 1.2, 2.1, 2.2_

- [x] 3.2 Implement the Signal backend selector
  - Resolve the active Signal backend from `SIGNAL_BACKEND` (default `beeper`), returning the Beeper adapter factory by default and the signal-cli adapter factory when `cli` is selected, and expose whether the cli backend is configured.
  - Ensure selecting `cli` does not require `BEEPER_ACCESS_TOKEN` and selecting `beeper` does not require signal-cli.
  - Observable completion: unit tests confirm the default is `beeper`, `SIGNAL_BACKEND=cli` returns the cli factory without a Beeper token, and the configured probe reflects the selection.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 10.2_
  - _Boundary: backend_
  - _Depends: 3.1_

- [x] 3.3 Wire the Signal sync entrypoint to the selector and linking
  - Route the signal sync entrypoint through the backend selector so the default account uses the chosen backend, and run the linking flow instead of a sync when the cli backend is active and a `--link` flag is passed.
  - Preserve the existing Beeper path byte-for-byte when the backend is `beeper`.
  - Observable completion: `khipu sync signal --link` (cli backend) triggers linking, `khipu sync signal` runs the selected backend's sync, and the Beeper path is unchanged when selected.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1_
  - _Depends: 3.1, 3.2, 2.3_

- [x] 3.4 Integrate backend-aware configuration into the account registry and watch loop
  - Make the legacy (no config file) account resolution synthesize a `default` Signal account when the cli backend is selected even without `BEEPER_ACCESS_TOKEN`, and have the watch loop resolve the Signal factory via the selector and treat Signal as configured when the cli backend is configured.
  - Keep all other platforms and the Beeper-token path unchanged, and ensure a down daemon during all-platform sync skips Signal without stopping other platforms.
  - Observable completion: with `SIGNAL_BACKEND=cli` and no Beeper token the watch daemon lists and polls the signal-cli adapter, and an unreachable daemon logs a skip while other platforms continue.
  - _Requirements: 1.5, 1.6, 8.5, 10.2_
  - _Boundary: account-registry, watch_
  - _Depends: 3.2_

- [x] 4. Validation
- [x] 4.1 Unit-test transport, mapping, and selection
  - Cover NDJSON framing and id correlation, envelope mapping (direction, classification, reply, group vs direct), and backend selection defaults/overrides, all without a running daemon or live account.
  - Observable completion: the unit suite passes under `npm test` and requires no external `signal-cli`.
  - _Requirements: 11.1, 11.2, 11.4_
  - _Depends: 1.2, 2.1, 3.2_

- [x] 4.2 Integration-test drain, dedup, images, degradation, and query parity
  - Using a mocked JSON-RPC transport and a `:memory:` DB, verify single-copy ingestion and dedup on re-drain, image store+OCR and graceful handling of missing/expired media, and graceful behavior for unreachable/not-linked/empty-queue conditions.
  - Confirm signal-cli-synced rows are returned by the existing query handlers (list/search) and carry the `signal` platform, proving surface parity without surface changes.
  - Observable completion: the integration suite passes, asserting no duplicate rows on re-drain, image OCR text persisted, degradation paths produce no crashes, and synced rows are visible through the shared query path.
  - _Requirements: 5.2, 5.3, 6.1, 6.2, 6.4, 6.5, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.5, 11.1, 11.3_
  - _Depends: 3.1, 3.4_

## Implementation Notes

- **Files created** (all < 200 lines, TS strict, no `any`): `src/platforms/signal/cli-client.ts` (JSON-RPC NDJSON socket transport), `cli-mapping.ts` (pure envelope→Chat/Message), `cli-image-sync.ts` (decrypted-attachment ingestion via shared media/OCR), `cli-link.ts` (secondary-device linking + QR), `cli-sync.ts` (the `PlatformAdapter`), `backend.ts` (SIGNAL_BACKEND selector).
- **Files edited (additive only)**: `src/platforms/signal/sync.ts` (main() routes through the selector + `--link` flow; Beeper default path preserved byte-for-byte), `src/watch.ts` (ADAPTER_FACTORIES.signal resolved via `resolveSignalFactory()`), `src/account-registry.ts` (legacy builder synthesizes a `default` signal account when `SIGNAL_BACKEND=cli`, additive/non-overriding). Beeper `client.ts`/`image-sync.ts`/`mapMessage`/`mapChat` UNTOUCHED.
- **isConfigured**: NO edit needed. `isConfigured('signal', registry)` is already registry-aware; the account-registry cli-synthesis makes `registry.listAccounts('signal')` return `['default']` under `SIGNAL_BACKEND=cli`, so it returns true without a redundant clause. Verified by `signal-cli-backend.test.ts`.
- **startListener is a no-op** on the cli adapter, exactly like every other adapter. Live-from-link-forward ingestion under the watch daemon is achieved by `pollCycle`→`syncIncremental` performing a single BOUNDED drain of currently-queued `receive` notifications each poll. No continuous `subscribeReceive` listener (out of scope; would need a daemon-level pollCycle change).
- **Drain contract**: `syncIncremental`/`runBackfill` both call `drainOnce` — connect, verify linked via `listAccounts`, seed chats from `listGroups`/`listContacts`, then `drainReceive` collects notifications delivered during a bounded `receive` request (also unwraps any inline array result via `extractEnvelope`). `since` is informational; the `(external_id, chat_id)` conflict rule guards overlap (dedup verified on re-drain).
- **Module-cycle avoidance**: `sync.ts` main() imports `./backend` via dynamic `import()` because `backend.ts` statically imports `createSignalAdapter` from `sync.ts`. `watch.ts` imports `backend` statically (no cycle there).
- **qrcode-terminal**: imported directly (`import { generate } from 'qrcode-terminal'`); types resolve from the installed `@types/qrcode-terminal@0.12.2`. No `package.json` edit, no ambient `.d.ts`.
- **Scope guarantee (Req 7)** encoded in `cli-sync.ts` / `cli-image-sync.ts` header comments: live-from-link-forward only; pre-link back-history unverified/uningested beyond what the daemon volunteers; 45-day server-side media expiry => missing decrypted file is a clean per-item skip, never a sync failure. No sending, no back-history import, no signal-cli vendoring/linking (arm's-length GPLv3 IPC over the socket only).
- **Tests**: 53 new tests across `signal-cli-client`, `signal-cli-mapping`, `signal-cli-backend`, `signal-cli-link`, `signal-cli-sync` (mocked JSON-RPC transport, `:memory:` DB, mocked media/OCR). Full suite: 52 files / 1068 tests pass under Node 24.15.0. `tsc` not gated (known-broken).
