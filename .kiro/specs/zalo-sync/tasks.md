# Implementation Plan

- [x] 0. Confirm the zca-js API surface and pin it in the client
  - Install `zca-js` and inspect the installed version's exports: the QR login entry (`new Zalo(...)` + `loginQR()`), the session/context persistence methods (how cookie/imei/userAgent are read back and re-used to skip QR), the listener API (`api.listener.on('message', cb)` + `start()`), the message-object shape (`type`/`ThreadType`, `threadId`, `isSelf`, `data.msgId`, `data.uidFrom`, `data.dName`, `data.content`, `data.ts`), and the friend/DM-thread enumeration method
  - Record the confirmed method names and message field paths in `research.md`; pin them as the single source of truth referenced by `client.ts`
  - Observable done: `research.md` lists the exact login, session-persistence, listener, and friend-enumeration method names for the installed `zca-js` version, and the `ZaloMessage` normalization mapping (raw field => normalized field) is written down
  - _Requirements: 2.3, 3.1_
  - _Boundary: research.md (zca-js API pinning)_

- [x] 1. Register `zalo` across every platform-enumeration point
- [x] 1.1 (P) Add `zalo` to the Platform union and PLATFORMS array
  - Add `| 'zalo'` to the `Platform` union in `src/platforms/types.ts`
  - Add `'zalo'` to the `PLATFORMS` array in `src/sync-all.ts`
  - Observable done: `khipu sync zalo` and `khipu sync zalo@<account>` are valid dispatch targets (the platform set includes `zalo`) and the all-platform sync loop includes `zalo`
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Boundary: Platform union (types.ts), PLATFORMS array (sync-all.ts)_

- [x] 1.2 Register the daemon factory and local-only status in watch.ts
  - Import `createZaloAdapter` and add `zalo: createZaloAdapter` to `ADAPTER_FACTORIES` in `src/watch.ts` (the total `Record<Platform, AdapterFactory>` makes this compile-required once the union grows)
  - Add `'zalo'` to `LOCAL_ONLY_PLATFORMS` in `src/watch.ts` so the daemon treats it as configured when a session exists and prints a skip notice otherwise
  - Observable done: `tsc --noEmit` passes (no missing-key error on `ADAPTER_FACTORIES`); the daemon includes Zalo in its poll set and logs a human-readable skip when no session is configured
  - _Requirements: 1.5, 8.1_
  - _Boundary: watch.ts ADAPTER_FACTORIES + LOCAL_ONLY_PLATFORMS_
  - _Depends: 1.1, 3.4_

- [x] 1.3 (P) Add the Zalo web icon and the sync:zalo npm script
  - Import `siZalo` in `src/web/icons.ts` and add `zalo: siZalo` to the `KNOWN` map
  - Add `"sync:zalo": "tsx src/platforms/zalo/sync.ts"` to `scripts` in `package.json`, and add `zca-js` to `dependencies`
  - Observable done: the built platform-icon map includes a `zalo` SVG entry rendered for `platform='zalo'` chats/messages; `npm run sync:zalo` resolves to the Zalo sync script
  - _Requirements: 1.6_
  - _Boundary: web/icons.ts KNOWN map, package.json scripts + dependencies_

- [x] 1.4 (P) Register zalo as a local-only platform in the account registry
  - Add `'zalo'` to `LOCAL_ONLY_PLATFORMS` in `src/account-registry.ts`
  - Observable done: with no `khipu.config.json`, `loadRegistry().listAccounts('zalo')` returns `['default']` and `credentialsFor('zalo','default')` resolves without requiring any env var
  - _Requirements: 8.1, 8.2_
  - _Boundary: account-registry.ts LOCAL_ONLY_PLATFORMS_

- [x] 2. Implement the ZaloClient wrapper and session persistence in `src/platforms/zalo/client.ts`
  - Create the `src/platforms/zalo/` directory and `client.ts`; define `ZaloThreadType`, `ZaloThread`, `ZaloMessage`, `ZaloClient`, and `CreateZaloClientOptions` exactly as in design.md, and dynamically `import('zca-js')` so tests can mock it (mirror `createWhatsAppClient`)
  - `createZaloClient(opts)`: resolve the session path from `opts.sessionPath` (else a default local path); if a valid saved session exists, reconnect from it WITHOUT rendering a QR; otherwise render the QR via `qrcode-terminal`, await scan, and on success persist the session credentials to the local session path and print a "session saved" notice
  - Normalize each raw zca-js message event into `ZaloMessage` at this boundary (self/sender null-ing left to mapping; convert `ts` to a number of ms); expose `getFriends()`, `onMessage(handler)`, `start()`, and `stop()`
  - On an invalid/rejected saved session, throw an actionable error instructing the user to remove the saved session and re-scan; wrap login/connection failures in an error that names Zalo and notes the unofficial-client / account-lock risk; never transmit session credentials anywhere except Zalo
  - Observable done: `import { createZaloClient } from './client'` compiles and is callable from `sync.ts`; with a mocked `zca-js`, a first run persists a session file and a second run reconnects without a QR prompt; the file is under 200 lines (split session handling into `session.ts` if it approaches the limit)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 4.1, 7.5, 8.3_
  - _Depends: 0_

- [x] 3. Implement the Zalo adapter in `src/platforms/zalo/sync.ts`
- [x] 3.1 Implement mapChat and mapMessage pure mapping functions
  - Export `mapChat(thread, account)` mapping `threadId→external_id`, `name`, `type='private'`, `username=null`, `platform='zalo'`
  - Export `mapMessage(msg, chatId)` mapping `msgId→external_id`, `chat_id`, `sender_id`/`sender_name` null when `isSelf` else `senderId`/`senderName`, `text = string content else null`, `type = 'text'` for non-empty string content else `'other'`, `timestamp = floor(ts/1000)`, `is_sender = isSelf?1:0`, `reply_to_external_id=null`, `platform='zalo'`, all `media_*`/`ocr_text` null
  - Both functions are pure (no I/O, no import from `client.ts`); the DM-only filter is applied by the caller before mapping
  - Observable done: unit tests can import and assert on `mapChat`/`mapMessage` outputs with no Zalo or DB dependency
  - _Requirements: 3.4, 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 3.2 Implement the bounded backfill/live-capture loop
  - Add `runBackfillImpl(client, account, windowMs)`: seed DM chats via `upsertChat(mapChat(...))` from `client.getFriends()`, register an `onMessage` handler that drops non-DM (group/OA) events, `upsertChat`+`insertMessage(mapMessage(...))` for DM events, `start()` the listener, await the bounded capture window, then `stop()`
  - Handle each event in a per-event try/catch that logs and continues; record non-text content as `type='other'` without aborting; use only the listener (recent-window replay + live), never a full-history fetch
  - After the session, run `embedNewMessages`/`embedNewChats` (guarded by `isIndexed`) for chats that received messages; print a `[zalo]` summary that states capture is live plus best-effort recent-window only (not a full export)
  - Observable done: against a scripted mock client, one run upserts chats and inserts DM messages; a second run inserts zero new rows (idempotent); a group event and a non-text event do not create text rows and do not abort; the bounded-fidelity notice is printed
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 7.4_
  - _Depends: 3.1, 2_

- [x] 3.3 Implement the incremental capture loop
  - Add `runIncrementalImpl(client, since, account, windowMs)` reusing the backfill loop's seeding, DM filter, idempotent insert, per-event try/catch, and embedding hooks, plus skipping any event whose `timestamp` (seconds) is `<= since`
  - Observable done: against a mock emitting events before and after `since`, only post-`since` DM messages are inserted; the runner persists the sync point after the call returns
  - _Requirements: 3.5, 3.7, 4.4, 7.4_
  - _Depends: 3.1, 2_

- [x] 3.4 Wire the adapter factory, credential guard, error isolation, and CLI entrypoint
  - Implement `createZaloAdapter(account, credentials)` returning a `PlatformAdapter` whose `runBackfill`/`syncIncremental` build the client via `createZaloClient({ sessionPath: credentials.fields['ZALO_SESSION'], debug })`, run the matching impl, and always `stop()` the client in a `finally`; `startListener` is a no-op
  - On a fatal error, write an actionable stderr message naming Zalo and the unofficial-client / account-lock risk and call `process.exit(1)` for the explicit single-platform command (the daemon's `pollCycle` already catches and continues for the all-platform path)
  - Export a default `zaloAdapter` using `process.env['ZALO_SESSION']`; add a `main()` guarded by `require.main === module` calling `initDb` + `runPlatformSync(zaloAdapter, db, process.argv)`
  - Observable done: `khipu sync zalo` runs end-to-end and exits 0 on success; a session/auth failure exits non-zero for the explicit command with a Zalo-naming message and is caught-and-continued under `khipu sync` (daemon); the file is under 200 lines
  - _Requirements: 1.2, 1.4, 2.5, 7.1, 7.2, 7.3, 7.5, 8.3_
  - _Depends: 3.1, 3.2, 3.3_

- [x] 4. Tests for the Zalo adapter (mocked zca-js client, no live login)
- [x] 4.1 Unit tests for mapChat, mapMessage, and the DM-type guard
  - In `tests/zalo.test.ts`, assert `mapMessage` maps `external_id`, `text`/`type` for string vs non-string content, `is_sender` and null `sender_id`/`sender_name` for self, `timestamp` (ms→s), `platform='zalo'`, and null media fields; assert `mapChat` maps a DM thread to `private` with `platform='zalo'`
  - Assert the DM-type guard drops a group/OA (`Group`) event before mapping
  - Observable done: all mapping and guard assertions pass in `tests/zalo.test.ts`
  - _Requirements: 3.3, 3.4, 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Depends: 3.1_

- [x] 4.2 Integration tests for the capture loops and adapter against a mock client
  - Stub `ZaloClient` with scripted friends and a controllable event emitter; assert `runBackfillImpl` seeds chats and inserts DM messages, a second run inserts zero rows (idempotent), group/OA events are excluded, a non-text event stores `other` without aborting, and an event whose handling throws is logged while the session continues
  - Assert `runIncrementalImpl` inserts only post-`since` events; assert `createZaloAdapter` on a client-construction/auth failure writes a Zalo-naming stderr message and calls `process.exit(1)` for the explicit command (mock `process.exit`)
  - Observable done: all integration cases pass in `tests/zalo.test.ts`
  - _Requirements: 3.1, 3.2, 3.5, 3.6, 4.1, 4.4, 7.1, 7.3, 7.4, 7.5_
  - _Depends: 3.2, 3.3, 3.4_

- [x]* 4.3 Query-parity and registry verification via existing surfaces
  - Run a mocked Zalo sync into an in-memory DB, then exercise existing handlers: `handleListChats` (including a `platform='zalo'` filter) returns the Zalo chat, `handleListMessages`/`handleSearchMessages` (after `rebuildFtsIndex`) return Zalo messages, and a CLI platform filter of `zalo` is consistent — with no changes to MCP/CLI/web query logic
  - Add a registry assertion (no `khipu.config.json` ⇒ `listAccounts('zalo')` returns `['default']`) and update the `tests/sync-all.test.ts` platform-count / last-platform assertions for the newly registered platform
  - Observable done: all parity + registry assertions pass and the existing `sync-all` suite is green with `zalo` registered
  - _Requirements: 1.3, 6.1, 6.2, 6.3, 6.4, 6.5, 8.1, 8.2_
  - _Depends: 1.1, 1.3, 1.4, 4.2_

## Implementation Notes

### Confirmed zca-js API (installed version 2.2.0, verified against node_modules + runtime import under tsx)

Login / session (from `dist/zalo.d.ts`, `dist/apis/loginQR.d.ts`):
- `new Zalo(options?)` — constructor. Options used: `{ selfListen: true, logging: debug, checkUpdate: false }` (`selfListen:true` so outgoing/`isSelf` DMs are captured too).
- `zalo.loginQR(options?, callback?) => Promise<API>` — QR login. The callback receives `LoginQRCallbackEvent` with numeric `type`:
  - `LoginQRCallbackEventType.QRCodeGenerated = 0` → `data.code` (the QR string, rendered via `qrcode-terminal`), `data.image` (base64, unused).
  - `QRCodeScanned = 2` → progress notice.
  - `GotLoginInfo = 4` → `data.cookie` (`SerializedCookie[]`), `data.imei`, `data.userAgent` → THESE are persisted to the local session file.
- `zalo.login(credentials) => Promise<API>` — reconnect from a saved session. `Credentials = { imei, cookie, userAgent, language? }`. We store/replay exactly `{ imei, cookie, userAgent }`.

Listener (from `dist/apis/listen.d.ts` — `Listener extends EventEmitter`):
- `api.listener.on('message', (m: Message) => …)` — live + recent-window replay of incoming messages.
- `api.listener.start({ retryOnClose? })` and `api.listener.stop()`.
- (`old_messages` event also exists for recent-window; the `'message'` stream already covers our bounded-capture need, so we subscribe only to `'message'`.)

Message shape (from `dist/models/Message.d.ts`): `Message = UserMessage | GroupMessage`, each with:
- `.type` = `ThreadType` (`User = 0`, `Group = 1`) — the DM-only guard keeps only `ThreadType.User`.
- `.threadId: string`, `.isSelf: boolean`, `.data: TMessage`.
- `TMessage`: `msgId`, `uidFrom`, `dName`, `ts` (string, epoch **ms**), `content` (`string | TAttachmentContent | TOtherContent`).

Friend enumeration (from `dist/apis/getAllFriends.d.ts`): `api.getAllFriends(count?, page?, avatarSize?) => Promise<User[]>`; `User.userId` + `User.displayName` seed DM chats.

Normalization mapping (raw → `ZaloMessage`, done at the client boundary in `client.ts`):
`msgId=data.msgId`, `threadId=threadId`, `threadType=type`, `isSelf=isSelf`, `senderId=data.uidFrom||null`, `senderName=data.dName||null`, `content=data.content`, `ts=Number(data.ts)` (ms). `mapMessage` then does `Math.floor(ts/1000)` and the `isSelf` null-ing.

### Deviations / decisions
- Design specified `export const enum ZaloThreadType`; used a plain `export enum` instead (safer under tsx/esbuild `isolatedModules`; regular enum resolves correctly cross-module at runtime). Values unchanged (User=0, Group=1) and equal to zca-js `ThreadType`.
- `client.ts` split proactively per the design's note: session persistence extracted to `session.ts` (`readSession`/`writeSession`/`resolveSessionPath`/`DEFAULT_SESSION_PATH`) to keep every file < 200 lines.
- `siZalo` confirmed present in installed `simple-icons@16.18.1` — no fallback icon needed.
- `khipu.ts` needs no edit: it derives `PLATFORM_SET` from `PLATFORMS` (verified) — `zalo` is accepted automatically.
- Bounded fidelity (R4): capture is live + best-effort recent-window replay only, enforced by a configurable window (`ZALO_CAPTURE_WINDOW_MS`, default 20000 ms) after which the listener is stopped; no full-history fetch is performed. Stated in the `[zalo]` completion log and code comments.
- Default session path: `<cwd>/.zalo_session.json` (written `mode 0o600`), overridable via the `ZALO_SESSION` credential field.
