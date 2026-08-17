# Research Log: facebook-messenger

## Discovery Scope

Extension (integration-focused) discovery. This feature is a near-identical sibling of the already-shipped `signal-platform` adapter: a new `src/platforms/facebook/` adapter sourcing data from Beeper Desktop via `@beeper/desktop-api`, differing from Signal only in the Beeper network filter and the addition of image ingestion from the first release. The bulk of discovery is confirming that the Signal template applies unchanged and resolving the one genuine unknown: Beeper's exact network identifier for Facebook Messenger.

## Adopted Template: signal-platform

The Signal adapter is the exact structural template. Reference files inspected:

| File | Lines | Role mirrored by facebook |
|---|---|---|
| `src/platforms/signal/client.ts` | 110 | `BeeperSignalClient` + `createBeeperSignalClient` → `BeeperFacebookClient` + `createBeeperFacebookClient` |
| `src/platforms/signal/sync.ts` | 181 | `mapChat`/`mapMessage`/`runBackfillImpl`/`runIncrementalImpl`/`createSignalAdapter` → facebook equivalents |
| `src/platforms/signal/image-sync.ts` | 135 | `createSignalAttachmentFetcher`/`processSignalImageMessages` → facebook equivalents |

Confirmed shared infrastructure the facebook adapter consumes unchanged:
- `PlatformAdapter` / `AdapterFactory` (`src/platforms/types.ts`).
- `runPlatformSync` (`src/sync-runner.ts`) — selects backfill vs. incremental, persists the sync point.
- `db.ts` write/read helpers: `upsertChat`, `insertMessage`, `getLastSyncedId`, `getMessageIdByExternalId`, `updateMessageMedia`, `getDb`.
- Embedding hooks `embedNewMessages`/`embedNewChats` guarded by `isIndexed` (`src/vec-db.ts`, `src/index-embeddings.ts`).
- Shared media pipeline `storeMedia` (`src/media-storage.ts`) and `extractText` (`src/ocr.ts`).
- `@beeper/desktop-api` `^5.0.0` is **already a project dependency** (`package.json`) — no install task needed.

## Transport / Auth (inherited from signal-platform §6.1–6.3)

Beeper Desktop runs a local HTTP REST API at `http://localhost:23373` (the SDK default base URL). Auth is a static Bearer access token supplied as credential `BEEPER_ACCESS_TOKEN`. The facebook adapter reuses this transport verbatim, constructing `new BeeperDesktop({ accessToken, baseURL: 'http://localhost:23373' })` exactly as the Signal client does. No MCP client, no Facebook cloud API. All traffic is `127.0.0.1` (`remote_access: false`), preserving the self-hosted, local-only steering constraint.

## OPEN QUESTION — Beeper's network identifier for Messenger (RESOLVED AS: verify-at-runtime, single constant)

### The unknown

`@beeper/desktop-api` `accounts.list()` returns `Account.network: string`. The Signal client filters `a.network?.toLowerCase() === 'signal'`. The facebook adapter needs the analogous string for Messenger. Candidates gathered: `'facebook'`, `'facebookgo'`, `'meta'`.

### Evidence gathered

1. **Live Beeper probe (this machine, 2026-08-01)** via `get_accounts`: connected accounts are Beeper (`matrix`), Discord (`discordgo`), Signal (`local-signal_...`), Telegram (`local-telegram_...`), WhatsApp (`local-whatsapp_...`), Slack (`slackgo.*`). **No Facebook Messenger account is currently connected**, so the raw `network` string for Messenger could not be observed directly here. This absence is itself the key finding: the filter constant cannot be verified against a live Messenger account at design time, so runtime verification during implementation is mandatory.
2. **Bridge naming convention observed**: cloud-bridged networks use a `<network>go` account-ID prefix — `discordgo`, `slackgo`. Locally-bridged networks use `local-<network>_...` — `local-signal_...`, `local-telegram_...`, `local-whatsapp_...`. Beeper's Messenger bridge is a cloud/Go bridge (mautrix-meta family), which makes **`facebookgo`** the leading candidate for the `network` value, with `facebook` the fallback and `meta` least likely.
3. **Beeper docs** (developers.beeper.com/desktop-api-reference/resources/accounts, help.beeper.com/chat-networks/messenger) confirm Messenger is a supported bridged network and that queries are scoped by `accountID`, but do not publish the raw internal `network` string values.

### Decision

- Keep the Messenger network filter in a **single exported constant** `FACEBOOK_NETWORK` in `client.ts` (default candidate `'facebookgo'`), compared case-insensitively, so a correction is a one-line change.
- Additionally match a small candidate set (`facebook`, `facebookgo`, `meta`) case-insensitively behind that constant to be robust to Beeper version differences, while never matching any non-Messenger network.
- Make **runtime verification the safety net**: the first implementation task enumerates `beeper.accounts.list()` on a machine with Messenger connected, inspects the `network` field, and pins `FACEBOOK_NETWORK` to the observed value. This task is a hard prerequisite for the client filter and must be completed against a real connected Messenger account.
- If no Messenger account is connected, the adapter is a clean no-op (R2.3) — identical to the Signal behavior when no Signal account is present — so an unverified constant never crashes a sync; it simply finds zero accounts.

## Message / Chat field mapping (inherited from signal-platform §6.5, extended for images)

`@beeper/desktop-api` `Message`: `id`, `chatID`, `accountID`, `senderID`, `senderName?`, `timestamp` (ISO string), `type` (enum `TEXT|IMAGE|VIDEO|...`), `text?`, `isSender?`, `linkedMessageID?`, `attachments[]`, `isDeleted?`, `isHidden?`.

| Beeper field | KhipuChat `Message` | Notes |
|---|---|---|
| `id` | `external_id` | |
| `chatID` | resolved to numeric `chat_id` via `upsertChat` | |
| `senderName` | `sender_name` | nullable |
| `timestamp` (ISO) | `timestamp` (unix seconds) | `Math.floor(Date.parse(t)/1000)` |
| `isSender` | `is_sender` (0/1) | R5.2 |
| `linkedMessageID` | `reply_to_external_id` | R5.4 |
| `type === 'IMAGE'` → `image`; `type === 'TEXT' && text` → `text`; else `other` | `type` | R5.5 |
| `text` | `text` (nullable) | |
| `attachments` (image) | `media_file_path`, `media_width`, `media_height`, `ocr_text` | populated by the image-sync pass (R5.6, R5.7), unlike Signal's original text-only first release |

`Chat`: `id → external_id`, `title → name`, `type` (`'single' → 'private'`, else `'group'`), `platform: 'facebook'`.

**Difference from signal's first release**: `signal-platform` deferred images to a follow-up `signal-image-sync` spec, but the current shipped `signal/sync.ts` already integrates image handling. This spec includes text **and** image ingestion from the first release (roadmap scope), reusing the exact `image-sync.ts` pattern.

## Incremental cursor (inherited from signal-platform §6.6)

`messages.search` accepts `chatIDs`, `accountIDs`, and `dateAfter` (ISO). Incremental sync iterates Messenger chats; a chat where `getLastSyncedId(chatId)` returns `null` is a first-time chat and gets full history (R4.3), otherwise `messages.search({ chatIDs:[id], accountIDs, dateAfter: since })`. No `db.ts` changes.

## Enumeration-point audit (registration must touch EVERY point)

The `facebook` platform must be registered in each of the following. TypeScript enforces the two marked **(compile-enforced)**; the rest are silent gaps if missed.

| Enumeration point | File | Enforcement |
|---|---|---|
| `Platform` union | `src/platforms/types.ts:4` | source of truth |
| `PLATFORMS` array | `src/sync-all.ts:4` | drives `khipu.ts` `PLATFORM_SET` dispatch |
| `ADAPTER_FACTORIES` | `src/watch.ts:121` | **(compile-enforced)** `Record<Platform, AdapterFactory>` is total |
| `REQUIRED_ENV_VARS` | `src/watch.ts:39` | Partial record — silent gap if missed (adapter would be skipped as "not configured") |
| `LEGACY_ENV_VARS` | `src/account-registry.ts:30` | Partial record — silent gap; **also currently missing `signal`** (see Consistency finding) |
| Web icon map `KNOWN` | `src/web/icons.ts:9` | plain object — silent gap; falls back to a letter badge |
| `sync:facebook` npm script | `package.json` `scripts` | convenience mirror of `sync:*` |

Confirmed `simple-icons` exposes `siMessenger` (title "Messenger") and `siFacebook` (title "Facebook") — `siMessenger` is the correct badge for Facebook Messenger.

## Consistency finding — `LEGACY_ENV_VARS` is missing the Beeper platforms

`src/account-registry.ts` `LEGACY_ENV_VARS` (line 30) enumerates `telegram`, `discord`, `slack`, `email` but **not `signal`** — so in legacy single-account mode (no `khipu.config.json`), a bare `BEEPER_ACCESS_TOKEN` env var never synthesizes a Signal account. Adding only `facebook` here would silently diverge the two Beeper-backed platforms. **Decision**: add BOTH `signal: ['BEEPER_ACCESS_TOKEN']` and `facebook: ['BEEPER_ACCESS_TOKEN']` to `LEGACY_ENV_VARS` (R8.1, R8.2), so single-account env mode works identically for both. This is a small, targeted fix to an adjacent shared file, explicitly called out so it is not treated as scope creep.

## Synthesis outcomes

- **Adopt, do not re-derive**: the facebook adapter is a structural clone of the Signal adapter. No new abstraction is introduced; premature generalization of a shared "beeper adapter base" is rejected (same reasoning as signal research §Option C) — two small, independent, mockable adapters are clearer than a shared base coupling two specs.
- **One new dependency? No** — `@beeper/desktop-api` is already installed. This spec adds zero npm dependencies.
- **File-size budget**: each of `client.ts`, `sync.ts`, `image-sync.ts` stays under 200 lines (the Signal counterparts are 110/181/135 lines; the facebook versions are near-identical in size).
- **Single genuine risk**: the Messenger `network` string. Mitigated by the single-constant filter plus the mandatory runtime-verification first task, plus the clean no-op fallback.

## Requirement → resolution map

| Req | Resolution |
|---|---|
| 1 | Register `facebook` in all seven enumeration points (§Enumeration-point audit) |
| 2 | `BeeperFacebookClient` scopes by `FACEBOOK_NETWORK` account IDs; no-op when none; error-wrap Beeper failures |
| 3 | `runBackfillImpl` — idempotent via `upsertChat`/`insertMessage` |
| 4 | `runIncrementalImpl` with `getLastSyncedId` branch + `dateAfter`; `--force` via runner |
| 5 | `mapMessage` (text/image/other) + `processFacebookImageMessages` (download + OCR) |
| 6 | Zero changes to MCP/CLI/Web query paths; write `platform='facebook'` rows + `siMessenger` badge |
| 7 | Missing-token stderr + `process.exit(1)`; Beeper-down error wrapping; per-chat isolation |
| 8 | Add `signal` + `facebook` to `LEGACY_ENV_VARS` |

## Sources

- Live Beeper Desktop `get_accounts` probe (this machine, 2026-08-01).
- `src/platforms/signal/{client,sync,image-sync}.ts`; `.kiro/specs/signal-platform/{design,tasks,research}.md`.
- Beeper Developer Docs — Accounts resource: https://developers.beeper.com/desktop-api-reference/resources/accounts
- Beeper Messenger network guide: https://help.beeper.com/en_US/chat-networks/messenger
