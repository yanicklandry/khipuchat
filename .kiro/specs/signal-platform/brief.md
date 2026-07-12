# Brief: signal-platform

## Problem
Signal is the operator's primary messaging platform and is not archived by
KhipuChat at all. Signal Desktop's local SQLite store is encrypted with a key held
in the OS keychain, making direct local-DB reverse-engineering meaningfully harder
and more fragile than the Telegram/iMessage local-DB approach.

## Current State
- No Signal adapter exists in `src/platforms/`.
- The operator already runs Beeper Desktop, which bridges Signal (and WhatsApp,
  Telegram, iMessage, etc.) behind one MCP connector, exposing tools including
  `search_messages` (with `chatIDs`, `mediaTypes`, `sender`, date-range filters),
  `list_messages`, `search_chats`, and `send_message`. This has been validated
  manually: Signal messages and image attachment references were successfully
  retrieved via Beeper's `search_messages` with `mediaTypes: ['image']`.
- `platform-abstraction`'s `PlatformAdapter` interface (`runBackfill`,
  `startListener`, optional `syncIncremental`) is the existing extension point
  every other platform implements.

## Desired Outcome
Signal becomes a KhipuChat platform: chats and text messages sync into `chats` /
`messages` the same way Telegram or iMessage do, queryable via the existing
`list_chats`, `find_chat_by_name`, `list_messages`, `search_messages`,
`get_chat_summary` MCP tools without those tools needing Signal-specific changes.

## Approach
Ingest via Beeper Desktop's own MCP connector rather than reverse-engineering
Signal Desktop's encrypted local database — Beeper already does the hard part
(decryption, normalization across platforms) and exposes it over a stable API.
Concretely: a new `signal` adapter whose `runBackfill` / `syncIncremental` call
into Beeper's `search_messages` / `list_messages` tools (scoped to Signal chats)
instead of reading a local file/DB directly, and map Beeper's message/chat shape
onto KhipuChat's `Chat` / `Message` types.

This requires calling another MCP server's tools from within KhipuChat's own sync
code, which is architecturally new for this codebase (every existing adapter talks
to a local DB or a first-party API/library directly, not to another MCP server) —
treat the design phase as needing to establish how that connection is made (e.g.
Beeper's underlying HTTP/local API, if one exists outside the MCP tool-call layer,
vs. some other integration point), not just "call the tool."

## Scope
- **In**:
  - Research spike: confirm what Beeper Desktop exposes besides its MCP tool
    surface (a local HTTP API, if any) that a long-running Node sync process can
    call directly, since KhipuChat's adapters are not themselves MCP clients today.
  - New `signal` platform adapter implementing `PlatformAdapter`
    (`runBackfill`, `syncIncremental`, `startListener` if a live-update mechanism
    exists).
  - Chat and text-message sync only (no image handling — see `signal-image-sync`).
  - Mapping Beeper's chat/message identity model onto KhipuChat's
    `external_id`/`account` scheme.
- **Out**:
  - Image/attachment sync for Signal (separate spec: `signal-image-sync`, depends
    on this spec plus `telegram-image-sync`'s shared OCR/storage/`get_image`
    infrastructure).
  - Any platform reachable via Beeper other than Signal (WhatsApp, etc. already
    have or will have their own native KhipuChat adapters; don't dual-source).
  - Changes to Beeper Desktop itself.

## Boundary Candidates
- New `src/platforms/signal/` adapter module.
- Whatever integration layer is needed to call Beeper from a non-MCP-client
  context (research spike output).

## Out of Boundary
- Beeper Desktop internals/config.
- Non-Signal platforms.
- Image sync (this spec is text/chat sync only).

## Upstream / Downstream
- **Upstream**: `platform-abstraction` (`PlatformAdapter` interface),
  `multi-account` (if Signal ever needs multi-account, likely not for v1).
- **Downstream**: `signal-image-sync` (depends on both this spec's chat/message
  sync AND `telegram-image-sync`'s shared OCR/storage/`get_image` pieces).

## Constraints
- Keep each source file under 200 lines.
- DB operations remain synchronous (better-sqlite3); MCP over stdio only for
  KhipuChat's own server — calling out to Beeper is a client-side concern within
  the adapter, not a change to how KhipuChat itself serves MCP.
- Self-hosted, no external cloud services (Beeper Desktop running locally on the
  operator's machine satisfies this).
- Must degrade gracefully if Beeper Desktop is not running (clear error, not a
  crash) — Signal ingestion has a runtime dependency other adapters don't have.
