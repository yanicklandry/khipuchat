# Gap Analysis: signal-platform

## Analysis Summary

- **Scope**: New `src/platforms/signal/` adapter implementing `PlatformAdapter` via Beeper Desktop as data source; 2-line surgical changes to 2 existing files to register `signal` as a known platform; everything else is additive.
- **Critical unknown**: How to call Beeper from a Node.js sync process — Beeper exposes its data through an MCP server, but KhipuChat adapters are not MCP clients. The Beeper client layer design is the primary research spike.
- **No interface changes**: `PlatformAdapter` and the shared sync runner are used as-is; all existing adapters remain unchanged.
- **Estimated effort**: M (3–7 days), Risk: Medium — the adapter pattern is known; the Beeper integration transport is the unresolved variable.
- **Recommended approach**: Option B (new components) — new `signal/client.ts` (Beeper MCP client) + `signal/sync.ts` (adapter), with 2 surgical additions to existing files. `@modelcontextprotocol/sdk` (already a production dependency) provides the Client class needed to call Beeper's MCP server.

---

## 1. Current State Investigation

### Existing Platform Adapter Pattern

Every platform follows an identical structure:

```
src/platforms/<name>/
  client.ts    # API/data-source wrapper (optional for simpler adapters)
  sync.ts      # PlatformAdapter implementation + CLI entrypoint
```

**`PlatformAdapter` interface** (`src/platforms/types.ts:6`):
```typescript
export interface PlatformAdapter {
  readonly platform: Platform
  readonly account: string
  runBackfill(db: Database.Database): Promise<void>
  startListener(db: Database.Database): void
  syncIncremental?(db: Database.Database, since: Date): Promise<void>
}
```
`Platform` is a union literal: `'telegram' | 'imessage' | 'discord' | 'slack' | 'whatsapp' | 'wechat' | 'email'` (`src/platforms/types.ts:4`).

**`PLATFORMS` constant** (`src/sync-all.ts:4`): the canonical list used by `sync-all.ts` and `khipu.ts` for dispatch and validation.

**Adapter entrypoint contract**: each `sync.ts` exports a default adapter instance, a factory function `create<Name>Adapter(account, credentials): PlatformAdapter`, and a `main()` that calls `runPlatformSync(adapter, db, argv)`. `runPlatformSync` in `sync-runner.ts` selects backfill vs. incremental and records sync state.

**Closest analog**: Discord and Slack — both call a remote API via `globalThis.fetch` with no local DB. Signal will call Beeper's API instead. The Slack adapter (91 lines for the adapter, ~40 lines for the client) is the best size reference.

### DB Integration Points

- `upsertChat(chat: Chat): number` — idempotent by `(platform, account, external_id)`, returns chat row id
- `insertMessage(msg: Message): void` — idempotent via `INSERT OR IGNORE` on `(platform, external_id, chat_id)`
- `embedNewMessages(chatIds)` / `embedNewChats(chatIds)` — called after each chat loop, guarded by `isIndexed()`
- No schema changes needed: `platform`, `account`, `external_id`, `reply_to_external_id`, and the `media_*` nullable columns are all already present

### Registration Touch Points (existing files)

| File | Current state | Change needed |
|---|---|---|
| `src/platforms/types.ts:4` | `Platform` union, 7 values | Add `\| 'signal'` |
| `src/sync-all.ts:4` | `PLATFORMS` array, 7 entries | Add `'signal'` |

`khipu.ts` derives `PLATFORM_SET` from `PLATFORMS` at import time — no separate change needed there.

---

## 2. Requirements Feasibility Analysis

### Requirement → Technical Need Map

| Requirement | Technical Need | Status |
|---|---|---|
| R1: Signal platform registration | Add `signal` to `Platform` union + `PLATFORMS`; `khipu sync signal` already dispatches to `src/platforms/signal/sync.ts` by convention | Present (2-line change) |
| R1.3: Included in `khipu sync all` | Add `'signal'` to `PLATFORMS` array in `sync-all.ts` | Present (1 of the 2-line changes above) |
| R2: Beeper connectivity + Signal-only scope | Beeper client that scopes all queries to `signal` network/platform | **Research Needed** (see §3) |
| R2.3: Graceful Beeper unavailable | Catch connection error, write human-readable message to stderr, re-raise so `sync-runner` records failure | Present pattern (see discord/slack credential-missing error flow) |
| R2.4: Per-chat error isolation | Try/catch per chat in backfill loop; log and continue | Straightforward, follows existing patterns |
| R3: Chat + message backfill, dedup | `upsertChat` + `insertMessage` already idempotent | Present |
| R4: Incremental sync | Implement `syncIncremental?(db, since)` on the adapter | Present (optional method in interface) |
| R4.2: Record sync point | `setPlatformLastSyncedAt` called by `runPlatformSync` after success | Present (sync-runner handles this) |
| R5: Message metadata (sender, timestamp, is_sender, reply_to) | Map Beeper message fields → `Message` type | **Research Needed** (Beeper message shape TBD) |
| R5.6: Text-only; skip media | Filter out media-only messages; store `text` field only | Straightforward once Beeper shape is known |
| R6: MCP/CLI/Web parity | Zero changes to MCP tools, CLI, or Web UI — achieved by inserting into existing `chats`/`messages` tables with `platform='signal'` | Present |
| R7: Graceful degradation in `khipu sync` (all-platform) | `runAllPlatforms` in `sync-all.ts` already logs failures per platform and continues; Signal failure propagates non-zero exit only for explicit `khipu sync signal` | Present |

### Gaps and Constraints

**CRITICAL — Research Needed: Beeper integration transport**

Beeper Desktop exposes its data through an MCP server. KhipuChat sync scripts are plain Node.js processes, not MCP clients. Three candidate integration paths need to be evaluated in the design phase:

- **Path A — Beeper local HTTP API**: Beeper may expose a REST/HTTP API on a local port (separate from its MCP surface) that can be called with `globalThis.fetch`. Lowest complexity if available; no new MCP machinery needed. Must confirm: does Beeper have a documented local HTTP API? What port? What auth?
- **Path B — MCP client over stdio**: Spawn Beeper's MCP server process and communicate via `@modelcontextprotocol/sdk` `Client` with `StdioClientTransport`. Requires knowing the command to spawn Beeper's MCP server. The SDK is already a production dependency — `Client` is importable from `@modelcontextprotocol/sdk/client/index.js` and `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`.
- **Path C — MCP client over HTTP/SSE**: Connect to an already-running Beeper MCP server on a local port (e.g. `http://localhost:<port>/sse`) using `SSEClientTransport`. Same SDK, different transport.

**Research action for design phase**: Inspect the running Beeper Desktop process (`lsof -i | grep -i beeper`), check for a local HTTP server, and check the Claude Desktop / claude.ai MCP server config that wires up the Beeper tools to understand what transport and command are used.

**Known constraint: Beeper message shape**

The Beeper `list_messages` / `search_messages` tools return a message format that has not been formally mapped to KhipuChat's `Message` type. The brief confirms Signal messages were retrievable via Beeper's `search_messages` with `mediaTypes: ['image']`, but the full field structure (sender id, sender name, timestamp format, reply reference) must be confirmed during design.

**Known constraint: Signal-platform filtering in Beeper**

Beeper bridges multiple platforms. All queries must be scoped to Signal chats only. The available filter parameters on `search_chats` and `list_messages` need to verify that a Signal-network filter exists (e.g. a `platform` or `network` parameter). If no such filter is available, the adapter must post-filter on Beeper's chat metadata.

---

## 3. Implementation Approach Options

### Option A: Extend Existing Components

Fold the Beeper client call directly into a single `signal/sync.ts` with no separate client module.

- **Trade-offs**:
  - ✅ Fewer files
  - ❌ Mixes Beeper API surface with adapter logic; harder to test the mapping functions in isolation
  - ❌ Likely exceeds the 200-line file limit given the client + adapter logic combined

Not recommended.

### Option B: Create New Components (Recommended)

Two new files following the Discord/Slack pattern:

```
src/platforms/signal/
  client.ts    # BeeperClient: wraps Beeper tool calls, returns typed Signal chat/message shapes
  sync.ts      # SignalAdapter: maps BeeperClient output → Chat/Message, implements PlatformAdapter
tests/
  signal.test.ts
```

Plus 2 surgical additions to existing files (Platform union + PLATFORMS array).

- **Integration**: `sync.ts` calls `createBeeperClient(...)` from `client.ts`; the client abstracts whichever transport is chosen (Path A/B/C above)
- **Trade-offs**:
  - ✅ Clean separation — client layer is mockable in tests
  - ✅ Consistent with all other platform adapters
  - ✅ Each file comfortably under 200 lines
  - ✅ No new npm dependencies (MCP SDK already present; `globalThis.fetch` built-in)
  - ❌ Two new files instead of one

### Option C: Hybrid — Inline client with extracted utilities

Single `sync.ts` plus shared `beeper-client.ts` at a higher level (e.g. `src/platforms/beeper/`) for potential reuse by `signal-image-sync`.

- **Trade-offs**:
  - ✅ Positions reuse for `signal-image-sync`
  - ❌ Premature abstraction — `signal-image-sync` will define its own image attachment needs; sharing too early couples the specs
  - ❌ More complex than needed for this spec

Not recommended at this stage; revisit when `signal-image-sync` is designed.

---

## 4. Effort and Risk

| Dimension | Rating | Justification |
|---|---|---|
| Effort | M (3–7 days) | Adapter pattern is known and well-precedented; 1–2 days for Beeper integration research + client implementation; 1–2 days for adapter mapping + tests; 1 day for graceful-degradation edge cases |
| Risk | Medium | Adapter logic is low-risk (familiar pattern); Beeper integration transport is the single unknown — if Path A (local HTTP) is confirmed, risk drops to Low; if only Path B/C (MCP client) is available, adds a small layer of new machinery but `@modelcontextprotocol/sdk` already handles it |

---

## 5. Recommendations for Design Phase

**Preferred approach**: Option B (new components) — `signal/client.ts` + `signal/sync.ts` + tests, with 2 surgical additions to existing files.

**Key decisions to resolve in design**:

1. **Beeper transport**: Run `lsof -i | grep -i beeper` on the operator's machine; check if Beeper serves a local HTTP API. Determine the exact MCP server configuration (command + args) used by claude.ai to connect. This determines whether `client.ts` uses `globalThis.fetch`, `StdioClientTransport`, or `SSEClientTransport`.
2. **Signal scoping**: Confirm which Beeper tool parameter scopes queries to Signal chats only (network filter, platform filter, or post-filter by chat metadata).
3. **Beeper message shape**: Document the field names returned by `list_messages` / `search_messages` for a Signal chat; map them to `Message.external_id`, `Message.sender_id`, `Message.sender_name`, `Message.timestamp`, `Message.is_sender`, `Message.reply_to_external_id`.
4. **`is_sender` detection**: Determine how Beeper identifies the operator's own messages (e.g. a `fromMe` boolean or matching sender id against a known account id).
5. **Incremental sync cursor**: Confirm whether Beeper accepts a `since` timestamp parameter (or equivalent) on `list_messages` / `search_messages`, to implement `syncIncremental` efficiently.
6. **`startListener`**: Confirm whether Beeper exposes a real-time event stream; if not, implement as a no-op (consistent with Discord and Slack adapters).

**Research items to carry forward**:
- Beeper transport and auth (Critical — blocks implementation)
- Beeper message field mapping (High — needed for correct `mapMessage`)
- Signal-only filter parameter in Beeper tools (High — prevents ingesting non-Signal platforms)
- `is_sender` field identification (Medium — needed for R5.2)
- Incremental cursor support (Medium — needed for R4 efficiency)

---

## 6. Design-Phase Resolutions (2026-07-12)

All open items from §5 were resolved by directly probing the running Beeper Desktop instance and the official SDK. Evidence captured below.

### 6.1 Transport — RESOLVED: local HTTP REST API (Path A)

Beeper Desktop runs a local HTTP server (Express) bound to `127.0.0.1:23373` (`lsof` confirmed process `Beeper 72063` LISTEN). `GET /` redirects to `/v1/info`, which reports:

- `app.version: 4.2.972`, `server.status: running`, `server.mcp_enabled: true`, `server.remote_access: false`
- REST base `http://127.0.0.1:23373/v1`, OpenAPI spec at `/v1/spec` (title "Beeper Client API", version **5.0.0**)
- MCP endpoint at `/v0/mcp`; WebSocket events at `/v1/ws`

**Decision**: use the local REST API (Path A), **not** the MCP client transports (Path B/C from the gap analysis). Path A is the lowest-complexity option, needs no stdio subprocess or MCP session handshake, and is the surface the official SDK targets. `/v1/ws` is noted for a future real-time listener but is out of this spec's scope.

### 6.2 Build vs adopt — RESOLVED: adopt `@beeper/desktop-api` v5.0.0

The official TypeScript SDK exists on npm, version-matched to the API (5.0.0), with **zero runtime dependencies** (`npm pack` inspection: `dependencies: {}`). Client construction and auth:

```ts
const client = new BeeperDesktop({ accessToken: process.env['BEEPER_ACCESS_TOKEN'] })
await client.accounts.list()
await client.chats.search({ accountIDs: [...] })
```

**Decision**: adopt the SDK for the client layer rather than hand-rolling `globalThis.fetch`. Rationale: (a) zero transitive dependencies keeps the local-only, self-hosted footprint intact; (b) it provides the exact `Account`/`Chat`/`Message` types, removing hand-maintained response typings; (c) it uses a plain static `accessToken`, mapping cleanly to the existing credential pattern; (d) it is version-locked to the API surface probed here. This is the one new npm dependency; all other work is additive. `@modelcontextprotocol/sdk` is **not** needed for Signal.

### 6.3 Auth — RESOLVED: static Bearer access token

The OpenAPI `securitySchemes` expose both `bearerAuth` (HTTP bearer) and `oauth2` (authorization_code + PKCE, `token_endpoint_auth_method: none`, scopes `read`/`write`). Unauthenticated requests return `401 Unauthorized` with `WWW-Authenticate: Bearer`. Dynamic client registration at `/oauth/register` succeeds without prior auth.

**Decision**: the adapter consumes a **static access token** supplied as credential `BEEPER_ACCESS_TOKEN` (account-registry field or env var), exactly like `SLACK_USER_TOKEN` / `DISCORD_TOKEN`. Obtaining the token (via Beeper Desktop's OAuth flow) is a one-time **operator setup step**, out of the adapter's runtime scope. The adapter treats a missing/invalid token as a fatal, human-readable startup error (R2.3 / R7).

### 6.4 Signal-only scoping — RESOLVED: filter by account network

`Account` has a `network: string` field; `Chat` and message/chat search accept an `accountIDs` filter (confirmed in `/v1/spec` params). There is no single "signal" network filter parameter, but scoping is exact via account:

1. `client.accounts.list()` → select accounts where `network === 'signal'` → collect their `accountID`s.
2. Pass `accountIDs: <signalAccountIDs>` to every `chats.search` / `messages.search` call.

**Decision**: this guarantees only Signal chats/messages are ingested (R2.2), preventing dual-sourcing of other Beeper-bridged platforms. If no Signal account is connected, the adapter reports a clear no-op and exits cleanly.

### 6.5 Message field mapping — RESOLVED (from `/v1/spec` component schemas)

`Message`: `id`, `chatID`, `accountID`, `senderID`, `senderName?`, `timestamp` (ISO string), `type` (enum `TEXT|NOTICE|IMAGE|VIDEO|VOICE|AUDIO|FILE|...`), `text?`, `isSender?` (boolean), `linkedMessageID?`, `attachments[]`, `isDeleted?`, `isHidden?`.

| Beeper field | KhipuChat `Message` | Notes |
|---|---|---|
| `id` | `external_id` | |
| `chatID` | (resolve to numeric `chat_id` via `upsertChat`) | |
| `senderID` | `sender_id` | |
| `senderName` | `sender_name` | nullable |
| `timestamp` (ISO) | `timestamp` (unix seconds) | `Math.floor(Date.parse(t)/1000)` |
| `isSender` | `is_sender` (0/1) | resolves R5.2 |
| `linkedMessageID` | `reply_to_external_id` | reply reference, resolves R5.4 |
| `type === 'TEXT'` | `type='text'`, else `'other'` | |
| `text` | `text` (nullable) | only field carrying content |
| `attachments` | **omitted** | never populate `media_*`; deferred to `signal-image-sync` |

`Chat`: `id → external_id`, `title → name`, `network` (confirm `'signal'`), `type` (`'single' → 'private'`, `'group' → 'group'`).

### 6.6 Incremental cursor — RESOLVED: `dateAfter` + `getLastSyncedId`

`messages.search` accepts `dateAfter` (ISO), `chatIDs`, and `accountIDs` (confirmed params). The shared `sync-runner` already computes platform-level `since` and calls `syncIncremental(db, since)`.

**Decision**: incremental sync iterates Signal chats; for each, if the existing helper `getLastSyncedId(chatId)` returns `null` (no prior messages → first-time chat, R4.3) it fetches full history, otherwise it fetches `messages.search({ chatIDs:[id], accountIDs, dateAfter: since })`. Uses only existing DB read helpers — no `db.ts` API changes.

### 6.7 `startListener` — RESOLVED: no-op

Beeper exposes `/v1/ws`, but real-time ingestion is out of scope for this spec (requirements Boundary Context). `startListener` is implemented as a no-op, consistent with the Discord and Slack adapters.

---

## Post-Implementation Gap Validation (2026-07-13)

All 975 tests pass (43 test files). The signal adapter is fully implemented in the codebase. This section records the validation findings.

### Implementation confirmed present

| Component | File | Status |
|---|---|---|
| `BeeperSignalClient` interface + `createBeeperSignalClient` | `src/platforms/signal/client.ts` (125 lines) | Complete |
| `mapChat`, `mapMessage`, `runBackfillImpl`, `runIncrementalImpl`, `createSignalAdapter` | `src/platforms/signal/sync.ts` (176 lines) | Complete |
| `processSignalImageMessages` (signal-image-sync spec scope) | `src/platforms/signal/image-sync.ts` (112 lines) | Complete |
| `'signal'` in `Platform` union | `src/platforms/types.ts:4` | Registered |
| `'signal'` in `PLATFORMS` array | `src/sync-all.ts:4` | Registered |
| `khipu sync signal` routing | `src/khipu.ts` via shared `PLATFORM_SET` | Routing correct |

### Remaining gaps (test coverage only)

**Gap 1 — `makeMockSignalClient` missing `fetchAttachmentBuffer`** (`tests/signal.test.ts:269-280`)
TypeScript strict mode would flag this as a missing required interface method. `tsx` strips types at runtime so tests pass, but a `tsc --noEmit` pass would fail. Fix: add `fetchAttachmentBuffer: vi.fn().mockResolvedValue(null)` to the mock factory.

**Gap 2 — Signal absent from `query-parity.test.ts` seed data**
The cross-platform parity test only seeds Telegram and iMessage. A Signal chat + message seed row would close Req 6.5 in that dedicated test file (it is already covered in `signal.test.ts` "Signal platform query parity" describe block).

**Gap 3 — Signal absent from `surface-e2e.test.ts` seed data**
The agent-native parity test (MCP handler vs web route vs CLI) does not include a Signal row. The routes call the same handler functions so it would pass, but it is not explicitly asserted.

### Effort and risk

| Dimension | Rating | Justification |
|---|---|---|
| Effort | S (less than 1 day) | Three targeted test-file edits; no production code changes needed |
| Risk | Low | All three gaps are additive; no schema or API surface changes required |

---

## Re-validation Gap Analysis (2026-07-14)

**Context**: Pre-design gap analysis run before `/kiro-spec-design` to confirm current codebase state.

### Findings

The Signal adapter is **fully implemented**. All 56 `tests/signal.test.ts` tests pass. Related suites (`tests/khipu.test.ts`, `tests/sync-all.test.ts`) also pass (110 tests total across the three suites).

Every requirement is satisfied by existing code. The gap between requirements and codebase is **zero**.

The three gaps previously flagged in the 2026-07-13 section (mock missing `fetchAttachmentBuffer`, Signal absent from `query-parity.test.ts` and `surface-e2e.test.ts`) are the only remaining items. These are test-coverage gaps, not production-code gaps.

### Status summary per requirement

| Req | Status |
|---|---|
| 1 — Signal platform registration | DONE (`Platform` union + `PLATFORMS` array + CLI routing) |
| 2 — Beeper Desktop connectivity | DONE (`createBeeperSignalClient`, error wrapping, per-chat isolation) |
| 3 — Chat and message backfill | DONE (`runBackfillImpl`, idempotent via `upsertChat`/`insertMessage`) |
| 4 — Incremental sync | DONE (`runIncrementalImpl` with `getLastSyncedId` branch logic) |
| 5 — Message content and metadata | DONE (`mapMessage` with all required fields; `media_*` null in text path) |
| 6 — Query parity via existing surfaces | DONE (no changes to MCP/CLI/Web; existing handlers return Signal data) |
| 7 — Graceful degradation | DONE (Beeper error wrapping, per-chat try/catch, `process.exit(1)` on missing token) |

### Recommendation

Run `/kiro-validate-impl signal-platform` for full integration validation, then close the spec.
