# Brief: facebook-messenger

## Problem
KhipuChat archives Telegram, iMessage, Discord, Slack, WhatsApp, Signal, and email, but not
Facebook Messenger — a primary 1:1 and group chat channel for many users. Those
conversations are absent from the unified archive, search, and Claude/MCP queries.

## Current State
- Seven platforms are implemented behind the `PlatformAdapter` interface in
  `src/platforms/<name>/`.
- `signal-platform` already syncs via the **Beeper Desktop API** (`@beeper/desktop-api`,
  `BEEPER_ACCESS_TOKEN`), filtering accounts by `network === 'signal'`. Beeper also bridges
  Facebook Messenger, so the identical pattern applies with a different network filter.
- `Platform` union (`src/platforms/types.ts`), `PLATFORMS` (`src/sync-all.ts`), the watch
  daemon's `ADAPTER_FACTORIES` + `REQUIRED_ENV_VARS`, web icons, and the `sync:*` scripts
  all enumerate platforms and must gain a `facebook` entry.

## Desired Outcome
- A `facebook` platform adapter syncs Messenger chats and messages (text + images) into the
  shared `chats`/`messages` tables via the same `runPlatformSync` pipeline every other
  adapter uses.
- Messenger conversations appear in CLI/MCP/web search and semantic search with a Messenger
  badge, at parity with Signal.
- `khipu sync facebook`, `khipu sync facebook@<account>`, and the `khipu sync all` daemon all
  cover Facebook Messenger; incremental sync via `sync_state` works per account.

## Approach
Clone the `signal-platform` structure into `src/platforms/facebook/`:
- `client.ts` — a Beeper Desktop client filtering accounts by `network === 'facebook'`
  (confirm Beeper's exact network identifier for Messenger during design; candidates:
  `facebook`, `facebookgo`, `meta`), exposing `listChats` / `listChatMessages` /
  `listNewChatMessages` scoped by `accountIDs`.
- `sync.ts` — `mapChat` / `mapMessage` / `runBackfillImpl` / incremental sync /
  `createFacebookAdapter`, mapping Beeper message types to `text` / `image` / `other`.
- `image-sync.ts` — reuse the Signal attachment-fetch + OCR pipeline for Messenger photos.
Then register `facebook` in every enumeration point and add a `sync:facebook` script + tests
mirroring the Signal suite. Chosen because `@beeper/desktop-api` is already a dependency, the
Signal adapter is a proven working template, and it keeps everything local (no Facebook cloud
API, no ban-prone unofficial scraper).

## Scope
- **In**: `src/platforms/facebook/{client,sync,image-sync}.ts`; `facebook` added to the
  `Platform` union, `PLATFORMS`, `ADAPTER_FACTORIES`, `REQUIRED_ENV_VARS` (BEEPER_ACCESS_TOKEN),
  web icon map, and `sync:facebook` npm script; text + image message ingestion with OCR;
  incremental + backfill sync per account; tests mirroring `signal-*` tests; README/steering
  platform-list updates.
- **Out**: Sending Messenger messages; Instagram DMs; Facebook Groups/Pages/Marketplace;
  reactions/threads richer than the existing message model; any non-Beeper transport
  (official Graph API or unofficial scrapers).

## Boundary Candidates
- Beeper client + network filter (`network === 'facebook'`) — isolates the transport.
- Message/chat mapping (Beeper shape → generic `Chat`/`Message`).
- Image/attachment sync + OCR reuse.
- Platform-enumeration registration (union, PLATFORMS, factories, icons, scripts).

## Out of Boundary
- The shared image storage + OCR pipeline (owned by telegram-image-sync / image-support).
- The Beeper access-token acquisition doc/prompt (owned by setup-wizard).
- `sync_state` / incremental engine (owned by incremental-sync; this spec only consumes it).

## Upstream / Downstream
- **Upstream**: signal-platform (template + Beeper client conventions), platform-abstraction
  (`PlatformAdapter`), incremental-sync (`runPlatformSync`, `sync_state`), image-support
  (attachment + OCR pipeline), multi-account (account-scoped sync).
- **Downstream**: sync-watcher / khipu-cli automatically cover it once registered; setup-wizard
  should list the Beeper token step.

## Existing Spec Touchpoints
- **Extends**: none (new platform), but must touch shared enumeration points listed in Scope.
- **Adjacent**: signal-platform (near-identical Beeper adapter — keep them consistent; if the
  Signal legacy-registry path lacks a `BEEPER_ACCESS_TOKEN` entry in
  `account-registry.LEGACY_ENV_VARS`, add it for both so single-account env mode works).

## Constraints
- Requires a running Beeper Desktop with Facebook Messenger connected and a valid
  `BEEPER_ACCESS_TOKEN`; when absent, the adapter must skip cleanly (mirror Signal).
- Keep each source file under 200 lines (steering standard).
- Synchronous DB layer; map Beeper timestamps to unix seconds as Signal does.
- Confirm Beeper's Messenger network identifier before finalising the filter (design task).
