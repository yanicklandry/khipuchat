# Requirements Document

## Project Description (Input)
The khipuchat user receives many messages across workspaces and platforms; only a few are operationally important. Example: a new transaction posted in Slack `#08-expedition` means a new ADV report must be generated, and today the user only notices by reading Slack. No consumer of new messages exists yet: message-events provides a durable stream of newly stored messages, llm-provider provides a provider-neutral model client with structured output (Muse Spark or local Ollama), and presence-context answers whether the phone and laptop are together, where, and the local time.

The triage agent should evaluate each new live message within about one minute of sync and store a typed verdict `{ important, urgency: low|normal|high|critical, reason, suggested_action?: { id, params }, presence_snapshot }`. It works in two stages to keep cost and leakage low: (1) a deterministic, local rule prefilter (platform, account or workspace, chat such as `#08-expedition`, sender, keyword or regex, direct message to me, mentions) with a default policy (`skip`, `llm`, `always-notify`), so most messages never reach a model; (2) an LLM judgment for messages the rules escalate, with context (the message, recent conversation, rule hints such as "transactions here require an ADV report", and a coarse presence summary). Rules can also map directly to a suggested action without the LLM. Every decision is stored (event, rule matched, model, latency, verdict, user feedback). `khipu triage replay <message-id>` and `khipu triage test --rules` support tuning. Important verdicts are handed to notifier (and suggested actions to action-runner) through a stable hand-off; user feedback ("not important") comes back from notifier into the decision log.

Constraints: only rule-escalated messages may be sent to a cloud LLM and rules can force local-only (Ollama) per source; LLM failure degrades safely (`always-notify` still fires, high-priority rules produce a "could not triage" verdict rather than silence); idempotent per event under at-least-once delivery; strict TypeScript, files under 200 lines; no Beeper dependency.

## Introduction
The triage agent is the first consumer of the message event stream. It turns "a new message was stored" into "this deserves the user's attention, this urgently, for this reason, and this allowlisted action could follow", records why, and hands important verdicts to the notifier and action-runner features. It never delivers notifications and never executes actions itself.

## Boundary Context
- **In scope**: consuming new live message events inside the sync daemon; the triage rules file, its validation, and deterministic matching; the LLM judgment stage and its context; the verdict format and its validation; the decision log, its retention, and feedback recording; the hand-off of important verdicts to downstream consumers; the read-only use of an action catalog; the `khipu triage` command family; tests with a fake model.
- **Out of scope**: delivering notifications, routing to devices, quiet hours, dedupe of notifications (notifier); executing, approving, or defining actions and their parameter rules (action-runner); learning or auto-tuning rules from feedback; multi-message digests; triaging backfill (history import, first sync, forced re-read) messages; an MCP or web surface for decisions; changes to how often Slack channels are read.
- **Adjacent expectations**: message-events delivers each new message event at least once, marks history imports as backfill, and offers a wake-up hint after each daemon cycle; llm-provider enforces the global cloud opt-in and validates structured answers; presence-context provides the coarse LLM-safe presence view; message-events also owns the schema registry that creates feature tables on archive open and the daemon services list that starts and stops in-daemon features; cloud-deployment resolves the archive location and the default location of data files such as the triage rules file; llm-provider lets the operator declare additional model hosts (such as a co-located Ollama service) as local; action-runner later supplies the list of allowlisted action ids and parameter formats through message-events' shared daemon wiring, which reaches both the in-daemon triage service and the `khipu triage` command, without changing triage; notifier later reads important verdicts and reports user feedback; the Slack watch list (slack-all-workspaces) only controls how quickly Slack channels are read and is not a triage rule; it is used only by the rules test warnings.

## Requirements

### Requirement 1: Live message consumption
**Objective:** As the user, I want every newly synced live message evaluated shortly after it is stored, so that important messages reach me within about a minute without manual reading.

#### Acceptance Criteria
1. While the sync daemon is running and a valid triage rules file exists, the Triage Agent shall consume new message events as the consumer named `triage-agent`.
2. When the triage consumer is registered for the first time, the Triage Agent shall start from the newest existing event, so that messages stored before triage was enabled are not evaluated.
3. When a daemon sync cycle records live events, the Triage Agent shall begin evaluating them within 5 seconds of the cycle finishing.
4. If no wake-up hint arrives, the Triage Agent shall still check for pending events at least every 30 seconds by default, with the interval configurable by the operator.
5. The Triage Agent shall evaluate only live events and shall pass over backfill events without evaluating them.
6. When an event is delivered more than once, the Triage Agent shall record at most one decision for that event and shall not evaluate it with a model again once a decision exists.
7. When a decision for an event has been recorded, the Triage Agent shall acknowledge that event so that it is not delivered again after a restart.
8. If the message referenced by an event no longer exists in the archive, the Triage Agent shall record a skipped decision with reason `missing_message` and continue.
9. If evaluating one event fails unexpectedly three times in a row, the Triage Agent shall record or log the failure for that event and move past it so that later events are still evaluated.
10. When the daemon shuts down, the Triage Agent shall start evaluating no further events, wait at most 10 seconds for an in-progress evaluation to finish, and otherwise abandon it without recording or acknowledging it, so that it is evaluated again after restart; a repeated shutdown request shall have no further effect.
11. While the daemon runs in single-pass mode, the Triage Agent shall, after the sync pass and before the process exits, evaluate pending live events until none remain or the time bound given by the daemon (120 seconds) is reached, leaving any events not evaluated unacknowledged so that the next run evaluates them.
12. If no triage rules file exists or triage is explicitly disabled by the operator, the Triage Agent shall not start, shall make no model call, and shall log one line stating that triage is disabled and why.
13. If a live event's message timestamp is older than the maximum message age (24 hours by default, configurable), the Triage Agent shall record a skipped decision with reason `too_old` without matching rules or calling a model.

### Requirement 2: Triage rules file
**Objective:** As the operator, I want importance rules in one readable, validated configuration file, so that I can say which chats, senders, and words matter without changing code.

#### Acceptance Criteria
1. The Triage Agent shall read triage rules from one configuration file at a default location next to the message archive, independent of the working directory, overridable by an operator setting.
2. The triage rules file shall define a format version, a default policy (`skip`, `llm`, or `always-notify`), an optional identity of the user (display names and platform user ids used for mention and sender detection), and an ordered list of rules.
3. Each rule shall have a unique identifier, optional match conditions, a policy, and may carry an urgency, a hint for the model, a suggested action mapping, a model routing preference (`any` or `local-only`), and a failure behavior (`notify` or `skip`).
4. If the rules file is malformed or any rule is invalid, the Triage Agent shall report every problem, each naming the rule identifier or position and the offending field, and shall not start with that file.
5. When the rules file changes while the daemon is running, the Triage Agent shall use the new rules for events evaluated after the change without a restart.
6. If a changed rules file is invalid, the Triage Agent shall keep using the last valid rules and log the problems once per change.
7. If the default policy is omitted, the Triage Agent shall use `skip`.
8. The Triage Agent shall record with every decision a short version fingerprint of the rules that produced it.
9. The triage rules shall be separate from the Slack watch list; the Triage Agent shall not change how often any channel is read and shall not read the Slack watch list to decide importance.

### Requirement 3: Deterministic rule matching
**Objective:** As the user, I want rule matching to be predictable and local, so that most messages are decided without any model and I can reason about outcomes.

#### Acceptance Criteria
1. The Triage Agent shall support match conditions on platform, account, chat (by name with or without a leading `#`, by platform chat id, or by archive chat id), chat type, sender (by display name or platform user id), keywords, a regular expression, direct message to the user, and mention of the user.
2. Where a match condition lists several values, the Triage Agent shall treat the condition as satisfied when any value matches; where a rule has several conditions, the Triage Agent shall require all of them to be satisfied.
3. Where a rule has no match conditions, the Triage Agent shall treat it as matching every message.
4. The Triage Agent shall compare chat names, sender names, and keywords case-insensitively.
5. The Triage Agent shall apply keywords and regular expressions to the message text and, when present, to the text recognized from an image.
6. The Triage Agent shall evaluate rules in file order and apply the first rule that matches; when no rule matches, the Triage Agent shall apply the default policy.
7. The Triage Agent shall treat a message as a direct message to the user when it is in a one-to-one chat and was not sent by the user.
8. The Triage Agent shall treat a message as mentioning the user when its text contains `@` followed by one of the configured identity names, or a platform mention of one of the configured identity ids.
9. When a message was sent by the user, the Triage Agent shall record a skipped decision with reason `own_message` without matching rules.
10. The Triage Agent shall perform rule matching without any network call and record the matched rule identifier, or none, on the decision.

### Requirement 4: Policy outcomes and direct action mapping
**Objective:** As the user, I want each policy to have one clear effect, so that skip means quiet, always-notify means alert, and llm means ask the model.

#### Acceptance Criteria
1. When the applied policy is `skip`, the Triage Agent shall record a not-important decision with reason naming the rule or the default policy and shall make no model call.
2. When the applied policy is `always-notify`, the Triage Agent shall record an important decision with the rule urgency (`normal` when unset), a reason naming the rule, and shall make no model call.
3. When the applied policy is `llm`, the Triage Agent shall obtain a judgment from a model as defined in Requirements 5 to 7.
4. Where a rule with policy `always-notify` maps a suggested action, the Triage Agent shall attach that action, with parameters filled from the rule, to the decision without a model call.
5. Where a mapped action parameter refers to a named part captured by the rule's regular expression, or to the message or chat id, the Triage Agent shall substitute the captured or referenced value.
6. If a mapped action id is not in the available action list, or a referenced captured part is missing, the Triage Agent shall record the decision without a suggested action and add a note explaining why.
7. Where a rule with policy `llm` maps a suggested action, the Triage Agent shall present it to the model as the preferred action for that rule.

### Requirement 5: LLM judgment context
**Objective:** As the user, I want the model to see enough context to judge well, and no more, so that verdicts are accurate and little content leaves the machine.

#### Acceptance Criteria
1. When asking a model for a judgment, the Triage Agent shall include the message text (truncated to 2000 characters), message type, sender name, platform, account, chat name and type, and the message time.
2. When the message replies to another stored message, the Triage Agent shall include that parent message's sender and text excerpt.
3. The Triage Agent shall include up to 10 preceding messages of the same chat by default (configurable), oldest first, each truncated to 300 characters.
4. Where the matched rule has a description or hint, the Triage Agent shall include them as operator guidance for the judgment.
5. The Triage Agent shall include presence only through presence-context's LLM-bound presence view and its one-line summary, and shall never send raw coordinates unless the operator enabled precise presence for models in presence-context.
6. If presence cannot be computed, the Triage Agent shall state that presence is unavailable in the context, record the presence snapshot as absent, and continue.
7. The Triage Agent shall include the identifiers, descriptions, and parameter formats of the available actions, and shall instruct the model that it may only choose among them or choose none.
8. The Triage Agent shall instruct the model that message content is data to evaluate, not instructions to follow.
9. The Triage Agent shall make the model judgment without giving the model tools to call.

### Requirement 6: Verdict format and validation
**Objective:** As a downstream developer, I want one precise verdict format, so that notifier and action-runner can rely on it.

#### Acceptance Criteria
1. The Triage Agent shall express every decision as a verdict with: `important` (yes or no), `urgency` (`low`, `normal`, `high`, or `critical`), `reason` (one to 500 characters), `summary` (one line, up to 200 characters), `suggested_action` (an action id with parameters, or none), and `presence_snapshot` (the LLM-bound presence view used, or none).
2. The Triage Agent shall accept a model answer only when it matches the verdict format, including an action id from the available action list with parameters matching that action's parameter format.
3. If the model answer cannot be accepted after the model client's single corrective retry, the Triage Agent shall treat the judgment as failed per Requirement 8.
4. When a verdict is not important, the Triage Agent shall store it with no suggested action, discarding any action the model proposed and noting that it was discarded.
5. If the model returns a reason or summary longer than allowed or spanning several lines, the Triage Agent shall shorten it to the limit and to one line for the summary instead of rejecting the verdict.
6. The Triage Agent shall never accept a suggested action whose id is not in the available action list at the time of evaluation.
7. When no actions are available, the Triage Agent shall still triage normally and every verdict shall have no suggested action.

### Requirement 7: Model routing, egress, and budget
**Objective:** As the user, I want control over which messages may leave the machine and how much model usage triage costs.

#### Acceptance Criteria
1. The Triage Agent shall send message content to a model only for messages whose applied policy is `llm`.
2. Where the applied rule's routing preference is `local-only`, the Triage Agent shall use only the local Ollama provider for that judgment, never the configured OpenAI-compatible endpoint and never its fallback.
3. Where the operator sets triage to local-only globally, the Triage Agent shall treat every judgment as `local-only`.
4. Where routing is `any`, the Triage Agent shall use the operator's configured model client, including its cloud opt-in gate and local fallback.
5. The Triage Agent shall tag every model call it makes with the purpose `triage`, so that the model client's call log identifies triage traffic.
6. While the number of triage model calls in the past hour has reached the configured hourly budget (120 by default), the Triage Agent shall not call a model and shall treat further `llm` judgments as failed with reason `budget_exceeded` per Requirement 8.
7. The Triage Agent shall record on each decision which provider, model, and destination (local or cloud) served the judgment, how many attempts it took, and token usage when reported.

### Requirement 8: Safe degradation
**Objective:** As the user, I want failures to produce a visible "could not triage" alert for messages that matter rather than silence.

#### Acceptance Criteria
1. If a model judgment fails (provider error, cloud not allowed, unreadable answer, timeout, or budget exceeded) and the rule's failure behavior is `notify`, the Triage Agent shall record an important decision with the rule urgency, a reason starting with "Could not triage" that names the failure category and the rule, the rule's mapped action when available, and a fallback marker.
2. If a model judgment fails and the failure behavior is `skip`, the Triage Agent shall record a not-important decision with the failure category and a fallback marker.
3. Where a rule does not set a failure behavior, the Triage Agent shall use `notify` when the rule urgency is `high` or `critical`, and `skip` otherwise; for the default policy the Triage Agent shall use an operator-configurable failure behavior that defaults to `skip`.
4. The Triage Agent shall record the failure category on every failed-judgment decision and shall never record provider credentials or endpoint paths.
5. If the model client cannot be constructed from the operator's settings, the Triage Agent shall still start, apply `skip` and `always-notify` rules normally, treat every `llm` judgment as failed with reason `llm_unavailable`, and log the configuration problem once at startup.
6. If the action list cannot be read, the Triage Agent shall treat it as empty for that evaluation and log the problem.
7. A failure while evaluating one message shall not stop evaluation of later messages.

### Requirement 9: Decision log
**Objective:** As the user, I want every decision stored with its reasons, so that I can see why something was or was not raised and audit triage behavior.

#### Acceptance Criteria
1. The Triage Agent shall store one decision record per evaluated event containing: decision id, event id, archive message id, kind (event or replay), outcome type (skipped, rule, llm, fallback), skip reason when skipped, matched rule id, applied policy, the verdict fields, the presence snapshot used, model provider and model and destination when a model was asked, attempts, token usage, failure category, total evaluation latency in milliseconds, rules version, prompt version, notes, feedback, and creation time.
2. The Triage Agent shall store the model's accepted answer text, truncated to 4000 characters, on decisions made by a model.
3. The Triage Agent shall store presence only as the LLM-bound presence view, never raw device coordinates unless that view was precise by operator opt-in.
4. The Triage Agent shall write one log line per decision with event id, platform and account, chat name, outcome, urgency, rule id, model, and latency, and without message text.
5. The Triage Agent shall delete decision records older than the retention period (90 days by default, configurable) at least hourly, except important decisions not yet passed by every registered downstream consumer.
6. The Triage Agent shall assign decision ids that strictly increase and are never reused, including after deletion.
7. The decision log shall live in the same archive as the messages so that archive encryption applies to it.

### Requirement 10: Hand-off to notifier and action-runner
**Objective:** As a downstream developer, I want a durable, ordered feed of important verdicts that my feature reads at its own pace, so that a crash or restart never loses or floods notifications.

#### Acceptance Criteria
1. The Triage Agent shall provide a hand-off feed of important event decisions that any named downstream consumer can register for, read in decision id order, and acknowledge, with a persistent position per consumer.
2. When a downstream consumer registers for the first time, the Triage Agent shall start it after the newest existing decision unless it requests to start from the beginning.
3. The Triage Agent shall deliver each hand-off record at least once per consumer and shall redeliver records not yet acknowledged.
4. The hand-off feed shall include only decisions whose verdict is important and whose kind is event; replays and not-important decisions shall never appear in it.
5. Each hand-off record shall contain the decision id, event id, message id, creation time, matched rule id, outcome type, the full verdict, and the source (platform, account, chat id, chat name, chat type, sender name, message time, and a text excerpt of up to 280 characters), or no source when the message no longer exists.
6. When a verdict has a suggested action, the hand-off record shall carry the action id and parameters exactly as validated by the Triage Agent, and downstream consumers shall still validate them before execution.
7. If a consumer name is invalid or unknown, or an acknowledgement is out of range, the Triage Agent shall reject the call with a categorized error and change nothing.
8. The Triage Agent shall provide a status per downstream consumer with its position, the number of pending important decisions, and the last acknowledgement time.
9. The hand-off feed and the feedback entry point shall be usable from any khipuchat process that opens the archive, without loading query surfaces or model clients.

### Requirement 11: User feedback
**Objective:** As the user, I want to mark a decision as not important (or important), so that my judgment is recorded next to the agent's for later rule tuning.

#### Acceptance Criteria
1. The Triage Agent shall accept feedback of `not_important` or `important` for a decision id, with a source of `notifier` or `cli`.
2. When feedback is recorded, the Triage Agent shall store the value, source, and time on the decision and report the previous feedback value, if any.
3. When feedback is recorded again for the same decision, the Triage Agent shall keep only the latest value.
4. If the decision id does not exist or the value is not accepted, the Triage Agent shall return a categorized error and change nothing.
5. The Triage Agent shall not change rules, past verdicts, or the hand-off feed as a result of feedback.

### Requirement 12: `khipu triage` command family
**Objective:** As the operator, I want commands to test rules, replay a message, and inspect decisions, so that I can tune triage safely.

#### Acceptance Criteria
1. When the operator runs `khipu triage test --rules`, the Triage Agent shall validate the rules file, print every problem, and exit with status 1 when invalid and 0 when valid.
2. When the rules test runs, the Triage Agent shall print warnings for mapped action ids not in the available action list and for rules naming a specific Slack chat that is not in that Slack account's watch list, explaining that such chats are read less often.
3. When the operator runs the rules test with message ids or a count of recent messages, the Triage Agent shall show for each message the matched rule, applied policy, and whether a model would be asked, without calling a model and without storing anything.
4. When the operator runs `khipu triage replay <message-id>`, the Triage Agent shall evaluate that archive message with the current rules, presence, and model, and print the new verdict next to the stored decision for that message when one exists.
5. Unless the operator asks to save a replay, the Triage Agent shall not store replay results; a saved replay shall be stored as kind replay referencing the original decision and shall never enter the hand-off feed.
6. Where the operator asks for a rules-only replay, the Triage Agent shall not call a model and shall show what the rules alone decide.
7. When the operator runs `khipu triage log`, the Triage Agent shall list recent decisions, newest first, with filters for important only, rule id, and a limit (default 20).
8. When the operator runs `khipu triage show <decision-id>`, the Triage Agent shall print the full decision including reason, presence summary, model details, notes, and feedback.
9. When the operator runs `khipu triage status`, the Triage Agent shall print whether triage is enabled, the rules file and version, the model provider and destination, the triage consumer lag, decision counts by outcome for the last 24 hours, and the status of every downstream consumer.
10. When the operator runs `khipu triage feedback <decision-id> <not-important|important>`, the Triage Agent shall record feedback with source `cli`.
11. Where any `khipu triage` command accepts `--json`, the Triage Agent shall print machine-readable output with the same fields as the human output.
12. If a command receives an unknown message or decision id, the Triage Agent shall print a clear error and exit with status 1.

### Requirement 13: Compatibility and privacy
**Objective:** As the user, I want triage to add capability without changing existing behavior or widening exposure.

#### Acceptance Criteria
1. While no triage rules file exists, the sync daemon, `khipu ask`, MCP tools, CLI queries, and the web UI shall behave exactly as before this feature.
2. The Triage Agent shall not depend on Beeper and shall not add a new third-party package.
3. The Triage Agent shall not send any message on any platform and shall not deliver notifications itself.
4. The Triage Agent shall make no network call other than model calls made through the model client.
5. The Triage Agent shall never write message text, model answers, or presence details to logs.
