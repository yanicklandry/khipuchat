# Research & Design Decisions

## Summary
- **Feature**: `signal-direct`
- **Discovery Scope**: Extension (second backend for the existing `signal` platform) + Complex Integration (external GPLv3 process over JSON-RPC)
- **Key Findings**:
  - `signal-cli` (AsamK, ~v0.13.x) exposes a newline-delimited JSON-RPC 2.0 API in `daemon` mode over a UNIX socket (`--socket`, default `$XDG_RUNTIME_DIR/signal-cli/socket`) or TCP (`--tcp`, default `localhost:7583`).
  - Linking as a secondary device uses JSON-RPC `startLink` (returns `{ deviceLinkUri: "sgnl://linkdevice?uuid=...&pub_key=..." }`) then `finishLink` (`{ deviceLinkUri, deviceName }`, blocks until the primary phone approves). No phone-number registration. signal-cli only emits the raw URI; the caller renders the QR.
  - Incoming messages arrive as JSON-RPC **notifications** (`method: "receive"`, no `id`) carrying an `envelope`. Own-sent messages (from the phone) arrive under `syncMessage.sentMessage`; received messages under `dataMessage`. `subscribeReceive`/`unsubscribeReceive` control push; a request-style `receive` (with `-t TIMEOUT`) returns currently-queued messages.
  - A freshly linked device authoritatively receives messages **only from link-time forward**. Signal's 2025 "Synchronized Start" (Link'n'Sync) history transfer is **not implemented in signal-cli** (tracked in AsamK/signal-cli#1708). Encrypted media older than ~45 days is deleted server-side (Signal blog). => live-forward is the only guarantee; historical backfill is effectively unavailable via this path.

## Research Log

### signal-cli JSON-RPC transport
- **Context**: Confirm daemon startup, framing, and how a Node client should connect.
- **Sources Consulted**: signal-cli man pages (`signal-cli.1.adoc`, `signal-cli-jsonrpc.5.adoc`), JSON-RPC service wiki.
- **Findings**: `signal-cli daemon --socket[=PATH]` serves NDJSON JSON-RPC 2.0; each request is a single-line JSON object with a unique `id`; notifications have no `id`. TCP and HTTP interfaces also exist.
- **Implications**: A thin Node socket client (`net.connect`) with line-buffering, id→promise correlation for requests, and a notification callback for `receive` is sufficient. No third-party signal-cli SDK is needed or wanted (arm's-length IPC keeps GPLv3 at a distance).

### Device linking & QR
- **Context**: How to link as a secondary device and render the QR.
- **Sources Consulted**: signal-cli "Linking other devices (Provisioning)" wiki; man pages.
- **Findings**: `startLink`/`finishLink` methods; `signal-cli link -n NAME` CLI equivalent prints the `sgnl://linkdevice` URI. signal-cli has no QR image output.
- **Implications**: The linking flow prints the raw URI and renders an ASCII QR in the terminal (via `qrcode-terminal`). `finishLink` blocks until approval, giving a natural timeout boundary.

### Message envelope shape & attachments
- **Context**: Map envelopes to the shared `chats`/`messages` schema and reuse the media/OCR pipeline.
- **Sources Consulted**: man pages, signal-cli JSON data models.
- **Findings**: Envelope carries `source`, `sourceNumber`, `sourceUuid`, `sourceName`, `timestamp`; `dataMessage.message` (text), `dataMessage.groupInfo`/GroupV2 `groupId` (base64), `dataMessage.attachments[]` (`id`, `contentType`, `filename`, `size`, `width`, `height`), `dataMessage.quote` (reply); own-sent under `syncMessage.sentMessage` (with `destination`/group + `message`). Decrypted attachments are written to `<data-dir>/attachments/<id>` (default `~/.local/share/signal-cli/attachments/`).
- **Implications**: Chat identity: group => `group.<groupId>`; direct => peer `sourceUuid`/`sourceNumber` (received) or `sentMessage.destination`/group (sent). Message `external_id` = `<senderOrSelf>.<timestamp>`; dedup via the existing `(external_id, chat_id)` conflict rule. `is_sender=1` for `syncMessage.sentMessage`. Type classification: `image` if any attachment is `image/*`, else `text` if message text present, else `other`. Image files are read locally from the attachments dir by `id` (no separate download API call).
- **Uncertainty flagged**: exact `groupInfo`/`groupV2` and `listContacts` sub-field names come from signal-cli's data models, not verbatim man-page text — confirm against source during implementation before hard-coding parsing.

### History-on-link limitation
- **Context**: Scope the backfill guarantee honestly.
- **Sources Consulted**: AsamK/signal-cli#1708; Signal blog "A Synchronized Start for Linked Devices".
- **Findings**: Link'n'Sync history transfer is unimplemented in signal-cli; 45-day server media expiry is a Signal-server fact.
- **Implications**: Requirements 7.x codify live-forward as the only guarantee; `listGroups`/`listContacts` seed chat records but do not recover message history. Full back-history is deferred to a separate future spec.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Second `PlatformAdapter` + backend selector (chosen) | New signal-cli adapter alongside the Beeper adapter under `src/platforms/signal/`, chosen via `SIGNAL_BACKEND` | Reuses runner/ingestion/media pipeline; Beeper path untouched; both under one `signal` platform | Two backends can produce different `external_id` namespaces for the same conversation | Matches existing adapter conventions |
| DIY `@signalapp/libsignal-client` Node client | Reimplement a linked-device client in-process | No external process | Reimplements signal-cli against an unsupported private protocol; AGPLv3 linking contaminates the codebase | Rejected (brief) |
| `signald` | Alternative daemon | Similar IPC model | Abandoned upstream; signal-cli recommended | Rejected (brief) |

## Design Decisions

### Decision: Arm's-length signal-cli over a socket
- **Context**: signal-cli is GPLv3 and requires a JVM; KhipuChat is MIT-spirited and local-only.
- **Selected Approach**: Drive a separately-installed `signal-cli daemon` purely over its JSON-RPC socket; never import, vendor, or link its source. Installing signal-cli + JVM is a documented operator prerequisite.
- **Rationale**: "Mere aggregation" keeps the GPLv3 obligation at the process boundary; no build-time coupling.
- **Trade-offs**: Operator must install and run signal-cli; adapter must tolerate an absent/unreachable daemon.

### Decision: Backend selector via `SIGNAL_BACKEND`
- **Context**: Preserve the working Beeper adapter while adding the signal-cli path.
- **Selected Approach**: `SIGNAL_BACKEND` env (`beeper` default | `cli`) resolves which `AdapterFactory` the signal entrypoint and watch loop use; both emit `platform: 'signal'`.
- **Rationale**: Zero change to query surfaces; existing Beeper users unaffected by default.
- **Trade-offs**: Switching backends for the same account may create parallel chat records (different id namespace) — documented as a known limitation.

### Decision: Single default account (no multi-account for cli)
- **Context**: The current Beeper signal entrypoint runs a single `default` adapter and does not iterate registry accounts.
- **Selected Approach**: The signal-cli backend also runs a single `default` account; the registry synthesizes a `default` signal account when `SIGNAL_BACKEND=cli` even without `BEEPER_ACCESS_TOKEN`, so the watch loop picks it up.
- **Rationale**: Matches existing signal behavior; avoids scope creep into multi-account routing (a separate roadmap item).

## Risks & Mitigations
- **signal-cli not installed / daemon down** — Detect connection failure; emit an actionable error naming the prerequisite; non-zero exit for explicit runs; skip (don't crash) during all-platform sync.
- **Not yet linked** — Guide the operator to run the linking flow; never write partial data.
- **Envelope field drift across signal-cli versions** — Isolate all parsing in one pure mapping module with defensive optional-field handling; cover with fixtures.
- **Backend-switch duplicate chats** — Documented limitation; out of scope to reconcile id namespaces here.
- **`qrcode-terminal` has no bundled types** — Add a minimal local ambient module declaration to keep `strict`/no-`any`.

## References
- [signal-cli man page](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc) — daemon flags, link/receive commands
- [signal-cli JSON-RPC man page](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc) — method list, notification shape
- [JSON-RPC service (wiki)](https://github.com/AsamK/signal-cli/wiki/JSON-RPC-service) — daemon usage
- [Linking other devices (wiki)](https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)) — startLink/finishLink
- [signal-cli#1708](https://github.com/AsamK/signal-cli/issues/1708) — Link'n'Sync unimplemented
- [Signal blog: A Synchronized Start for Linked Devices](https://signal.org/blog/a-synchronized-start-for-linked-devices/) — 45-day media, history-on-link
