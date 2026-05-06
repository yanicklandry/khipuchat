# Implementation Plan

- [ ] 1. Foundation — dependencies, script, test scaffold
- [ ] 1.1 Add whatsapp-web.js dependencies and npm script
  - Add `"whatsapp-web.js"` and `"qrcode-terminal"` to `dependencies`; `"@types/qrcode-terminal"` to devDependencies
  - Add `"sync:whatsapp": "tsx src/platforms/whatsapp/sync.ts"` to scripts
  - Create `src/platforms/whatsapp/` and `tests/whatsapp.test.ts` with mock `WhatsAppClient` factory
  - `npm test` passes
  - _Requirements: 5.1_

- [ ] 2. Core — client wrapper and mappers (parallel)
- [ ] 2.1 (P) Implement the whatsapp-web.js client wrapper
  - Create `src/platforms/whatsapp/client.ts` with `WAChat`, `WAMessage`, `WhatsAppClient` interfaces
  - `createWhatsAppClient(sessionDataPath?)`: initialises `whatsapp-web.js Client` with `LocalAuth`; on `qr` event display QR with `qrcode-terminal`; resolves when `ready` fires
  - If `auth_failure` event fires: reject with message noting re-authentication needed and pointing to whatsapp-web.js GitHub
  - `destroy()` terminates Puppeteer
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 4.1_
  - _Boundary: WhatsApp Client (client.ts)_

- [ ] 2.2 (P) Implement mappers
  - Create `src/platforms/whatsapp/sync.ts` with `hashStr`, `mapChat`, `mapMessage`
  - `mapChat`: type `'group'` when `chat.isGroup`, else `'private'`; id from `hashStr(chat.id._serialized)`
  - `mapMessage`: `is_sender = msg.fromMe ? 1 : 0`; `type = 'other'` for non-chat type or empty body; `external_id = msg.id._serialized`
  - Mappers pass unit tests
  - _Requirements: 2.2, 3.2, 3.5, 3.6_
  - _Boundary: Row Mappers (sync.ts)_

- [ ] 3. Backfill runner and adapter
- [ ] 3.1 Implement runBackfillImpl and adapter
  - Add `runBackfillImpl(client)`: `getChats()` → `upsertChat` → `fetchMessages` → `insertMessage`; resolve `sender_name` via `getContactName`
  - Add `whatsappAdapter: PlatformAdapter` and `main()`: reads optional `WHATSAPP_SESSION` path; wraps unknown errors with unofficial-API warning message
  - Running twice with mock client produces no duplicate records
  - `npm run sync:whatsapp` invocable (Puppeteer launches)
  - _Requirements: 1.1, 2.1, 3.1, 3.3, 3.4, 4.1, 5.2, 5.3_

- [ ] 4. Tests
- [ ] 4.1 Unit and integration tests
  - `mapChat`: group/private type; stable chat ID from serialized ID
  - `mapMessage`: `is_sender` from `fromMe`; `type='other'` for image type; timestamp passthrough
  - `runBackfillImpl` with mock client → correct records + idempotency
  - All tests pass with `npm test`
  - _Requirements: 3.2, 3.5, 3.6, 5.2_
