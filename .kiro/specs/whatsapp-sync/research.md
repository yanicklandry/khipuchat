# Gap Analysis: whatsapp-sync

**Date**: 2026-07-12
**Status**: Implementation already complete — no blocking gaps found.

---

## Summary

- The entire whatsapp-sync feature is already implemented and wired into the project.
- All four planned task groups (foundation, client wrapper, mappers/backfill, tests) are done.
- No schema changes are needed; `'whatsapp'` is already in the `Platform` union.
- The spec `phase` is `tasks-generated` and `ready_for_implementation: true`, but the code predates this gap analysis run.
- Validation (`/kiro-validate-impl`) is the appropriate next step, not implementation.

---

## Existing Implementation Inventory

### `src/platforms/whatsapp/client.ts`

Complete `WhatsAppClient` wrapper over `whatsapp-web.js`:

- `WAChat`, `WAMessage`, `WhatsAppClient`, `CreateClientOptions` interfaces.
- `createWhatsAppClient(opts)`: initialises `Client` with `LocalAuth`; renders a 30-second animated progress bar while Puppeteer starts; displays QR via `qrcode-terminal` on `qr` event; rejects on `auth_failure` with a message noting re-authentication; resolves with a typed wrapper on `ready`.
- `getChats()`, `fetchMessages(chatId, limit)`, `getContactName(id)`, `destroy()` all delegating to the underlying `whatsapp-web.js` client.
- Debug logging (`--debug` flag) via a `dbg` helper that writes to stderr.

### `src/platforms/whatsapp/sync.ts`

Full sync script:

- `hashStr(s)`: FNV-1a hash, returns non-zero u32.
- `mapChat(chat, account)`: maps `WAChat` => `Chat`; `type = 'group'` / `'private'`; `external_id = chat.id._serialized`.
- `mapMessage(msg, chatId, senderName)`: maps `WAMessage` => `Message`; `is_sender` from `fromMe`; `type = 'other'` for non-`chat` type or empty body; `external_id = msg.id._serialized`.
- `runBackfillImpl(client, account)`: fetches all chats; reads per-chat `last_synced_at` from DB; skips chats whose `chat.timestamp <= last_synced_at`; for active chats, calls `fetchMessages` and filters by timestamp; calls `setLastSyncedAt` after each chat; triggers embedding indexing per chat.
- `runIncrementalImpl(client, since, account)`: client-side timestamp filter (no server-side filter available in WhatsApp Web); logs a note about this limitation.
- `createWhatsAppAdapter(account, credentials)`: factory implementing `PlatformAdapter` (both `runBackfill` and `syncIncremental`); reads `WHATSAPP_SESSION` from credentials; wraps errors with unofficial-API warning.
- `whatsappAdapter`: default singleton adapter for single-account use.
- `main()`: entry point; calls `runPlatformSync`.

### `tests/whatsapp.test.ts`

Comprehensive test coverage:

- `parseArgs`: 4 cases covering presence/absence of `--debug`.
- `createWhatsAppClient debug option`: 2 cases mocking `whatsapp-web.js` to avoid launching Puppeteer.
- `hashStr`: stability and collision tests.
- `mapChat`: 5 cases (platform, type, name, external_id).
- `mapMessage`: 9 cases (platform, external_id, is_sender, timestamp, type, text, sender_name).
- `runBackfillImpl`: 6 integration cases using `:memory:` SQLite (imports, idempotency, empty list, skip on no new activity, process on new activity, timestamp filtering).
- `runIncrementalImpl`: 3 cases (warning log, timestamp boundary, all-old messages).

### Wiring

| Location | Status |
|---|---|
| `package.json` — `sync:whatsapp` script | Present |
| `package.json` — `whatsapp-web.js` dependency | Present (`^1.34.7`) |
| `src/platforms/types.ts` — `Platform` union | `'whatsapp'` included |
| `src/sync-all.ts` — `PLATFORMS` array | `'whatsapp'` included, spawned last |
| `src/account-registry.ts` — known platforms | `'whatsapp'` included |

---

## Gap Assessment Against Requirements

| Requirement | Status | Notes |
|---|---|---|
| R1: Session Management (QR + env var restore) | Implemented | `LocalAuth` + `WHATSAPP_SESSION` credential field |
| R2: Chat Discovery (DM + group) | Implemented | `client.getChats()` + `isGroup` mapped to type |
| R3: Message Backfill (all messages, external_id, sender_name, platform, type, is_sender) | Implemented | All fields correctly mapped in `mapMessage` |
| R4: Unofficial API Risk Documentation | Implemented | Error handler emits the required warning message |
| R5: Idempotency + `npm run sync:whatsapp` | Implemented | `upsertChat` / `insertMessage` are idempotent; script registered |

No missing capabilities found.

---

## Minor Observations (non-blocking)

1. **Session path vs env var**: The requirements mention persisting the session as `WHATSAPP_SESSION` env var (Req 1.2 says "write the session string to a file or output it with instructions"). `LocalAuth` stores session data to disk at `sessionDataPath` rather than outputting a serialized string. This is a known design divergence — it is simpler and more secure. The credential field `WHATSAPP_SESSION` is used as the `dataPath` for `LocalAuth`, which is a directory path, not a session string. This works but may surprise users expecting a copy-pasteable env var value.

2. **Incremental mode caveat**: `runIncrementalImpl` logs that WhatsApp Web has no server-side time filter and performs client-side filtering. This is expected and documented in the code; no fix needed.

3. **tasks.md checkboxes**: All task boxes are still unchecked (`[ ]`). The implementation exists but task status was never updated. Run `/kiro-validate-impl whatsapp-sync` to confirm correctness and mark tasks complete.

---

## Approach Evaluation

Since the implementation is complete, the "extend / new / hybrid" evaluation is moot. The chosen approach:

- **Extend**: Followed existing platform adapter pattern exactly (`PlatformAdapter`, `AdapterFactory`, `runPlatformSync`).
- **Client abstraction**: `WhatsAppClient` interface wraps the unofficial library cleanly, enabling test mocking without Puppeteer.
- **Incremental sync**: Uses per-chat `last_synced_at` in the DB rather than a single platform-level cursor, matching the Telegram adapter pattern.

---

## Next Steps

1. Run `/kiro-validate-impl whatsapp-sync` to verify the full test suite passes and confirm spec coverage.
2. If tests pass, the feature is ready to ship — no further implementation work required.
