# Research & Design Decisions

## Summary
- **Feature**: `zalo-sync`
- **Discovery Scope**: Extension (new platform adapter on the existing platform-abstraction)
- **Key Findings**:
  - `zca-js` (MIT, Node >= 18) is a live/listener-oriented unofficial Zalo Web client. It exposes `zalo.loginQR()` and an event listener `api.listener.on('message', cb)` + `api.listener.start()`. It does NOT expose a reliable per-thread full-history fetch, so backfill is bounded to the recent window the listener replays on connect.
  - The WhatsApp adapter (`src/platforms/whatsapp/`) is the closest structural template: QR-session login, session persistence to a local path, `LOCAL_ONLY` platform (no cloud token), `startListener` is a no-op, and the poll-based daemon drives `runBackfill`/`syncIncremental`.
  - Registering a new platform is a well-worn path (facebook was added most recently): one union edit, one `PLATFORMS` array edit, watch-daemon factory + config maps, web icon, npm script, and legacy registry entry. `src/db.ts` schema is never touched — adapters call `upsertChat`/`insertMessage`.

## Research Log

### zca-js API surface and session model
- **Context**: Need the exact login, listener, and persistence primitives to design the client wrapper and the bounded-fidelity contract.
- **Sources Consulted**:
  - zca-js GitHub (RFS-ADRENO/zca-js) and npm package page.
  - zca-js GitBook docs (login flows, multi-account).
  - openzca (openzca.com) — prior art: a Zalo CLI built on zca-js with a SQLite store and a listener-driven sync loop.
  - OpenClaw "Zalo personal" channel docs — another zca-js integration confirming the listener-first model.
- **Findings**:
  - `new Zalo(options?)` constructs the client; `await zalo.loginQR()` performs QR login and resolves an `api` object. QR is printed/rendered for the user to scan with the Zalo mobile app.
  - Session persistence is via a **context** (cookie + imei + userAgent). After login the context can be retrieved and written to disk; a subsequent run can log in from that saved context (cookie/imei/userAgent) to skip the QR step. There is also a cookie/credential-based `login(credentials)` path.
  - Live capture: `api.listener.on('message', (msg) => {...})` then `api.listener.start()`. Only one web listener per account can run at a time.
  - Message object shape (observed/ documented): `message.type` is a `ThreadType` (`User` for DMs, `Group` for groups), `message.threadId` is the conversation id, `message.isSelf` marks self-authored messages, and `message.data` carries `msgId`, `uidFrom`, `dName` (sender display name), `content` (string for text; object for rich/attachment content), and `ts` (epoch milliseconds as string/number).
  - There is no documented reliable "fetch all messages in thread" API; recent messages arrive through the listener stream. Friend/thread enumeration exists (e.g. friend/conversation listing) and is usable to seed chat metadata, but not to page full history.
- **Implications**:
  - Backfill must be modeled as "start the listener, capture the recent window it replays, plus anything live, for a bounded session, then stop" — NOT a history pull. This is codified in Requirement 4 and the bounded-fidelity design decision below.
  - The wrapper must abstract zca-js behind a narrow, mockable interface so tests never perform a live login.

### Fit with the poll-based sync runner / watch daemon
- **Context**: The `PlatformAdapter` interface has `runBackfill`, `startListener`, and optional `syncIncremental`. Determine which the daemon actually calls.
- **Sources Consulted**: `src/sync-runner.ts`, `src/watch.ts`, `src/platforms/whatsapp/sync.ts`, `src/platforms/signal/sync.ts`.
- **Findings**:
  - Both `runPlatformSync` (one-shot) and `watch.ts` `pollCycle` (daemon) invoke `syncIncremental` (when a prior sync point exists) or `runBackfill`. **`startListener` is never invoked** by the runner or daemon — every existing adapter implements it as a no-op.
  - `runPlatformSync` records `setPlatformLastSyncedAt(platform, account, runStartedAt)` after the adapter returns, and rebuilds FTS + embeddings on `--force`.
  - `insertMessage` is idempotent via `ON CONFLICT(external_id, chat_id)`, and `upsertChat` via `ON CONFLICT(platform, account, external_id)`.
- **Implications**:
  - Zalo must fit the return-based model. Each `runBackfill`/`syncIncremental` invocation runs a **bounded capture session**: log in, start the listener, collect events for a configurable window, persist as they arrive, then stop the listener and return. `startListener` stays a no-op for consistency with all other adapters (wiring the daemon to a long-lived listener would be a shared-seam change outside this spec's boundary).
  - Idempotent inserts make replayed recent-window messages safe across repeated poll cycles.

### Platform registration touchpoints
- **Context**: Enumerate every edit needed so `zalo` is first-class, mirroring the facebook addition.
- **Sources Consulted**: `src/platforms/types.ts`, `src/sync-all.ts`, `src/watch.ts`, `src/account-registry.ts`, `src/web/icons.ts`, `package.json`, `src/khipu.ts`.
- **Findings**: The touchpoints are: `Platform` union (`types.ts`); `PLATFORMS` array (`sync-all.ts`, which drives `khipu.ts` dispatch and the serial orchestrator); `ADAPTER_FACTORIES` + `LOCAL_ONLY_PLATFORMS` (`watch.ts`); `LOCAL_ONLY_PLATFORMS` (`account-registry.ts`); web icon map (`web/icons.ts`, `siZalo` from `simple-icons`); `sync:zalo` npm script and the `zca-js` dependency (`package.json`). `khipu.ts` needs no edit — it derives platform dispatch from `PLATFORMS`.
- **Implications**: Zalo is QR/session-based with no cloud token, so it is a `LOCAL_ONLY` platform exactly like whatsapp (registered in both `watch.ts` and `account-registry.ts` local-only sets), giving it a `default` account with no env requirement.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Bounded capture session inside runBackfill/syncIncremental (chosen) | Each sync opens a session, listens for a configured window, persists, closes | Fits existing return-based runner + daemon with zero shared-seam changes; idempotent inserts absorb replays | Not a continuous listener; messages arriving between poll windows are caught on the next session via recent-window replay (best-effort) | Mirrors whatsapp's one-shot shape |
| Long-lived listener via startListener | Wire the daemon to call `startListener` and keep it running | True real-time capture | Requires changing `watch.ts`/`sync-runner.ts` contract (shared seam) for all adapters; out of this spec's boundary | Rejected for scope |
| Full-history export | Page every thread's complete history | Complete mirror | `zca-js` does not reliably expose it | Rejected as infeasible (Req 4.2) |

## Design Decisions

### Decision: Narrow, mockable `ZaloClient` wrapper around zca-js
- **Context**: Tests must never perform a live QR login (Req 5.5, testing constraint). zca-js is unofficial and may change.
- **Alternatives Considered**:
  1. Call `zca-js` directly from the sync loop — hard to mock, couples the loop to library shape.
  2. Wrap zca-js behind a small interface exposing only what the adapter needs.
- **Selected Approach**: A `ZaloClient` interface (session login + friend enumeration + `onMessage`/`start`/`stop`) implemented by a thin factory that dynamically imports `zca-js`. The sync loop depends only on the interface, so tests inject a fake client that emits scripted events.
- **Rationale**: Matches how whatsapp/signal wrap their clients; isolates the unofficial dependency behind one file; keeps mapping functions pure.
- **Trade-offs**: One extra indirection layer; worth it for testability and blast-radius control.
- **Follow-up**: Confirm the exact `zca-js` context-persistence method names during implementation (Task 0) and pin them in the client file.

### Decision: Bounded fidelity is a first-class, user-visible contract
- **Context**: The library cannot deliver full history; hiding this would mislead users.
- **Selected Approach**: Requirement 4 mandates live + recent-window only; the adapter prints the limitation on every run and the README documents it.
- **Rationale**: Honesty about a bounded archive is a product value (roadmap: "Zalo full-history fidelity" is explicitly a future candidate, not this spec).

### Decision: DM-only filtering at the mapping boundary
- **Context**: Groups and OA channels are out of scope.
- **Selected Approach**: The capture loop drops any event whose `type` is not the DM (`User`) thread type before mapping/insertion, so group/OA traffic never reaches the archive.
- **Rationale**: Keeps the archive scoped to what the spec owns; avoids partial group data.

## Risks & Mitigations
- **Unofficial API / account-lock risk** — zca-js is unofficial; Zalo may lock accounts or break the web protocol. Mitigation: document prominently (Req 4.3, 7.5), isolate errors so other platforms are unaffected (Req 7.2), acceptable for a private personal archive.
- **Session credential leakage** — persisted cookie/imei/userAgent are sensitive. Mitigation: store only locally, never transmit (Req 2.6, 8); rely on the existing local-only posture and optional DB encryption.
- **Session invalidation** — Zalo may reject a saved session. Mitigation: actionable "remove session and re-scan" error and non-zero exit for the explicit command (Req 2.5, 7.1).
- **Duplicate delivery on replay** — recent-window replays repeat messages. Mitigation: idempotent `insertMessage`/`upsertChat` keyed on external ids (Req 3.5).
- **zca-js method-name drift** — exact context/persistence method names must be confirmed against the installed version. Mitigation: Task 0 pins them before wiring.

## References
- [RFS-ADRENO/zca-js](https://github.com/RFS-ADRENO/zca-js) — Unofficial Zalo API for JavaScript (MIT); loginQR + listener surface.
- [zca-js on npm](https://www.npmjs.com/package/zca-js) — package metadata, Node >= 18 engine.
- [zca-js GitBook](https://tdung.gitbook.io/zca-js/) — login flows and multi-account/session docs.
- [openzca](https://openzca.com/) — prior-art Zalo CLI on zca-js with a SQLite store and listener sync loop.
- [OpenClaw Zalo personal channel](https://docs.openclaw.ai/channels/zalouser) — another zca-js listener-based integration.
