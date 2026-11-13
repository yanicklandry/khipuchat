# Implementation Plan

> Upstream prerequisites (binding per `.kiro/specs/phase5-cross-spec-decisions.md`):
> - message-events: `runIngest` in `src/ingest-context.ts` (task 1.3), the schema registry `src/schema-registry.ts` called once by `initDb` (D6), the `runAdapterCycle` last-sync write on an ok daemon cycle (D1), and the IngestContext nesting invariant that names Slack and rolls inner stats into the outer scope (D11).
> - cloud-deployment: `resolveDbPath` (task 1.1) and the secret-file allowlist in `src/secret-files.ts` that already lists `SLACK_USER_TOKEN`, `SLACK_COOKIE`, and `^SLACK_(TOKEN|COOKIE)_[A-Z0-9_]+$` (task 1.4, D2).
> - Tasks 1.4 and 1.5 need the schema registry; 5.4, 7.2, and 8.2 need the other items. Every other task, including 4.3 and 5.1, uses an injected historical-scope wrapper and runs without them. Slack never writes the platform last-sync time (D1).

- [ ] 1. Foundation: shared types, primitives, and persistence
- [ ] 1.1 Define Slack wire types, timestamp helpers, and secret redaction
  - Declare the conversation, message (thread fields, bot fields), identity, failure union, result, and message batch types used by every Slack module
  - Provide timestamp comparison and max helpers that compare seconds then fraction without float loss, plus conversion to epoch seconds
  - Provide a redaction helper that masks exact secret values and any `xox?-` token pattern
  - Unit tests prove ordering of close timestamps and that redacted text contains neither a sample token nor a sample cookie
  - _Requirements: 10.1_

- [ ] 1.2 Parse credentials, fingerprint them, and classify Slack error codes
  - Session backend for `xoxc-` tokens requiring a cookie, app backend for `xoxp-` tokens, misconfiguration results for missing token, missing cookie, and unsupported prefixes, with messages that never echo the secret
  - Cookie normalization (trim, strip `d=`, URL-encode only when not already encoded) and a short non-reversible fingerprint
  - Error code classification into auth, restricted, conversation, and other per the design table
  - Unit tests cover every prefix case, cookie forms, fingerprint stability, and every listed error code
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.2, 3.3, 10.2_

- [ ] 1.3 Resolve per-account Slack settings with defaults and warnings
  - Account field wins over environment, environment wins over default, for watch and exclude lists, watch-DMs flag, tier intervals, windows, limits, budgets, history depth, degraded threshold, and optional workspace ID
  - Watch and exclude entries normalized (IDs kept, names lowercased without `#`)
  - Invalid or non-positive numbers fall back to the default and produce a warning naming the setting
  - Unit tests show precedence, normalization, and the warning text for an invalid interval
  - _Requirements: 1.6, 6.6, 6.7_

- [ ] 1.4 Build the generic account health store
  - Define the account health table in a DDL-only schema module (`src/account-health-schema.ts`, `applyAccountHealthSchema`) registered with one import and one entry in message-events' schema registry; no lazy schema creation on first use
  - Store the changed and checked times as unix seconds
  - Record reports in one transaction, bump the global sequence only when status or reason changes, always update the checked time
  - Read one account's record and list records filtered by sequence, platform, and status in ascending sequence order
  - The module imports no Slack code and caps detail text length
  - Persist the credential fingerprint and detail on every report without bumping the sequence
  - Unit tests on an in-memory archive prove sequence monotonicity across two accounts, no sequence change on repeated identical reports or on a fingerprint-only change, times stored in seconds, the table present after archive open through the registry, and correct filtering
  - _Requirements: 3.1, 3.7, 3.8_
  - _Depends: message-events schema registry (D6)_

- [ ] 1.5 Build the Slack state store
  - Define the Slack account identity, per-conversation state, and thread tables in a DDL-only schema module (`src/platforms/slack/schema.ts`, `applySlackSchema`) registered with one import and one entry in message-events' schema registry; the state store itself holds no DDL and creates nothing lazily
  - Label millisecond columns (`verified_at`, `last_polled_at`) as epoch ms and the thread activity column as unix seconds in the schema
  - Provide identity save and lookup by workspace ID, conversation upsert, cursor advance that never moves backwards, polled marker, history import progress, membership marking, history import reset, thread upsert, and active thread listing ordered by recent activity with a limit
  - Unit tests on an in-memory archive show the tables exist after archive open, the schema module imports only types, cursors never regress, membership marking flags vanished conversations, and active thread listing respects window and limit
  - _Requirements: 1.6, 4.7, 5.2, 7.1, 7.2_
  - _Depends: message-events schema registry (D6)_

- [ ] 1.6 Let adapters supply their default daemon interval
  - Add the optional poll interval field to the platform adapter contract
  - The daemon interval selection uses the platform environment override first, then the adapter's value, then the existing default
  - Unit tests show the env override wins, the adapter value applies when env is unset, and other platforms keep the 5 minute default
  - _Requirements: 6.9_

- [ ] 2. Slack API access
- [ ] 2.1 (P) Implement the per-method rate limiter
  - Token buckets per Slack method at about 80 percent of the published tier limits, scoped to one adapter instance
  - Deadline-aware acquire that returns immediately with a deadline result instead of waiting past the cycle budget, and penalties from Retry-After
  - Unit tests with a fake clock show spacing at the configured rate, deadline refusal, and penalty blocking
  - _Requirements: 9.1, 9.2_
  - _Boundary: RateLimiter_

- [ ] 2.2 Implement the classified transport for both backends
  - Session requests are form-encoded POST bodies carrying the token plus the session cookie header; app requests carry the bearer header; no token ever appears in a URL
  - Rate-limited responses penalize the method and wait within the deadline or return a rate-limited failure; network errors and server errors retry three times with increasing delays then return a transient failure
  - Slack error bodies are mapped through the classifier; every failure detail passes through redaction
  - Integration tests with an injected fetch assert request shapes per backend, Retry-After inside and outside the budget, retry exhaustion, and absence of secrets in failures
  - _Requirements: 1.1, 1.2, 9.1, 9.2, 9.3, 10.1_
  - _Depends: 1.1, 1.2_

- [ ] 2.3 Replace the Slack client with method-level operations over the transport
  - Identity check, members-only conversation listing across all four types excluding archived (with workspace ID when configured), single conversation info, windowed history with optional page cap returning ascending deduplicated batches with a completeness flag, thread replies after a given reply, and cached user names falling back to the user ID
  - Keep a thin compatibility layer inside the client module (the old generator-style listing and history methods built on the new operations) so the Slack sync module and its tests stay untouched and green until 5.3 removes the layer
  - Integration tests against a fake API prove pagination, partial batches on deadline, members-only listing, and the name fallback
  - _Requirements: 1.5, 4.1, 4.4, 8.4, 8.7_

- [ ] 3. Pure decision logic
- [ ] 3.1 (P) Fix conversation and message mapping
  - Move mapping into its own module and keep the existing exports available from the Slack sync module through re-exports (the only edit to the sync module in this task)
  - Channels map to `channel`, direct messages to `private`, group direct messages to `group`; DM chats take the resolved display name
  - Messages by the signed-in user are marked as sent by the user; thread replies link to their parent; bot messages take the bot name; content subtypes store as text and system subtypes as `other`
  - Unit tests cover each chat type, the sender flag, parent links, bot names, and each subtype class
  - _Requirements: 5.1, 8.1, 8.2, 8.3, 8.5, 8.6_
  - _Boundary: SlackMapping_

- [ ] 3.2 (P) Implement tier classification and cycle planning
  - Watched by ID or normalized name, or recent DMs when watch-DMs is on; exclude wins over watch; active by activity window; idle otherwise
  - Due rules per tier interval, watched first then most overdue, separate lists for uninitialized conversations and pending history import, non-members only when watched by ID, every non-excluded conversation due in one-shot mode
  - Unit tests cover each tier rule, ordering, one-shot planning, and non-member handling
  - _Requirements: 4.3, 4.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.8, 6.11, 7.3_
  - _Boundary: PollScheduler_

- [ ] 3.3 (P) Implement the health policy rules
  - Cycle gate: validate on credential fingerprint change, skip while needs re-auth or restricted until the re-check interval elapses, validate when the identity check is stale
  - Failure to state mapping returning nothing for rate-limit, deadline, transient, conversation, and other failures
  - Throttle tracker that counts consecutive app-backend cycles where every history read was rate limited and reports degraded at the threshold, back to healthy after a clean cycle
  - Unit tests cover every gate branch, each failure kind, and the degraded round trip
  - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.10, 3.11_
  - _Boundary: HealthPolicy_

- [ ] 4. Conversation, thread, and channel services
- [ ] 4.1 (P) Implement the cached conversation directory
  - Refresh on first use and then once per refresh interval, keeping the previous list when a refresh fails
  - Add watched conversation IDs outside membership through conversation info, log unmatched watch or exclude entries once per refresh, mark vanished conversations as non-members
  - Upsert chats (correcting stored types), resolve DM names only when unknown, and initialize read positions from the newest stored message for chats synced by an earlier version
  - Integration tests in a dedicated conversation directory test file on an in-memory archive show cache reuse, the once-per-refresh warning, the type correction from `user` to `channel`, and continuation without re-import
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 7.5, 8.2, 8.4_
  - _Boundary: ConversationDirectory_

- [ ] 4.2 (P) Implement thread reply synchronization
  - Record every parent with replies, fetch replies when Slack's latest reply moved past the newest stored reply, and advance the stored reply position after storing
  - Re-check up to the configured number of most recently active threads within the thread window, skipping threads already handled in the same poll, and reactivate a thread when its parent shows new activity
  - Per-thread failures are collected for retry; auth, restriction, rate-limit, and deadline failures stop the poll
  - Integration tests show replies linked to parents, a reply to an earlier-cycle parent captured, a broadcast reply stored once, the re-check cap, idle threads skipped, and one failing thread not blocking others
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7_
  - _Boundary: ThreadSync_

- [ ] 4.3 Implement incremental reads and chunked history import per conversation
  - Incremental read after the stored position, store messages in ascending order, run thread sync, then advance the position only when the read completed
  - First-page initialization and capped older-page history import, both inside the historical scope wrapper, marking import done at the end of history or past the configured depth, with thread replies fetched inside the same scope
  - Mark conversations polled on success, partial, and skipped outcomes; skip denied conversations with a once-per-refresh log; return a stop outcome on auth or restriction
  - The historical scope is an injected wrapper; this task does not import the event stream
  - Integration tests prove no gap after a partial read, no duplicates on re-read, depth limit honored, and that the injected historical wrapper is invoked for initialization and import but not for incremental reads
  - _Requirements: 1.5, 4.6, 5.5, 7.1, 7.2, 7.3, 7.4, 7.7, 9.3, 9.4_

- [ ] 5. Cycle orchestration and adapter
- [ ] 5.1 Implement the cycle gate, identity check, and health recording
  - Parse credentials and record misconfiguration without contacting Slack, logging it once while unchanged
  - Apply the cycle gate; run the identity check when due, store the identity, and record healthy, needs re-auth, or restricted health
  - Log one line per health transition with the re-auth command, and a recovery line when an account returns to healthy
  - Integration tests with a fake API show a misconfigured account sends no request, an `invalid_auth` identity check sets needs re-auth and logs once, the re-check interval is honored, and new credentials trigger validation
  - _Requirements: 1.3, 1.4, 1.7, 3.4, 3.5, 3.6, 3.9_

- [ ] 5.2 Implement cycle execution within the budget
  - Reset history import when the force option is set, refresh the directory, plan, then execute poll, initialization, and history import work within the cycle budget (no budget in one-shot mode)
  - Abort on a stop outcome and record the resulting health; record healthy or degraded through the throttle tracker
  - Embed touched chats when indexing is on and log the per-cycle summary; the cycle never writes the platform last-synced time (message-events owns it, D1)
  - Integration tests show watched work runs before idle work, work beyond the budget is deferred, an auth failure mid-cycle stops reads, the forced reset re-reads history, the degraded round trip, and no platform last-synced write from the cycle
  - _Requirements: 3.11, 6.8, 7.3, 7.6, 9.5_

- [ ] 5.3 Rebuild the Slack adapter on the cycle
  - Adapter factory with daemon and one-shot modes, the force option passed to the cycle, the adapter-owned overlap guard that skips and logs, and the adapter poll interval set to the watched interval
  - One-shot entry passes mode and force from the sync arguments; misconfiguration and auth failures throw so the command exits non-zero
  - Remove the old backfill and incremental functions, the client compatibility layer from 2.3, and every process exit; update the existing Slack tests to the new contract
  - Daemon-mode adapter calls resolve after every cycle report so message-events records the last sync time on the ok outcome (D1); the adapter never writes it
  - Tests show the daemon never exits on a Slack error, daemon calls resolve on auth failure and skips, the overlap guard, the forced re-read updating the sent-by-me flag without duplicates, and the one-shot non-zero exit
  - _Requirements: 1.7, 1.8, 6.9, 6.10, 6.11, 7.6, 7.8, 9.5_
  - _Depends: 3.1_

- [ ] 5.4 Connect the adapter to the event stream scope and the shared archive path
  - The default historical wrapper runs work inside `runIngest('backfill')`, returning the result and rethrowing failures; the one-shot entry opens the archive through the resolved DB path
  - The wrapper nests inside the daemon's outer scope from `runAdapterCycle`; Slack is an accepted message-events nesting caller and inner stats roll up into the outer scope (D11)
  - Through the real daemon wiring, an ok Slack cycle leads `runAdapterCycle` to record the account's last sync time (D1)
  - Tests show the default wrapper returns the inner result and propagates an inner error, inner backfill events appear in the outer scope's stats, the last sync time is recorded by the daemon wiring after a Slack cycle, and the one-shot entry honors the configured archive path
  - _Requirements: 4.6, 7.4, 7.8_
  - _Depends: cloud-deployment 1.1, message-events 1.3, message-events runAdapterCycle last-sync write (D1), message-events nesting invariant (D11)_

- [ ] 6. Credential capture and status commands
- [ ] 6.1 (P) Write the login guide and terminal prompts
  - Risk notice covering unofficial access, terms of use, sign-out and unusual-access invalidation, datacenter IP risk, and Enterprise Grid rotation
  - Browser steps with the console snippet that copies every signed-in workspace and its token, and the steps to copy the session cookie
  - Injectable terminal IO with visible questions and non-echoed secret input
  - Tests in a dedicated login guide test file assert every notice item and the snippet appear, and that secret input is not echoed by the terminal IO
  - _Requirements: 2.1, 2.2, 2.3_
  - _Boundary: LoginGuide, LoginPrompt_

- [ ] 6.2 (P) Implement the credential writer
  - Account naming from an existing account, the workspace URL subdomain, or a de-duplicated slug; per-account variable names
  - Write plans for an existing config file (upsert entries by name, keep other fields and platforms, temp file then rename), no config file with one workspace (legacy variables), several workspaces without config (per-account variables plus printed entries and the file-mode note), and print-only (no writes, secrets warning on standard error)
  - Environment file upsert keeps unrelated lines and sets owner-only permissions
  - Tests in the credential writer test file (owned by this task) on a temp directory cover each plan kind, preservation of other config content, and file permissions
  - _Requirements: 2.6, 2.7, 2.8, 2.9, 2.10_
  - _Boundary: CredentialWriter_

- [ ] 6.3 (P) Implement desktop token discovery on macOS
  - Locate the direct-download and App Store Slack data directories and scan the local storage files for session tokens, deduplicated
  - Report unsupported host, not installed, and no tokens found as distinct failures
  - Tests in a desktop tokens test file with fixture files containing tokens, a missing directory, and a non-macOS platform value
  - _Requirements: 2.12, 2.13, 2.14_
  - _Boundary: DesktopTokens_

- [ ] 6.4 (P) Implement desktop session cookie decryption on macOS
  - Copy the cookie database to a temporary directory, read the session cookie for the Slack domain, obtain the Safe Storage password through an injected keychain reader, decrypt with the Chromium scheme including the newer host-hash prefix, and remove the temporary copy
  - Report keychain denial and unreadable data as distinct failures
  - Tests in a desktop cookie test file build a fixture cookie database encrypted with a known password for both database versions and assert the decrypted value, plus the denial path
  - _Requirements: 2.12, 2.13_
  - _Boundary: DesktopCookie_

- [ ] 6.5 Implement the login flow
  - Show the notice, try desktop import when requested and fall back to manual steps on any failure, otherwise print manual steps and read the pasted workspace list or single token and the cookie through secret input
  - Validate every candidate with the identity check, show the result table, exclude failures, confirm, match existing accounts by workspace ID or the account option, then apply the write plan
  - After a successful write, save identity and record healthy health with the new fingerprint; print mode records nothing
  - Tests with fake IO and a fake API cover a mixed valid and invalid paste, re-auth of an existing account, desktop fallback, print mode, and health set to healthy
  - _Requirements: 2.3, 2.4, 2.5, 2.7, 2.11, 2.12, 2.13, 2.14_

- [ ] 6.6 Implement `khipu slack status` and the Slack command router
  - Collect each configured account's workspace, backend, health (or not yet checked), last sync time, conversations per tier, and history import progress, and render without secrets (fingerprint only with verbose)
  - Route `login` with its options and `status`, with help and error results for unknown input
  - Tests render a status table for a healthy, a needs re-auth, and an unchecked account and parse every supported argument form
  - _Requirements: 11.1_

- [ ] 7. Integration with shared surfaces
- [ ] 7.1 Wire the Slack command into the CLI and show health in sync status
  - Add the `slack` operational command and usage lines to the khipu router
  - Extend the sync status output with each account's health state, showing not yet checked for Slack accounts without a record
  - Tests show `khipu slack status` resolves to the Slack command script and the sync status lines include health
  - _Requirements: 11.2, 11.3_
  - _Depends: 1.4, 6.6_

- [ ] 7.2 Verify Slack secrets can be supplied as files
  - Verification only: cloud-deployment owns the secret-file allowlist and already lists `SLACK_USER_TOKEN`, `SLACK_COOKIE`, and the per-account `SLACK_(TOKEN|COOKIE)_*` pattern (D2); this task does not edit `src/secret-files.ts`
  - Tests show `SLACK_USER_TOKEN_FILE`, `SLACK_COOKIE_FILE`, and `SLACK_TOKEN_ACME_FILE` resolve while an unrelated Slack name is ignored; a failure is reported to cloud-deployment rather than fixed here
  - _Requirements: 10.3_
  - _Depends: cloud-deployment 1.4_

- [ ] 7.3 Update Slack setup catalog and documentation
  - Session token as the default and the app token as the alternative in the setup-env catalog, a new session cookie row, regenerated token docs, and a Slack guide covering capture, multi-workspace configuration, watch settings, risks, and re-auth
  - A test asserts the generated token docs match the catalog output and that the Slack guide mentions each risk item
  - _Requirements: 10.4_

- [ ] 8. Validation
- [ ] 8.1 End-to-end daemon scenario against a fake Slack API
  - Two accounts (session and app) over several simulated cycles: history import spread over cycles while a watched channel keeps its 60 second cadence, thread replies arriving later, a restart resuming from stored positions, one account failing auth and recovering after new credentials while the other keeps syncing, and a misconfigured third account isolated
  - Passing test demonstrates watched messages stored within two cycles of being posted and no duplicates across the run
  - _Requirements: 1.1, 1.2, 1.7, 3.2, 3.5, 3.6, 5.2, 6.1, 7.1, 7.3, 9.5_

- [ ] 8.2 Verify historical versus new message marking with the event stream
  - With message-events present, a first sync and a newly discovered conversation produce historical events only, while new messages in an established conversation produce new-message events
  - Passing test asserts event origins per message
  - _Requirements: 4.6, 5.5, 7.4_
  - _Depends: 5.4_

- [ ] 8.3 Boundary and secret hygiene checks
  - Static test that Slack modules and the account health store import no Beeper module, no event store or event bus module, and no notifier module; the two schema modules import only types; no Slack module calls the platform last-synced writer
  - A full fake cycle with captured logs, health rows, and status output contains neither the token nor the cookie
  - _Requirements: 3.12, 10.1, 10.5_
