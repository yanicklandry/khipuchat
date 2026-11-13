# Requirements Document

## Project Description (Input)
The user belongs to several Slack workspaces and is an admin on only some of them. Important operational messages (for example new transactions in `#08-expedition`, which require a new ADV report) arrive in workspaces where the user cannot install a Slack app. Today khipuchat's Slack sync depends on an installed personal app token (`xoxp-`), polls every conversation at one slow interval, re-lists every conversation each cycle, never fetches thread replies, always stores `is_sender = 0`, stores public and private channels with the wrong chat type, and kills the whole process when the token is missing. Since 2026-03-03 Slack also enforces about 1 request per minute on history reads for non-Marketplace apps, and workspaces with "Require app approval" block `xoxp` entirely for non-admins. The desired outcome: every Slack workspace the user can sign into in a browser syncs into khipuchat, including thread replies, without any admin action, and messages in watched channels land in the archive within about 1 to 2 minutes. The browser session token (`xoxc-` plus the `d` cookie) becomes the documented default with a guided capture flow, token health is checked and persisted so a later notifier can tell the user when re-authentication is needed, and `xoxp` remains an alternative where installable. khipuchat replaces Beeper: the Beeper Slack bridge is never used.

## Introduction
This feature extends the existing Slack sync (slack-sync spec) so that it works on every workspace the user can sign into, keeps watched channels near-realtime, captures threads, and reports credential health in a persisted, queryable form. It covers credential capture, two access backends behind one sync behavior, a per-account health state, conversation discovery with caching, per-conversation poll tiers, thread replies, resumable incremental reads and history import, mapping fixes, rate-limit compliance, secret hygiene, and status visibility. It runs both on the user's Mac and on the cloud server set up by cloud-deployment.

## Boundary Context
- **In scope**: browser session token backend (default) and installed-app token backend (alternative); `khipu slack login` guided capture (manual browser steps, optional macOS Slack desktop import); credential validation; persisted per-account auth health with a read query for other features; thread replies; watch list, exclude list, and poll tiers; conversation list caching; per-conversation read positions and chunked history import; chat type, sender flag, DM naming, and bot sender fixes; rate-limit handling; secret redaction; secret-file names for server deployments; Slack setup documentation; `khipu slack status`; health shown in `khipu sync`; tests against a mocked Slack API.
- **Out of scope**: the Beeper Slack bridge or any Beeper component; sending, replying, or reacting on Slack; file and attachment downloads; message edits and deletions after a message is stored; realtime websocket connection (deferred stretch goal); Enterprise Grid org-wide export; Slack Connect edge cases beyond best effort; deciding which messages are important (triage-agent); creating or delivering notifications, including the re-auth alert (notifier); the new-message event stream and its tables (message-events).
- **Adjacent expectations**:
  - message-events records new-message events when messages are stored; this feature only stores messages as today and marks historical imports as historical so consumers are not flooded.
  - message-events records each platform account's last successful sync time after an ok daemon cycle (Phase 5 cross-spec decision D1) and owns the registry through which every feature creates its tables (D6); this feature relies on both and does not record the sync time itself.
  - notifier (later spec) reads the persisted account health to tell the user that re-authentication is needed; this feature never contacts notifier.
  - cloud-deployment decides that Slack may run on the server host, provides the secret-file loading mechanism including the Slack secret names in its allowlist (D2), and documents the server; this feature verifies that the Slack secret names are accepted and adds Slack-specific setup guidance.
  - The sync daemon (sync-watcher) keeps running each account on its own schedule; this feature decides which conversations are read inside one Slack cycle.

## Requirements

### Requirement 1: Access backends
**Objective:** As a user who is not an admin in most of my workspaces, I want khipuchat to read Slack with my own browser session, so that every workspace I can sign into syncs without installing an app.

#### Acceptance Criteria
1. When an account is configured with a browser session token (`xoxc-` prefix) and a session cookie, the Slack Sync shall read that workspace using the user's session without requiring any Slack app to be installed in the workspace.
2. When an account is configured with an installed-app user token (`xoxp-` prefix), the Slack Sync shall read that workspace with the app token and shall not require a session cookie.
3. If an account has a session token but no session cookie, then the Slack Sync shall mark the account as misconfigured with a reason naming the missing cookie and shall not send any request to Slack for that account.
4. If an account has no token, or a token with any other prefix, then the Slack Sync shall mark the account as misconfigured with a reason naming the problem and shall not send any request to Slack for that account.
5. The Slack Sync shall store the same conversations and messages for an account regardless of which backend the account uses.
6. The Slack Sync shall treat each configured account as exactly one workspace, and shall allow several accounts to use the same session cookie value.
7. While the sync daemon is running, if one Slack account is misconfigured, then the Slack Sync shall keep the daemon and all other accounts running.
8. When a one-shot sync (`khipu sync slack` or `khipu sync slack@<account>`) targets a misconfigured account, the Slack Sync shall print the reason and exit with a non-zero status.

### Requirement 2: Guided credential capture
**Objective:** As a user, I want a guided command that captures and validates my Slack session credentials, so that adding or re-authenticating a workspace takes a few minutes and never requires an admin.

#### Acceptance Criteria
1. When the user runs `khipu slack login`, the Slack Login shall first display a notice that session tokens are an unofficial access method, may conflict with the workspace's terms of use, stop working on sign-out or when Slack detects unusual access (more likely from a datacenter IP address), and rotate frequently on Enterprise Grid.
2. When the user runs `khipu slack login` without the desktop option, the Slack Login shall print step-by-step browser instructions, including a ready-to-paste developer console snippet that copies the list of every signed-in workspace with its session token, and the steps to copy the session cookie value.
3. The Slack Login shall accept the pasted workspace list (or a single session token) and the session cookie through input that is not echoed to the terminal.
4. When credentials are entered, the Slack Login shall validate every workspace with Slack before saving anything and shall display, for each workspace, its name, URL, the signed-in user, and whether validation succeeded.
5. If validation fails for a workspace, then the Slack Login shall show the reason for that workspace and shall not save its credentials.
6. When the user confirms the validated workspaces, the Slack Login shall save each workspace's token and cookie to the local environment file under per-account variable names, readable only by the file owner.
7. When a validated workspace matches an existing account (same workspace identity, or the account named with `--account`), the Slack Login shall update that account's credentials instead of creating a new account.
8. Where an account configuration file (`khipu.config.json`) exists, the Slack Login shall add or update the Slack account entries referencing the saved variables and shall leave every other entry and field unchanged.
9. If no account configuration file exists, then the Slack Login shall not create one; it shall save a single workspace as the default account through the legacy variables, and for several workspaces shall print the account entries to add together with a note that creating the file switches every platform to file-based configuration.
10. Where the print option is given, the Slack Login shall write no file and shall print the environment lines and account entries to standard output, with a warning on standard error that the output contains secrets.
11. When credentials for an account are saved after successful validation, the Slack Login shall set that account's auth health to healthy for the new credentials.
12. Where the desktop option is given on macOS, the Slack Login shall read the session tokens and session cookie from the locally installed Slack desktop app and continue with validation as in criterion 4.
13. If the desktop import cannot complete (app not installed, keychain access denied, no token found, or unreadable data), then the Slack Login shall report the reason and fall back to the manual browser instructions.
14. If the desktop option is given on a host other than macOS, then the Slack Login shall report that desktop import is unsupported on this host and show the manual browser instructions.

### Requirement 3: Persisted auth health and re-auth signal
**Objective:** As a user, I want khipuchat to know when a Slack session has died and record it durably, so that a later notification feature can tell me to re-authenticate and I never silently lose messages.

#### Acceptance Criteria
1. The Slack Sync shall keep a persisted auth health record for each Slack account with one state out of healthy, degraded, needs re-auth, restricted, or misconfigured, a reason code, the time the state last changed, the time it was last checked (both as unix timestamps in seconds), and a sequence number.
2. When Slack rejects an account's credentials as invalid, not authenticated, revoked, expired, or belonging to an inactive account, the Slack Sync shall set that account's state to needs re-auth with the Slack reason code.
3. When Slack reports that the workspace or organization restricts access for these credentials (for example `enterprise_is_restricted` or `team_access_not_granted`), the Slack Sync shall set that account's state to restricted with the Slack reason code.
4. While an account is in the needs re-auth or restricted state with unchanged credentials, the Slack Sync shall not read conversations for that account and shall re-check credential validity at most once per re-check interval (default 60 minutes).
5. When a re-check succeeds, the Slack Sync shall set the account's state to healthy and resume reading conversations in the same cycle.
6. When the configured credentials of an account differ from the credentials its stored state was recorded for, the Slack Sync shall validate the new credentials on the next cycle instead of keeping the stored state.
7. The Slack Sync shall change the sequence number of an account's record only when its state or reason changes, and each change shall receive a sequence number greater than every earlier change of any account.
8. The Account Health Store shall let other features read the current record of every account, or only the records changed after a given sequence number, without contacting Slack.
9. When an account's state changes to anything other than healthy, the Slack Sync shall log one line with the platform, account, state, reason, and the command to re-authenticate, and shall not repeat that line on later cycles while the state is unchanged.
10. If a request fails because of a network error, a Slack server error, or rate limiting, then the Slack Sync shall not change the account's state to needs re-auth or restricted.
11. If every history read of an app-token account is rate limited for a configured number of consecutive cycles (default 3), then the Slack Sync shall set the account's state to degraded with a reason suggesting the session backend, and shall set it back to healthy after a cycle without that condition.
12. The Slack Sync shall not create or deliver notifications itself.

### Requirement 4: Conversation discovery and caching
**Objective:** As a user, I want khipuchat to find all my conversations in every workspace without re-listing them every minute, so that discovery is complete and cheap.

#### Acceptance Criteria
1. When an account's conversation list is refreshed, the Slack Sync shall discover every conversation the user is a member of, covering direct messages, group direct messages, public channels, and private channels, and shall skip archived conversations.
2. The Slack Sync shall reuse the discovered conversation list between cycles and refresh it on the first cycle after start and then at most once per refresh interval (default 30 minutes).
3. When a watch list or exclude list entry names a conversation by name (with or without a leading `#`, case-insensitive) or by Slack conversation ID, the Slack Sync shall match it against the discovered conversations.
4. Where a watch list entry is a conversation ID of a public channel the user has not joined, the Slack Sync shall include that channel if Slack allows reading it.
5. If a watch list or exclude list entry matches no conversation, then the Slack Sync shall log a warning naming the entry once per refresh and continue.
6. When a refresh discovers a conversation the account had not seen before, the Slack Sync shall import its earlier history as a historical import and then track its new messages.
7. When a conversation no longer appears in a refresh (left or archived), the Slack Sync shall stop reading it and keep its stored messages.

### Requirement 5: Thread replies
**Objective:** As a user, I want replies inside Slack threads to be archived, so that operational discussions held in threads are searchable and visible to triage.

#### Acceptance Criteria
1. When the Slack Sync stores a message that has thread replies, it shall store every reply in the same conversation, each linked to its parent message.
2. When new replies arrive in a thread whose latest activity is within the thread window (default 7 days), the Slack Sync shall store them at the poll frequency of the thread's conversation, including when the parent message was stored in an earlier cycle.
3. Where a thread has had no activity for longer than the thread window, the Slack Sync shall stop re-checking it, and shall resume when a later read shows new activity in that thread.
4. When a reply is also posted to the channel, the Slack Sync shall store it once.
5. When thread replies are read as part of a historical import, the Slack Sync shall store them as part of that historical import.
6. If reading the replies of one thread fails, then the Slack Sync shall continue with the remaining threads and retry the failed thread on the conversation's next poll.
7. The Slack Sync shall limit the number of thread re-checks per conversation poll to a configured maximum (default 20), checking the most recently active threads first.

### Requirement 6: Watch list and poll tiers
**Objective:** As a user, I want the channels I care about read every minute and the rest read less often, so that important messages arrive within 1 to 2 minutes without exceeding Slack limits.

#### Acceptance Criteria
1. The Slack Sync shall read conversations on an account's watch list at the watched interval (default 60 seconds), so that under normal operation a message posted in a watched conversation is stored within 2 minutes.
2. The Slack Sync shall read non-watched conversations with activity inside the active window (default 7 days) at the active interval (default 5 minutes).
3. The Slack Sync shall read all other non-excluded conversations at the idle interval (default 60 minutes).
4. The Slack Sync shall never read conversations on an account's exclude list, and an exclude entry shall take precedence over a watch entry.
5. Where the watch-DMs option is enabled for an account, the Slack Sync shall treat that account's direct and group direct messages with activity inside the active window as watched.
6. The Slack Sync shall accept the watch list, exclude list, intervals, windows, and limits per account, falling back to global defaults when an account does not set them.
7. If a setting value is invalid (for example a non-numeric or non-positive interval), then the Slack Sync shall use the default for that setting and log a warning naming the setting.
8. When a daemon cycle runs, the Slack Sync shall read due watched conversations first, then other due conversations in order of how overdue they are, and shall defer remaining work to the next cycle once the cycle time budget (default 45 seconds) is used.
9. While the operator has not set a Slack-specific daemon interval, the sync daemon shall run Slack cycles at the account's watched interval.
10. If a cycle for an account is still running when the next cycle for that account is due, then the Slack Sync shall skip the new cycle and log that it was skipped.
11. When a one-shot sync runs, the Slack Sync shall read every non-excluded conversation regardless of tier and without a cycle time budget.

### Requirement 7: Resumable incremental reads and history import
**Objective:** As a user, I want each conversation read from where it left off, and history imported without delaying watched channels, so that nothing is lost and nothing is duplicated.

#### Acceptance Criteria
1. The Slack Sync shall keep a persisted read position per conversation and, on each read, request only messages newer than that position, across restarts.
2. The Slack Sync shall advance a conversation's read position only after the messages up to that position are stored, so that an interrupted read (rate limit, error, restart) never leaves a gap.
3. When an account syncs for the first time, the Slack Sync shall import each conversation's history back to the configured history depth (default unlimited), spreading the import over several cycles in the daemon so that watched conversations keep their poll frequency.
4. The Slack Sync shall mark messages stored by a first sync, by a newly discovered conversation's import, by continued history import, or by a forced sync as a historical import, and only messages newer than an established read position as new messages.
5. When a conversation already has messages stored by an earlier version of the Slack sync and no read position, the Slack Sync shall continue from the newest stored message without importing its history again.
6. When the user runs a forced sync (`--force`), the Slack Sync shall re-read every conversation's history back to the configured depth without creating duplicates and shall update the sent-by-me flag on existing messages.
7. The Slack Sync shall not create duplicate messages when the same message is read more than once.
8. (Superseded by Phase 5 cross-spec decision D1.) The Slack Sync shall rely on message-events to record the account's last successful sync time after each daemon cycle that completes with an ok outcome, and shall not record that time itself.

### Requirement 8: Message and conversation mapping
**Objective:** As a user, I want Slack conversations and messages stored with correct types and senders, so that search, triage, and filters behave like other platforms.

#### Acceptance Criteria
1. The Slack Sync shall store public and private channels with chat type `channel`, direct messages with chat type `private`, and group direct messages with chat type `group`.
2. When a conversation previously stored with a wrong chat type is synced again, the Slack Sync shall correct its chat type.
3. The Slack Sync shall mark messages authored by the account's signed-in user as sent by the user.
4. The Slack Sync shall name direct message conversations after the other participant's display name, falling back to the user ID when the name cannot be resolved.
5. When a message is posted by a bot or integration, the Slack Sync shall use the bot or integration name as the sender name.
6. The Slack Sync shall store messages that carry user content (regular messages, thread broadcasts, bot messages, file shares with text, and `/me` messages) as text, and system messages (for example joins, leaves, and topic changes) with type `other`.
7. The Slack Sync shall resolve sender display names and reuse resolved names within a run, and if a name cannot be resolved, then it shall store the user ID as the sender name.

### Requirement 9: Rate limits and resilience
**Objective:** As a user, I want the sync to respect Slack limits and keep going through failures, so that my session is not flagged and one problem never stops the rest.

#### Acceptance Criteria
1. When Slack responds that a request is rate limited, the Slack Sync shall wait the indicated retry duration before retrying that request, unless the wait exceeds the remaining cycle time budget, in which case it shall defer that work to the next cycle.
2. The Slack Sync shall space requests per account so that each Slack method stays within its published per-workspace rate limit for normal operation.
3. If a request fails with a network error or a Slack server error, then the Slack Sync shall retry it with increasing delays up to 3 attempts and then skip that conversation for the current cycle, keeping its read position.
4. If Slack denies access to a single conversation (for example the user is no longer a member or the conversation no longer exists), then the Slack Sync shall skip that conversation, log the reason once per refresh, and continue with the others.
5. The Slack Sync shall never terminate the sync daemon process because of a Slack error, and a failure in one account shall not stop other accounts or other platforms.

### Requirement 10: Secrets, privacy, and documentation
**Objective:** As a user running khipuchat on my laptop or a cloud server, I want my Slack session secrets protected and the risks documented, so that using session tokens is a conscious, safe choice.

#### Acceptance Criteria
1. The Slack Sync and Slack Login shall never write session tokens, app tokens, or cookie values to logs, error messages, status output, or health records.
2. The Slack Sync shall identify credentials in health records and status output only through account names, workspace names, and a short non-reversible fingerprint.
3. Where khipuchat runs with secrets supplied as files, the Slack Sync shall accept each account's token and cookie from secret files in the same way as other allowlisted secrets, using the Slack names already allowlisted by cloud-deployment (D2).
4. The setup documentation shall describe the session token backend as the default, the installed-app token as the alternative, the unofficial-access and terms-of-use risk, invalidation on sign-out or unusual-access detection, the higher risk from a datacenter IP address, Enterprise Grid rotation, and how to re-authenticate.
5. The Slack Sync shall not use or depend on any Beeper component.

### Requirement 11: Status visibility
**Objective:** As a user, I want to see each Slack workspace's health and sync progress at a glance, so that I know which workspace needs attention.

#### Acceptance Criteria
1. When the user runs `khipu slack status`, the Slack Status command shall list every configured Slack account with its workspace name, backend, auth health state, reason, time of the last state change, last successful sync time, number of conversations per poll tier, and history import progress.
2. When the user runs `khipu sync` without arguments, the sync status output shall show each account's auth health state next to its last sync time for accounts that have a health record.
3. If an account has no health record yet, then the status output shall show it as not yet checked.
