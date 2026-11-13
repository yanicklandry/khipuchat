# Requirements Document

## Project Description (Input)
Once triage-agent judges a message important, the user must actually be told, on the device they are using, without being spammed. khipuchat has no outbound delivery of any kind today: no notification, webhook, SMTP, or push code exists. triage-agent publishes a durable feed of important verdicts (`{ important, urgency, reason, summary, suggested_action }` plus source workspace, channel, sender, and a short excerpt) and accepts "not important" feedback; presence-context answers whether the phone and laptop are together and where; cloud-deployment provides an authenticated HTTP ingress for callbacks; slack-all-workspaces records account health (for example "Slack session needs re-auth").

The notifier should turn each important verdict into one notification with the source (workspace / channel / sender), a short summary, the AI's reason, the suggested action, and buttons (Open, Do it, Not important). Routing uses presence: together = laptop/desktop channel, apart = phone channel, critical = Pushover emergency priority that bypasses Do Not Disturb. Duplicates and bursts are collapsed; quiet hours are respected except for critical alerts. Channels are ntfy (self-hostable hub, topics per device, HTTP action buttons calling back into the ingress), Pushover (critical iOS alerts, priority 2 with acknowledgment), and a Telegram bot (fallback; a bot token, separate from the Telegram sync session), all called with plain HTTP and no SDKs. A delivery log records every notification. Button presses come back through signed, single-use callbacks and feed triage feedback and a generic approval hand-off for the later action-runner. The same delivery path carries system alerts such as an expired Slack session. `khipu notify test` and docs are included.

Constraints: notification content leaves the machine through third-party relays (ntfy server and its iOS push bridge, Pushover, Telegram), so payloads are short and redaction is configurable; notifications go to the user only and never post on the source platform; secrets live in the environment or secret files and are never logged; no Beeper dependency; strict TypeScript, files under 200 lines.

## Introduction
The notifier is the delivery half of Phase 5 alerting. It reads important verdicts and system health changes, decides whether, when, and where to tell the user, sends one short notification through the configured channel for the user's current situation, records what happened, and turns the user's button presses into triage feedback or recorded approvals. It never decides importance and never executes actions.

## Boundary Context
- **In scope**: consuming the important-verdict feed as the consumer `notifier`; consuming account health changes for system alerts; accepting notification requests from other khipuchat modules; notification content and redaction; presence-aware routing by urgency; quiet hours; dedupe, burst collapse, and rate limiting; delivery through ntfy, Pushover, and a Telegram bot with fallback and retries; Pushover emergency acknowledgment tracking; action buttons and their single-use callbacks; recording "not important" feedback; recording approvals for a later action executor; the delivery log, its retention, and status reporting; the `khipu notify` command family; operator documentation.
- **Out of scope**: deciding importance, urgency, or suggested actions (triage-agent); executing, scheduling, or authorizing actions (action-runner); location ingestion and the together/apart computation (presence-context); detecting Slack session expiry (slack-all-workspaces); a native iOS app or direct Apple push; email or SMS delivery; replying or posting on any source platform; multi-user delivery.
- **Adjacent expectations**: triage-agent delivers each important verdict at least once and accepts feedback from the source `notifier`; presence-context answers together, apart, or unknown on demand; the ingress (cloud-deployment) authenticates every request before it reaches the notifier's callback routes and authenticates links opened from a notification through its signed capability paths, which cloud-deployment owns and the notifier only uses; cloud-deployment also loads the notifier secrets from secret files and resolves the default configuration file location; message-events provides the schema registry that creates the notifier tables and the daemon services list that starts the notifier; slack-all-workspaces records health transitions with an increasing sequence and unix-second times; action-runner will later decide which suggested actions may offer a "Do it" button by supplying its decision to the notifier at startup, and will read recorded approvals.

## Requirements

### Requirement 1: Important verdict intake
**Objective:** As the user, I want every important verdict turned into exactly one notification candidate, so that nothing important is lost and nothing is announced twice.

#### Acceptance Criteria
1. While the sync daemon is running and a valid notifier configuration exists, the Notifier shall read important verdicts as the downstream consumer named `notifier`.
2. When the notifier consumer is registered for the first time, the Notifier shall start from the newest existing verdict, so that verdicts produced before the notifier was enabled are not announced.
3. When new important verdicts exist, the Notifier shall pick them up within 10 seconds by default, with the check interval configurable by the operator.
4. When the same verdict is delivered to the Notifier more than once, the Notifier shall record at most one notification for it.
5. When a notification for a verdict has been recorded durably, the Notifier shall acknowledge the verdict so that it is not delivered again after a restart.
6. If a verdict is older than the configured staleness limit (default 6 hours) when the Notifier first sees it, the Notifier shall record it as suppressed with reason `stale` and shall not send it.
7. If the source message of a verdict no longer exists, the Notifier shall still notify, stating that the source is unavailable, and shall omit the Open button.
8. If no notifier configuration exists or notifications are disabled by the operator, the Notifier shall not start, shall log one line saying why, and shall leave the verdict feed untouched.

### Requirement 2: Notification content
**Objective:** As the user, I want each notification to tell me at a glance where the message came from, what it says, why it matters, and what I could do, so that I can decide without opening anything.

#### Acceptance Criteria
1. When the Notifier renders a verdict notification, the Notifier shall include the source platform and workspace (account), the chat name, the sender name when known, the verdict summary, the verdict reason, and the suggested action id when one exists.
2. The Notifier shall show the urgency of a notification both in its wording and in the channel's priority level, mapping low, normal, high, and critical to increasing channel priorities.
3. The Notifier shall keep every rendered title and body within the limits of the channel used, shortening the reason before the summary and the summary before the source line, and marking any shortened text with an ellipsis.
4. The Notifier shall never include message attachments, images, or more than the first 280 characters of the original message text in any notification.
5. When a notification is rendered for a system alert or a request from another khipuchat module, the Notifier shall use the title and body supplied for that alert or request, subject to the same limits and redaction.

### Requirement 3: Redaction and outbound privacy
**Objective:** As the user, I want control over how much message content leaves the machine through third-party relays, so that sensitive content is not exposed beyond what I accept.

#### Acceptance Criteria
1. The Notifier shall support three redaction levels: `full` (source, summary, reason, suggested action, and the message excerpt), `standard` (source, summary, reason, and suggested action, without the excerpt), and `minimal` (platform, urgency, and a generic "Important message" title only).
2. The Notifier shall apply the `standard` level by default and shall allow the operator to set a different level globally and per delivery target.
3. Where the operator configures redaction patterns, the Notifier shall replace every match in every rendered text field with a fixed placeholder before sending.
4. The Notifier shall send notification content only to the delivery targets in the operator's configuration and shall never post, reply, or react on the platform the message came from.
5. The Notifier shall never write message text, rendered notification text, tokens, or secrets to its log lines; log lines carry only ids, kinds, statuses, target names, and channel names.
6. When the minimal redaction level is in effect for a target and callback links are available, the Notifier shall let the user see the standard-level details on the response page reached from the notification instead of in the notification itself.

### Requirement 4: Presence-aware routing
**Objective:** As the user, I want each alert delivered to the device I am actually near, so that I see it promptly.

#### Acceptance Criteria
1. When a non-critical notification is due, the Notifier shall read the current presence at that moment and choose the operator's route for `together` when the phone and laptop are together, for `apart` when they are apart, and for `unknown` when presence cannot tell.
2. When a critical notification is due, the Notifier shall choose the operator's `critical` route regardless of presence.
3. If reading presence fails for any reason, the Notifier shall treat presence as unknown and continue.
4. Where the operator configures a route for a specific urgency, the Notifier shall use that route for notifications of that urgency instead of the general route.
5. The Notifier shall deliver each notification to one target: the first target of the chosen route that accepts it, trying later targets in the route only when an earlier one fails.
6. The Notifier shall record, for every sent notification, the presence state used and the target and channel that accepted it.
7. If the configuration names a route target that does not exist, the Notifier shall reject the configuration at startup with a message naming the route and target.

### Requirement 5: Quiet hours
**Objective:** As the user, I want non-critical alerts held during my quiet hours, so that I am only woken for what is critical.

#### Acceptance Criteria
1. Where the operator configures quiet hours (daily start and end time, optionally limited to weekdays), the Notifier shall evaluate them in the user's local time zone as reported by presence, falling back to the configured time zone and then the server's time zone.
2. While quiet hours are in effect, the Notifier shall hold every non-critical notification instead of sending it.
3. While quiet hours are in effect, the Notifier shall send critical notifications immediately.
4. When quiet hours end, the Notifier shall release held notifications within one check interval: a single held notification is sent as it is, and two or more are sent as one summary notification listing up to 5 of them and the total count.
5. The Notifier shall support quiet-hour windows that cross midnight.

### Requirement 6: Dedupe, burst collapse, and rate limiting
**Objective:** As the user, I want repeated and rapid-fire alerts collapsed, so that a busy channel does not flood my devices.

#### Acceptance Criteria
1. When a notification has the same source chat (or alert subject) and the same summary as a notification recorded within the dedupe window (default 10 minutes), the Notifier shall record it as suppressed with reason `duplicate` and shall not send it.
2. When more notifications for the same source chat (or alert subject) become due within the burst window (default 5 minutes) than the burst limit (default 2), the Notifier shall defer the excess and, when the window ends, send one summary notification stating how many more arrived and listing up to 5 of them.
3. When more non-critical notifications become due within any 60 minutes than the hourly limit (default 20), the Notifier shall defer the excess and send one summary notification when the limit allows again.
4. The Notifier shall exempt critical notifications from the hourly limit, and shall apply dedupe and burst collapse to them; a summary that includes critical notifications shall be sent at high urgency.
5. The Notifier shall record every deferred, merged, and suppressed notification with its reason, and shall link merged notifications to the summary that carried them.
6. Summary notifications shall carry an Open button only when all merged notifications share one Open link, and shall carry no Do it or Not important buttons.

### Requirement 7: Delivery channels
**Objective:** As the operator, I want ntfy, Pushover, and a Telegram bot as delivery channels, so that I can use a self-hosted hub, an emergency-capable iOS channel, and a cheap fallback.

#### Acceptance Criteria
1. Where an ntfy target is configured, the Notifier shall publish to the configured ntfy server and topic, with optional access-token authentication, title, priority, Open link, and up to three action buttons.
2. Where a Pushover target is configured, the Notifier shall send to the configured user (optionally one device) with a title, priority, and one supplementary link.
3. When a critical notification is sent through Pushover, the Notifier shall use emergency priority with the configured retry interval (at least 30 seconds) and expiry (at most 3 hours), and shall track its acknowledgment.
4. Where a Telegram target is configured, the Notifier shall send through a dedicated bot token to the configured chat, with inline buttons, and shall never use the Telegram sync session or account.
5. The Notifier shall call every channel over HTTPS with a request timeout of 10 seconds and without third-party SDKs.
6. When a channel reports a temporary failure (network error, timeout, server error, or rate limit), the Notifier shall retry the same target up to 3 attempts in total with increasing delay, honoring any wait time the channel requests, before moving to the next target in the route.
7. When a channel reports a permanent failure (rejected request or invalid credentials), the Notifier shall move to the next target in the route immediately.
8. If every target in the route fails, the Notifier shall record the notification as failed with the last failure reason and shall log one line naming the notification id and the targets tried.
9. When a Pushover emergency notification is acknowledged by the user, the Notifier shall record the acknowledgment time within 60 seconds.

### Requirement 8: Action buttons
**Objective:** As the user, I want Open, Do it, and Not important buttons on a verdict notification, so that I can act directly from it.

#### Acceptance Criteria
1. When a verdict notification is rendered and an Open link can be built for the source message, the Notifier shall include an Open button that opens the source message or chat in its native app or web client.
2. When a verdict notification is rendered, the Notifier shall include a Not important button.
3. When a verdict has a suggested action and that action is currently offered for approval, the Notifier shall include a Do it button; otherwise the Notifier shall mention the suggested action in the text only.
4. When a notification request from another khipuchat module carries an approval subject, the Notifier shall include a Do it button for it.
5. If callback links cannot be built (no public ingress address or no signing key configured), the Notifier shall still send ntfy and Pushover notifications with the Open link only, shall keep Telegram buttons working, and shall report the reason in `khipu notify status`.
6. Where a channel supports only one link (Pushover), the Notifier shall link to a response page that shows the notification details, the Open link, and the available action buttons.

### Requirement 9: Callback handling
**Objective:** As the user, I want button presses to take effect exactly once and only from links the notifier sent me, so that my answers are reliable and links cannot be abused.

#### Acceptance Criteria
1. The Notifier shall accept button presses only through callback links or button data it issued, each bound to one notification, unguessable, and valid for a configurable lifetime (default 24 hours).
2. When the user presses Not important, the Notifier shall record "not important" feedback for the verdict's decision with the source `notifier`.
3. When the user presses Do it, the Notifier shall record one approval for that notification's action subject for a later action executor, and shall not execute anything itself.
4. When any action of a notification has been accepted, the Notifier shall reject every later press for that notification, from any channel, with a response stating which action was already taken.
5. If a callback link is expired, unknown, or for an action the notification does not offer, the Notifier shall reject it without side effects and with a response stating the reason.
6. When a callback link is opened with a plain page request (as a browser does), the Notifier shall show a confirmation page and shall change nothing until the user confirms.
7. When an action is accepted, the Notifier shall record the notification as acknowledged with the time and the channel used, and shall stop any pending Pushover emergency repetition for it.
8. When a Telegram button is pressed, the Notifier shall accept it only from the configured chat and user, shall answer the press so the Telegram client stops waiting, and shall replace the buttons with the outcome.
9. The Notifier shall receive button presses from ntfy and from response pages only through the authenticated ingress, and shall receive Telegram presses by polling the bot, so that Telegram presses work without a public ingress.

### Requirement 10: System alerts
**Objective:** As the user, I want to be told when a source account stops working (for example, the Slack session needs re-authentication), so that sync gaps do not go unnoticed.

#### Acceptance Criteria
1. While the Notifier is running, it shall check account health changes at least every 60 seconds.
2. When an account's health changes to a status in the operator's alert list (default `needs_reauth`, `restricted`, `misconfigured`), the Notifier shall send one system alert naming the platform, the account, the status, the short detail supplied with the health record, and, where known for that platform, the command that fixes it (for Slack, the `khipu slack login` command for that account).
3. When an account that had an alerted problem returns to healthy, the Notifier shall send one low-urgency "resolved" alert, unless the operator turned resolved alerts off.
4. When the Notifier starts for the first time, the Notifier shall send one alert for each account currently in an alerted status, and shall afterwards alert only on changes.
5. The Notifier shall remember the last health change it handled across restarts, so that a restart neither repeats nor skips alerts.
6. The Notifier shall route, hold, collapse, and log system alerts like other notifications, at high urgency by default, configurable by the operator.

### Requirement 11: Notification requests and approval hand-off
**Objective:** As a developer of a later khipuchat module (action-runner), I want to queue notifications and read the user's approvals through stable interfaces, so that my module can ask, report, and act without owning delivery.

#### Acceptance Criteria
1. The Notifier shall accept a notification request from another khipuchat module with an idempotency key, an origin name, an urgency, a title, a body, an optional Open link, an optional collapse key, and an optional approval subject (action id, parameters, and an optional decision id).
2. When a request repeats an idempotency key already recorded for the same origin, the Notifier shall return the existing notification without creating a new one.
3. If a request is invalid (bad key or origin, title too long, non-HTTPS Open link, or malformed approval subject), the Notifier shall reject it with an error code and a message and shall record nothing.
4. The Notifier shall deliver queued requests through the same routing, quiet hours, collapse, and logging as other notifications, from whichever khipuchat process queued them.
5. The Notifier shall publish recorded approvals as a durable, ordered feed with per-consumer positions, delivered at least once, mirroring the verdict feed's register, read, and acknowledge pattern.
6. The Notifier shall record at most one approval per notification and shall create approvals only from a user's accepted Do it press.
7. The Notifier shall provide a single injectable decision point, offering no Do it buttons by default, through which a later action executor supplies, at startup and without changing notifier code, which suggested actions are offered for approval.

### Requirement 12: Delivery log and status
**Objective:** As the operator, I want a durable record of every notification and a quick health view, so that I can verify delivery and tune routing.

#### Acceptance Criteria
1. The Notifier shall record every notification with its kind, source reference, urgency, status, status reason, chosen route, presence state used, target, channel, attempt count, channel reference, creation time, send time, and acknowledgment time and channel.
2. When `khipu notify status` runs, the Notifier shall show whether notifications are enabled, each configured target with its channel and whether its credentials are present (never their values), whether callback links are available, verdict feed lag, counts by status for the last 24 hours, and the last failure per target.
3. When `khipu notify log` runs, the Notifier shall list recent notifications newest first, filterable by status and limited by count, without message text unless the operator asks for rendered text.
4. The Notifier shall delete notifications, callbacks, and approvals older than the retention period (default 30 days, configurable) at startup and at least once per hour.

### Requirement 13: Test command
**Objective:** As the operator, I want to send a test notification and preview routing, so that I can verify each channel and route before relying on it.

#### Acceptance Criteria
1. When `khipu notify test` runs, the Notifier shall send one test notification through the route chosen for the current presence and the requested urgency (default normal), bypassing quiet hours, dedupe, and collapse, and shall print the target, channel, and outcome.
2. When `khipu notify test --target <id>` runs, the Notifier shall send the test notification to that target only.
3. When `khipu notify test --dry-run` runs, the Notifier shall print the presence state, the chosen route, and the rendered title, body, and buttons for each target in the route, and shall send nothing.
4. When a test notification's button is pressed, the Notifier shall acknowledge it and record no feedback or approval.
5. If the configuration is invalid, `khipu notify test` shall print every configuration problem and exit with a non-zero status.

### Requirement 14: Configuration and secrets
**Objective:** As the operator, I want one validated configuration file and secrets kept out of it, so that setup is explicit and safe.

#### Acceptance Criteria
1. The Notifier shall read its settings from one configuration file at a configurable path, defining delivery targets, routes, quiet hours, collapse limits, redaction, callback lifetime, system alert behavior, and Open link templates.
2. If the configuration file is invalid, the Notifier shall report every problem with the setting path and shall not start delivering.
3. The Notifier shall read channel credentials (ntfy access token, Pushover application token and user key, Telegram bot token) and the callback signing key only from the environment or from secret files, never from the configuration file.
4. If a configured target lacks its credentials, the Notifier shall report the target as unavailable at startup and skip it when routing, without stopping other targets.
5. The Notifier shall allow the operator to disable notifications entirely with one setting, without removing the configuration file.
6. The Notifier shall work the same on a local Mac deployment and on the cloud server deployment.

### Requirement 15: Operator documentation
**Objective:** As the operator, I want a guide for setting up each channel and route, so that I can configure alerting without reading code.

#### Acceptance Criteria
1. The Notifier documentation shall describe setting up ntfy (self-hosted or public server, topic choice, access token, iOS push bridge behavior), Pushover (application token, user key, emergency alert and Do Not Disturb settings on iOS), and the Telegram bot (creating the bot, finding the chat id, and why it is separate from the sync session).
2. The Notifier documentation shall describe the configuration file with a complete example covering the together, apart, unknown, and critical routes, quiet hours, collapse limits, and redaction.
3. The Notifier documentation shall describe callback links: the public ingress address, the signing key, link lifetime, single use, and what leaks if a link is seen by a third party.
4. The environment template shall list every notifier setting and secret name without values.
