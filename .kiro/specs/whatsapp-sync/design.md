# Design Document — whatsapp-sync

## Overview

WhatsApp Sync wraps `whatsapp-web.js` behind an injectable `WhatsAppClient` interface. On first run, a QR code is displayed; on subsequent runs, the session string from `WHATSAPP_SESSION` env var restores auth. `whatsapp-web.js` uses `LocalAuth` for session storage but we expose the session path via env var. `'whatsapp'` is already in the Platform union. New runtime deps: `whatsapp-web.js`, `qrcode-terminal`.

### Non-Goals
- Sending, media download, real-time listener.

## Boundary Commitments

### This Spec Owns
- `src/platforms/whatsapp/` — client wrapper, mapper, backfill, adapter.
- `"sync:whatsapp"` script; `whatsapp-web.js`, `qrcode-terminal` runtime deps.

### Out of Boundary
- `src/platforms/types.ts` — `'whatsapp'` already present.
- `src/db.ts` schema.

### Allowed Dependencies
- `src/db.ts`, `src/platforms/types.ts`, `whatsapp-web.js`, `qrcode-terminal`.

### Revalidation Triggers
- `whatsapp-web.js` API breaking changes; `Chat`/`Message` interface changes.

## File Structure Plan

```
src/platforms/whatsapp/
├── client.ts   # WhatsAppClient interface + WWebJSClient implementation
└── sync.ts     # types, mapChat, mapMessage, hashStr, runBackfillImpl, whatsappAdapter, main()
tests/
└── whatsapp.test.ts
```

**Modified**: `package.json` (script + deps).

## Components and Interfaces

```typescript
// client.ts
export interface WAChat {
  id: { _serialized: string }
  name: string
  isGroup: boolean
}
export interface WAMessage {
  id: { _serialized: string }
  body: string
  from: string         // sender ID
  fromMe: boolean
  author?: string      // in groups: sender ID
  timestamp: number    // Unix seconds
  type: string         // 'chat' | 'image' | 'video' | ...
}
export interface WhatsAppClient {
  getChats(): Promise<WAChat[]>
  fetchMessages(chatId: string, limit?: number): Promise<WAMessage[]>
  getContactName(contactId: string): Promise<string>
  destroy(): Promise<void>
}
export function createWhatsAppClient(sessionDataPath?: string): Promise<WhatsAppClient>
// Uses whatsapp-web.js Client with LocalAuth; emits 'qr' event → display with qrcode-terminal;
// resolves when 'ready' fires; on auth_failure: throws with re-auth message.
```

```typescript
// sync.ts
export function mapChat(chat: WAChat): Chat
export function mapMessage(msg: WAMessage, chatId: number, senderName: string): Message
// external_id: msg.id._serialized; is_sender: msg.fromMe ? 1 : 0
// type: msg.type === 'chat' && msg.body ? 'text' : 'other'
// timestamp: msg.timestamp

export async function runBackfillImpl(client: WhatsAppClient): Promise<void>
// getChats() → upsertChat per chat → fetchMessages → insertMessage per msg
```

## Requirements Traceability

| Requirement | Component |
|-------------|-----------|
| 1.1–1.4 | createWhatsAppClient (QR, session restore, fallback) |
| 2.1, 2.2 | runBackfillImpl + getChats |
| 3.1–3.6 | mapMessage + runBackfillImpl |
| 4.1 | main() error handler |
| 5.1–5.3 | npm script + INSERT OR IGNORE |

## Testing Strategy

- **Unit**: `mapChat` group/private type; `mapMessage` fromMe→is_sender, type=other for media, timestamp.
- **Integration**: `runBackfillImpl` with mock `WhatsAppClient` → correct archive records; idempotency.
- **Note**: Real `whatsapp-web.js` client (Puppeteer) not used in tests; mock interface only.
