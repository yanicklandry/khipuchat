# Research & Design Decisions: notifier

## Summary
- **Feature**: `notifier`
- **Discovery Scope**: New Feature (greenfield module tree) with Complex Integration (three external push services, the ingress auth contract, four upstream specs).
- **Key Findings**:
  - All three channels can be driven by plain `fetch` with small JSON or form bodies. ntfy offers up to 3 action buttons including `http` actions that the phone app sends directly; Pushover offers one supplementary URL plus emergency priority 2 with a receipt that can be polled (no public callback needed); Telegram inline keyboards deliver `callback_query` updates that can be read by long-polling `getUpdates` (no public endpoint needed).
  - Button links opened from ntfy and Pushover are made by the phone or a browser with no way to add our ingress bearer token (Pushover cannot carry headers at all; ntfy could, but that would place a long-lived ingress token inside every notification payload stored by the ntfy server). cloud-deployment's ingress authenticates every request before routing and rejects query-string tokens, so a path-carried, signed, short-lived capability is needed, and the ingress must learn to verify it. (Originally proposed here as upstream change UC-1; superseded by cross-spec decision D3: cloud-deployment owns "Signed capability paths" as its own requirement, and the notifier only references it.)
  - The verdict feed (triage-agent) and account health store (slack-all-workspaces) are both pull APIs with consumer-held positions; the notifier only needs a small key-value table for its health position and Telegram update offset. The approval hand-off mirrors the verdict feed shape so action-runner can reuse the same consumer loop.

## Research Log

### ntfy publishing and action buttons
- **Context**: Primary hub channel; laptop and phone topics; buttons must call back into khipuchat.
- **Sources Consulted**: https://docs.ntfy.sh/publish/ (sections "Publish as JSON", "Action buttons", "Message priority", "Authentication", "Message caching", "Disable Firebase"), https://docs.ntfy.sh/config/ ("iOS instant notifications", "Rate limiting").
- **Findings**:
  - JSON publish: `POST` (or `PUT`) to the server root URL (not the topic URL) with body fields `topic` (required), `message`, `title`, `tags`, `priority` (1..5), `actions`, `click`, `attach`, `markdown`, `icon`, `filename`, `delay`, `email`, `call`, `sequence_id`.
  - Priority: 5 `max`/`urgent`, 4 `high`, 3 `default`, 2 `low`, 1 `min`.
  - Actions: "up to three user actions" per notification. Types `view` (open URL), `broadcast` (Android only), `http` (request sent by the subscriber app), `copy`. `http` fields: `action`, `label`, `url`, `method` (default `POST`), `headers`, `body`, `clear` (cleared only if the request succeeds).
  - Messages over 4096 bytes are converted to attachments; we cap bodies far below that.
  - Auth: `Authorization: Bearer <access token>` or Basic; an `auth` query parameter also exists (not used).
  - `X-Cache: no` stops server-side caching (subscribers connected at publish time still receive it); `X-Firebase: no` stops Firebase forwarding (Android delay risk).
  - iOS with a self-hosted server: `upstream-base-url` makes the server publish only a poll request (message id in `X-Poll-ID`, topic hashed with SHA-256) to ntfy.sh; message text stays on the self-hosted server.
  - Rate limiting default on a server: visitor bucket of 60 requests refilled one per 5 s; HTTP 429 when hit.
- **Implications**: `NtfyAdapter` posts JSON to the root with `topic`, `title`, `message`, `priority`, `tags`, `click`, `actions`. Open uses a `view` action and `click`; Do it and Not important use `http` actions with `method: 'POST'`, no headers, `clear: true`. The response JSON `id` is the channel reference. 429 is transient. Target option `cache: false` sends `X-Cache: no`. Whether every action type renders on iOS is not stated on the publish page: to verify on device during implementation; the design does not depend on `broadcast`.

### Pushover messages, emergency priority, receipts
- **Context**: Critical alerts must break through iOS Do Not Disturb with acknowledgment.
- **Sources Consulted**: https://pushover.net/api, https://pushover.net/api/receipts.
- **Findings**:
  - `POST https://api.pushover.net/1/messages.json`; required `token`, `user`, `message`; optional `title`, `url`, `url_title`, `priority`, `sound`, `html`, `timestamp`, `ttl`, `device`, and for emergency `retry`, `expire`, `callback`, `tags`.
  - Limits: message 1024 characters, title 250, url 512, url_title 100.
  - Priority: -2 no notification, -1 quiet, 0 normal (sent as -1 during the user's Pushover quiet hours), 1 high (bypasses the user's quiet hours), 2 emergency (repeated until acknowledged). `retry` at least 30 s; `expire` at most 10800 s; retries capped at 50. A `receipt` is returned for priority 2.
  - Receipts: `GET https://api.pushover.net/1/receipts/<receipt>.json?token=<app token>`, "no faster than once every 5 seconds"; fields `status`, `acknowledged`, `acknowledged_at`, `acknowledged_by`, `acknowledged_by_device`, `last_delivered_at`, `expired`, `expires_at`, `called_back`, `called_back_at`.
  - Cancel: `POST https://api.pushover.net/1/receipts/<receipt>/cancel.json` with `token`; also `cancel_by_tag`.
  - Callback: optional public URL; Pushover POSTs `receipt`, `acknowledged`, `acknowledged_at`, `acknowledged_by`, `acknowledged_by_device`.
  - Responses: 200 with `status: 1` accepted; 4xx means invalid input and must not be retried; 429 when the monthly limit (10 000 free) is reached; 5xx or no reply: retry no sooner than 5 s. `X-Limit-App-Remaining` header shows remaining monthly messages. At most 2 concurrent connections; repeated 4xx can trigger a temporary IP block.
  - The API page does not itself state that priority 2 bypasses iOS Do Not Disturb; that behavior comes from the Pushover iOS app's Critical Alerts permission, enabled by the user on the device.
- **Implications**: Critical uses `priority=2`, `retry` (default 60, min 30), `expire` (default 1800, max 10800), `tags=khipu-n<id>`. Acknowledgment is tracked by polling receipts every 30 s (well above the 5 s floor) instead of the `callback` parameter, so no unauthenticated ingress route is needed. When the user answers through another button, the receipt is cancelled. 429 from Pushover is treated as a permanent failure for this attempt (monthly quota) so the route falls through to the next target; 5xx and network errors are transient with a minimum 5 s delay. The docs must tell the user to allow Critical Alerts in the Pushover iOS app. The supplementary URL is the response page (menu) when callbacks are available, else the Open link.

### Telegram bot inline keyboards and callback queries
- **Context**: Fallback channel with buttons, using a bot separate from the MTProto sync session.
- **Sources Consulted**: https://core.telegram.org/bots/api (sections "getUpdates", "setWebhook", "Making requests", "sendMessage", "InlineKeyboardButton", "CallbackQuery", "ResponseParameters").
- **Findings**:
  - `sendMessage`: `chat_id`, `text` (1..4096 characters after entity parsing), `parse_mode` (optional), `reply_markup` (InlineKeyboardMarkup), `disable_notification`, `link_preview_options`.
  - `InlineKeyboardButton`: `text`, optional `url`, optional `callback_data` "1-64 bytes".
  - `CallbackQuery`: `id`, `from`, optional `message`, `chat_instance`, `data`. "Telegram clients will display a progress bar until you call answerCallbackQuery."
  - `getUpdates`: `offset` (highest seen update id + 1), `limit` 1..100, `timeout` (long poll seconds), `allowed_updates`; does not work while a webhook is set; updates are kept at most 24 hours.
  - `setWebhook` `secret_token` arrives as header `X-Telegram-Bot-Api-Secret-Token` (chars `A-Za-z0-9_-`, 1..256): would fit the ingress `tokenHeader` mechanism, but is not needed with long polling.
  - Errors: `ok: false`, `description`, `error_code`, optional `parameters.retry_after` on flood control (429).
  - `answerCallbackQuery` and `editMessageReplyMarkup` exist with `callback_query_id`/`text` and `chat_id`/`message_id`/`reply_markup` respectively (well known; the fetched excerpts truncated before their parameter tables; verify exact names during implementation).
- **Implications**: `TelegramAdapter` sends plain text (no `parse_mode`, avoiding escaping bugs) with an inline keyboard: Open as a `url` button, Do it and Not important as `callback_data` `n1.<nonce>.<a>` (nonce 22 base64url chars, total 27 bytes). A long-poll loop (`timeout=25`, `allowed_updates=["callback_query"]`) runs in the notifier runtime and stores the offset. Presses are accepted only when `from.id` is in the configured allowed user ids and `message.chat.id` equals the target chat. A 409 from `getUpdates` (webhook set) is logged once with guidance. `retry_after` is honored.

### Ingress authentication versus button links (upstream contract)
- **Context**: Buttons in ntfy and the Pushover link need to reach `/v1/notify/...` without a bearer header.
- **Sources Consulted**: `.kiro/specs/cloud-deployment/design.md` (IngressAuth, Ingress Contracts, Revalidation Triggers, SecretFileLoader).
- **Findings**:
  - Auth runs before routing and before body parsing; credentials accepted: `Authorization: Bearer`, Basic password, or a module `tokenHeader`. Query tokens (`token`, `access_token`, `key`) are ignored and logged as `query-token`. Unknown paths return 401 to unauthenticated callers.
  - Modules "never implement their own authentication". Changes to `IngressModule`, credential sources, or token naming are revalidation triggers for presence-context and notifier.
  - The secret allowlist is fixed (`DB_KEY`, `INGRESS_TOKEN`, ... plus `INGRESS_TOKEN_<ID>`); changes are a revalidation trigger for the environment template and guide.
  - The auth rejection log line includes the request path.
- **Implications** (superseded by cross-spec decisions D3 and D2): the two upstream changes first proposed here (UC-1 capability path credential, UC-2 secret allowlist additions) are now owned by cloud-deployment as its "Signed capability paths" requirement (D3) and its up-front `_FILE` allowlist (D2); the notifier references both as upstream contracts and edits no cloud-deployment file. When `INGRESS_SIGNING_KEY` is absent (capability auth off upstream) the notifier degrades: ntfy and Pushover carry the Open link only; Telegram buttons are unaffected (Requirement 8.5).

### Upstream contracts reused unchanged
- **triage-agent**: `registerVerdictConsumer('notifier', { startFrom: 'now' })`, `readVerdicts`, `ackVerdicts`, `getVerdictConsumerStatus`, `VerdictRecord` (`decision_id`, `created_at`, `verdict`, `source` with `platform`, `account`, `chat_id`, `chat_name`, `chat_type`, `sender_name`, `message_timestamp`, `excerpt`), `recordFeedback({ decisionId, value: 'not_important', source: 'notifier' })`. outbox and feedback are importable from the ingress process (their isolation rule).
- **presence-context**: `getPresence(db)` returns the raw `PresenceSnapshot`; notifier may use the raw snapshot (no LLM involved). `together: boolean | 'unknown'`; `local_time.timezone` gives the user's zone. Throws `PresenceConfigError`.
- **slack-all-workspaces**: `listAccountHealth(db, { afterSeq })` ascending `seq`; consumer stores the highest seq; non-ok status means problem, later ok means resolved; `detail` is short human text without secrets; Slack logs the remedy command. `createSlackStateStore(db).getIdentity(account)` returns team id and team URL used for Slack permalinks.
- **message-events**: consumer naming pattern (`CONSUMER_NAME_PATTERN`) and register/read/ack semantics mirrored by the approval feed.

### Codebase observations
- `src/watch.ts` is the only process that hosts consumers (triage runtime started there); `src/khipu.ts` maps subcommands to scripts. Slack stores channel id as `chats.external_id` and message `ts` as `messages.external_id`, so a Slack permalink is `<team_url>archives/<channel>/p<ts without dot>`.
- slack-all-workspaces precedent (superseded by cross-spec decision D6): module-owned tables were created by the owning module on first use. The notifier instead defines its tables in the DDL-only `src/notify/schema.ts` registered once in `SCHEMA_MODULES` (`src/schema-registry.ts`), which `initDb` applies, so all three processes (daemon, ingress, CLI) and action-runner see them; no lazy `ensure*Schema`.
- Repo-wide `tsc` typecheck is broken (pre-existing); tasks use filtered `tsc --noEmit` output as in triage-agent.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Durable notification table plus dispatcher (selected) | Intakes write rows; one dispatcher in the daemon gates, routes, sends; callbacks update rows | Crash-safe, cross-process requests, one place for policy, full audit | Polling latency (seconds) | Mirrors message-events / triage outbox style |
| Send inline in the verdict loop | Read verdict, send, ack | Simplest | Retries and quiet hours block the feed; no cross-process requests | Rejected |
| Separate `khipu notify run` process | Dedicated service | Isolation | Extra compose service, duplicate lifecycle | Rejected; daemon already hosts consumers |
| Ingress-only header auth for ntfy buttons | Put `INGRESS_TOKEN_NOTIFY` in ntfy `http` action headers | No upstream change | Long-lived token stored in every ntfy message on a third-party server; impossible for Pushover links | Rejected as the primary path |

## Design Decisions

### Decision: Capability path credential in the ingress (former UC-1, superseded by D3)
> Superseded by cross-spec decision D3: this mechanism is owned, specified, and implemented by cloud-deployment ("Signed capability paths"). The notes below record the original reasoning only; the notifier keeps single use, one action per notification, and hash storage on the DB side.
- **Context**: Links opened by the ntfy app or a browser cannot carry the bearer token; query tokens are rejected by design; auth must run before routing.
- **Alternatives Considered**:
  1. Module-level auth bypass (module authenticates itself): violates "modules never implement their own authentication" and moves auth after routing.
  2. Bearer header inside ntfy actions: leaks a long-lived token; does not work for Pushover.
  3. Ingress-verified signed capability in the path, module-enforced single use (selected).
- **Selected Approach**: A module may declare `capabilityPaths: { prefix: '/a', methods: ['GET', 'POST'] }`. For `/v1/<id>/a/<cap>[/...]` the ingress verifies `<cap> = <payload>.<exp>.<sig>` with HMAC-SHA256 under a per-module key derived from `INGRESS_SIGNING_KEY`, rejects expired or invalid ones with the usual 401 before routing and body parsing, redacts the segment in logs, and exposes the verified payload to the handler. The notifier stores only a hash of the random payload and enforces single use, binding, and action validity.
- **Rationale**: Keeps authentication owned and executed by the ingress, stateless and cheap; the module keeps the stateful part it owns (single use).
- **Trade-offs**: The URL appears in reverse-proxy access logs (bounded by single use and short lifetime).
- **Follow-up**: Resolved by D3 (cloud-deployment owns it); the notifier re-checks only when that contract changes.

### Decision: Telegram via long polling, Pushover acknowledgment via receipt polling
- **Context**: Avoid additional internet-facing routes and unauthenticated callbacks.
- **Selected Approach**: `getUpdates` long poll in the daemon; Pushover receipts polled every 30 s while open.
- **Rationale**: Works on a laptop without a public ingress; no extra ingress credentials; fewer moving parts.
- **Trade-offs**: One extra long-lived HTTP request; receipt acknowledgment recorded within 30 to 60 s rather than instantly (meets Requirement 7.9).

### Decision: One generic "deferral bucket" for quiet hours, burst, and hourly limit (generalization)
- **Context**: Requirements 5.4, 6.2, 6.3 are three variations of "hold some notifications and release them as one summary later".
- **Selected Approach**: A deferred row carries `bucket` (`quiet`, `burst:<collapse key>`, `rate`) and `release_at`; one releaser turns each due bucket into either the single original (quiet with one member) or one summary row.
- **Rationale**: One code path and one test matrix for all three.

### Decision: Approval hand-off as a feed plus a single offer seam
- **Context**: action-runner is a later spec; "Do it" must not appear for actions nothing will run.
- **Selected Approach**: `notify_approvals` table with a register/read/ack feed identical in shape to the verdict feed, and `defaultApprovalOffer()` as a permanent EMPTY default ("offer nothing") that no other spec edits. action-runner's real offer is injected (cross-spec decisions D7, D12, D14): `composeSharedWiring(env)` in `src/daemon-wiring.ts` sets `DaemonSharedWiring.approvalOffer`, the daemon reaches it through `notifierService({ env, mode, shared })` reading `shared.approvalOffer`, and the CLI through `src/cli-entries/notify-cli.ts` calling `runNotifyCli(argv, { offer: shared.approvalOffer })`. (The earlier "until action-runner edits its body" seam-edit wording is superseded by D7.)
- **Rationale**: No speculative executor coupling; action-runner reuses its verdict loop code.

### Decision: Build, not adopt
- **Context**: Steering forbids new runtime dependencies where `fetch` suffices; the brief says no SDKs.
- **Selected Approach**: Three small adapters over a shared `HttpPort` with timeout and failure classification. Apprise, node-pushover, node-telegram-bot-api, and ntfy client libraries rejected (dependency weight, no added value for three JSON calls).

### Decision: Simplifications
- One delivery per notification (first accepting target), no fan-out.
- No ntfy `sequence_id` updates (would let summaries replace earlier notifications; noted as a later improvement).
- No Telegram webhook mode; no Pushover `callback` mode.
- Tables defined in the DDL-only `src/notify/schema.ts` and registered in `SCHEMA_MODULES` (D6, superseding the earlier lazy-creation note), `db.ts` untouched.

## Risks & Mitigations
- Signed capability paths unavailable (cloud-deployment D3 contract not configured: `INGRESS_SIGNING_KEY` absent or invalid per `readSigningKey(env)`, or `public_base_url` unset): notifier still ships with Open-only links on ntfy and Pushover and full Telegram buttons; status shows `callbacks: disabled (<reason>)`. (Replaces the earlier "UC-1 not accepted" risk, superseded by D3.)
- Callback URL leaks through proxy logs or a shared screenshot: single use, 24 h default lifetime, mutual exclusivity per notification, `Referrer-Policy: no-referrer` on the response page, and approvals are re-validated by action-runner before anything runs.
- Pushover monthly quota exhaustion (429): treated as permanent for that attempt so the route falls through; `X-Limit-App-Remaining` below 100 logs a warning once per day.
- ntfy public server visibility of topics: docs recommend a self-hosted server or long random topic names plus access tokens; `cache: false` target option.
- Telegram webhook already set on the bot: `getUpdates` returns 409; logged once with the `deleteWebhook` remedy; sending still works.
- Burst of critical alerts: burst collapse applies to critical; summaries are high, never emergency.
- Daemon downtime backlog: staleness limit suppresses old verdicts; collapse limits the rest.

## References
- [ntfy: Publishing](https://docs.ntfy.sh/publish/): JSON publish, actions, priorities, auth, caching.
- [ntfy: Configuration](https://docs.ntfy.sh/config/): iOS upstream poll requests, rate limiting.
- [Pushover API](https://pushover.net/api): messages, limits, priorities, response handling.
- [Pushover Receipts API](https://pushover.net/api/receipts): receipt polling, cancel, callback fields.
- [Telegram Bot API](https://core.telegram.org/bots/api): sendMessage, inline keyboards, callback queries, getUpdates, errors.
- `.kiro/specs/cloud-deployment/design.md`, `.kiro/specs/triage-agent/design.md`, `.kiro/specs/presence-context/design.md`, `.kiro/specs/slack-all-workspaces/design.md`, `.kiro/specs/message-events/design.md`.
