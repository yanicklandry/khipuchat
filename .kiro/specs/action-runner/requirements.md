# Requirements Document

## Project Description (Input)
Being notified is only half the job. For known patterns (a new `#08-expedition` transaction in Slack means "generate a new ADV report"), the user wants the assistant to start the work, not just remind them. Priority P3: planned now, may never be built.

Today nothing executes actions. triage-agent can emit `suggested_action { id, params }` chosen from an allowlisted catalog that it reads through a seam this feature fills; notifier can show a "Do it" button for suggested actions that a second seam (also filled by this feature) allows, records the user's press as an approval in a durable approval feed, and accepts notification requests from other modules.

The action-runner should provide a registry of allowlisted actions, each a named, operator-configured command with typed parameters extracted from the message (for example a transaction id or a date). An action runs only when its policy allows: `ask-first` (default: the user taps "Do it" in the notification) or `auto` (explicitly enabled per action). Commands are executed without a shell, with validated parameters passed as separate arguments or environment variables and never string-interpolated into a command line, under a timeout. Every run is logged (decision, action, parameters, who approved, status, output excerpt) and its result (success, output link, error) is reported back through the notifier. When a tool only exists on the user's Mac, the run can be queued for a small agent on the Mac to pull (optional later milestone).

Constraints: the model can only choose among allowlisted action ids and fill schema-validated parameters; it can never supply a command. The default policy is ask-first; auto is opt-in per action. No action posts to Slack or any other messaging platform. No Beeper dependency. The ADV report generator itself is the user's existing tooling, invoked and not reimplemented; what it is concretely (tool, inputs, where it runs) is not yet known and is recorded as an open question.

## Introduction
The action-runner is the "do it" step after triage and notification. It owns the list of actions the user has allowed, tells triage which actions exist and tells the notifier which suggestions may offer a "Do it" button, turns approved or auto-eligible suggestions into runs, executes each run's preconfigured command safely, keeps a run log, and reports each result to the user through the notifier. It never decides importance, never chooses actions, never delivers notifications itself, and never runs anything that was not configured by the operator in advance.

## Boundary Context
- **In scope**: the action configuration file and its validation; the parameter schema subset and parameter validation; the read-only action list given to triage; the decision of which suggestions offer a "Do it" button; consuming important verdicts as the consumer `action-runner`; consuming user approvals as the consumer `action-runner`; ask-first and auto policies with per-action safety limits; safe command execution with timeout and bounded output; the run log and its retention; result notifications through the notifier; the `khipu action` command family; an optional laptop execution path (server queue plus a pull agent on the Mac); operator documentation and an example configuration.
- **Out of scope**: deciding importance or which action applies (triage-agent); notification delivery, buttons, callback links, and recording approvals (notifier); the ADV report generator or any other tool the actions invoke; commands, scripts, or shell text produced by a model; multi-step or chained agent workflows; actions that send or post messages on Slack or any other messaging platform; reading or changing the presence laptop reporter.
- **Adjacent expectations**: triage-agent publishes important verdicts with an optional suggested action and asks this feature for the current action list; notifier asks this feature whether a suggestion may offer "Do it", records an approval only after the user's accepted press, and delivers notification requests queued by this feature; the ingress authenticates every request before it reaches this feature's laptop routes and hands this feature its environment through the ingress context; the operator installs the commands that actions reference on the host where they run; message-events' daemon services list starts and stops this feature with the sync daemon (signal shutdown versus single pass decided by the daemon's mode), and its shared daemon wiring, which this feature fills, hands this feature's action list and "Do it" answers to triage, the notifier, and their command-line entries (the upstream defaults stay empty), and its schema registry creates this feature's table when the archive opens; cloud-deployment's data file resolver places the default action configuration next to the archive; presence-context's shared LaunchAgent helper schedules the laptop agent.

## Open Questions
- **OQ-1: What is ADV report generation concretely?** The tool or CLI, its inputs (which values from the `#08-expedition` message it needs, their formats), its outputs (file, link, upload destination), the credentials it needs, and where it can run (inside the server container or only on the user's Mac) are unknown. Until the user answers, the feature ships a generic registry; `adv-report` appears only as a disabled example with a placeholder command. Choosing its real command, its parameter patterns, and its execution host, and deciding whether the laptop path (Requirement 12) is needed at all, are gated on this answer.

## Requirements

### Requirement 1: Action configuration
**Objective:** As the operator, I want to declare the allowed actions in one configuration file that is checked strictly, so that only commands I set up in advance can ever run.

#### Acceptance Criteria
1. The Action Runner shall read action definitions only from the operator's action configuration file, at a default location that the operator can override.
2. The Action Runner shall accept for each action: a unique id, a one-line description, an absolute command path, an argument template list, a parameter schema, a policy (`ask-first` or `auto`), a timeout, an execution host (`server` or `laptop`), and optional working directory, literal environment values, environment pass-through names, enabled flag, hourly run limit, duplicate window, approval age limit, offer age limit, auto eligibility source, and result reporting level.
3. When an action omits its policy, the Action Runner shall treat the action as `ask-first`.
4. If the configuration file is invalid, then the Action Runner shall report every problem with the action id and field it concerns and shall treat the configuration as containing no actions.
5. If an action id does not match the pattern of lowercase letters, digits, and hyphens starting with a letter (at most 64 characters), or duplicates another id, then the Action Runner shall reject the configuration.
6. If an action's command is not an absolute path, or an argument template references a parameter the action does not declare, then the Action Runner shall reject the configuration.
7. If an action asks to pass through an environment variable that is a known khipuchat secret or credential name, then the Action Runner shall reject the configuration.
8. When the configuration file changes while khipuchat is running, the Action Runner shall use the new definitions within one check interval without a restart.
9. If a changed configuration file is invalid or missing, then the Action Runner shall keep using the last valid definitions and shall log one line saying so per change.
10. When an action is marked disabled, the Action Runner shall not offer it, run it, or list it to triage.
11. If no configuration file exists, or the operator disables the feature, then the Action Runner shall not start, shall log one line saying why, and shall leave the verdict and approval feeds untouched.

### Requirement 2: Parameter schema and validation
**Objective:** As the operator, I want each action's parameters described by a small, strict schema and checked before every run, so that a message or a model can never smuggle unexpected values into a command.

#### Acceptance Criteria
1. The Action Runner shall accept a parameter schema only when it is an object whose every property is required, which allows no extra properties, and whose properties are strings, integers, numbers, or booleans, with at most 10 properties.
2. The Action Runner shall require every string parameter to declare either a fixed list of allowed values or a pattern anchored at both ends, and shall cap string values at a declared or default maximum length of 256 characters.
3. If a parameter schema uses nested objects, arrays, combinators, or keywords outside the supported set, then the Action Runner shall reject the configuration with a problem naming the keyword.
4. Before any run is queued, executed, or sent to the laptop, the Action Runner shall validate the run's parameters against the action's current schema.
5. If parameters are missing, extra, of the wrong type, out of range, outside the allowed values, too long, or fail the pattern, then the Action Runner shall not execute the run and shall record it as rejected with the failing parameter names.
6. If a string parameter value contains a control character, then the Action Runner shall reject the run.
7. If a string parameter fills an entire argument and its value starts with a hyphen, then the Action Runner shall reject the run, so that a value cannot be read as a command option.

### Requirement 3: Action list for triage and Do it offers for notifications
**Objective:** As the user, I want triage to know which actions exist and the notifier to offer "Do it" only for actions that will actually ask me first, so that suggestions and buttons match what can really happen.

#### Acceptance Criteria
1. When triage asks for the available actions, the Action Runner shall return the id, description, and parameter schema of every enabled action, and nothing else.
2. While the action configuration is invalid or absent, the Action Runner shall return an empty action list to triage.
3. When the notifier asks whether a suggested action may offer "Do it", the Action Runner shall answer yes only when the action exists, is enabled, and its effective policy for that suggestion is ask-first.
4. When the notifier asks about a suggestion whose effective policy is auto, the Action Runner shall answer no, so that the user is not asked to approve something that runs on its own.
5. If answering triage or the notifier fails for any reason, then the Action Runner shall answer with no actions or no offer rather than an error.

### Requirement 4: Ask-first approval flow
**Objective:** As the user, I want a suggested action to run only after I tap "Do it", and only if my approval is still fresh and still matches the configured action, so that nothing runs without my consent.

#### Acceptance Criteria
1. While running, the Action Runner shall read important verdicts as the downstream consumer named `action-runner` and act only on verdicts that carry a suggested action.
2. When the verdict consumer or the approval consumer is registered for the first time, the Action Runner shall start from the newest existing record, so that suggestions and approvals made before the feature was enabled never run.
3. When a verdict suggests an action whose effective policy is ask-first, the Action Runner shall record the suggestion as awaiting approval and shall not execute it.
4. While running, the Action Runner shall read user approvals as the downstream consumer named `action-runner`.
5. When an approval arrives for a suggestion awaiting approval, the Action Runner shall queue that run for execution after re-validating the action id against the registry and the parameters against the action's schema.
6. When an approval arrives with no matching suggestion, the Action Runner shall create a new run from the approval and apply the same checks.
7. If an approval was given longer ago than the action's approval age limit (default 1 hour) when the Action Runner processes it, then the Action Runner shall reject it as expired and shall not execute the run.
8. If a suggestion awaiting approval is older than the action's offer age limit (default 24 hours), then the Action Runner shall mark it expired, and an approval arriving for it afterwards shall be rejected.
9. If an approval names an action that is unknown or disabled at processing time, then the Action Runner shall reject it and shall not execute anything.
10. When the same approval is delivered more than once, the Action Runner shall process it at most once.
11. The Action Runner shall never execute an ask-first action without an approval record or an explicit operator command, and shall never treat a missing, unreadable, or rejected approval as consent.
12. When the operator approves a suggestion awaiting approval from the command line, the Action Runner shall treat it as an approval recorded as given by the operator.

### Requirement 5: Auto policy
**Objective:** As the user, I want selected actions to start on their own when triage suggests them, but only those I explicitly opted in and only from sources I trust, so that routine work starts immediately without widening risk.

#### Acceptance Criteria
1. Where an action's policy is `auto`, when a verdict suggests that action, the Action Runner shall queue the run for execution without waiting for an approval.
2. Where an action's policy is `auto` and its auto eligibility source is `rule` (the default), the Action Runner shall run it automatically only for suggestions that come from a triage rule, and shall treat suggestions chosen by the model as ask-first.
3. Where an action's policy is `auto` and its auto eligibility source is `any`, the Action Runner shall run it automatically for suggestions from a rule or from the model.
4. While the operator's global auto switch is off, the Action Runner shall treat every auto action as ask-first.
5. If a verdict with an auto-eligible suggestion is older than the action's approval age limit when the Action Runner first sees it, then the Action Runner shall record the run as expired and shall not execute it.
6. When the same verdict is delivered more than once, the Action Runner shall create at most one run for it.

### Requirement 6: Run safety limits
**Objective:** As the user, I want hard limits on how often and how repeatedly an action can run, so that a burst of messages or a confused model cannot trigger a flood of runs.

#### Acceptance Criteria
1. If starting a run would exceed the action's hourly run limit (default 6 runs per hour), then the Action Runner shall reject the run as rate limited and shall not execute it.
2. If a run has the same action and the same parameter values as another run of that action that is queued, running, or succeeded within the action's duplicate window (default 10 minutes), then the Action Runner shall record it as a skipped duplicate and shall not execute it.
3. The Action Runner shall execute at most one run at a time on each host, and shall execute queued runs in the order they were queued.
4. The Action Runner shall apply the same parameter checks, limits, and duplicate rule to runs started from verdicts, approvals, and the command line.

### Requirement 7: Safe execution
**Objective:** As the operator, I want each run to execute only its preconfigured command, without a shell, with bounded time and output and a minimal environment, so that running an action cannot widen khipuchat's attack surface.

#### Acceptance Criteria
1. The Action Runner shall execute exactly the command path configured for the action, and shall never take a command, a program name, or shell text from a message, a verdict, an approval, a model, or a laptop request.
2. The Action Runner shall start the command without a shell, passing each argument from the action's template as one separate argument in which parameter placeholders are replaced by the parameter's value and never split, joined, or re-parsed.
3. The Action Runner shall additionally provide each parameter to the command as an environment variable with a fixed, documented name derived from the parameter name, together with the run id and action id.
4. The Action Runner shall give the command only a minimal environment (search path, home, language, time zone, temporary directory), the action's literal environment values, and the pass-through variables the action names, and shall never pass khipuchat secrets or credentials.
5. When a run exceeds its timeout (configurable per action, default 300 seconds, at most 3600 seconds), the Action Runner shall stop the command and everything it started, forcibly after a short grace period, and shall record the run as timed out.
6. The Action Runner shall keep at most the last 2000 characters of the command's standard output and of its standard error for the run log, and shall continue the run without stopping it when output exceeds that.
7. When the command prints a result link line or a result summary line in the documented format, the Action Runner shall record the link (https only) and the summary (at most 200 characters) with the run.
8. When the command exits with status 0, the Action Runner shall record the run as succeeded; when it exits otherwise, cannot be started, or its command is missing or not executable, the Action Runner shall record the run as failed with the exit status or the reason.
9. The Action Runner shall run the command in the action's configured working directory, or in a fresh private temporary directory for the run when none is configured.

### Requirement 8: Run log
**Objective:** As the operator, I want every suggestion, approval, and execution recorded with its outcome, so that I can audit what ran, why, and who allowed it.

#### Acceptance Criteria
1. The Action Runner shall record each run with: run id, action id, parameters, source (verdict, approval, or command line), triage decision when known, approval when known, policy applied, who approved (auto, the notification channel, or the operator), execution host, status, status reason, exit status, start and finish times, duration, output excerpts, result link, result summary, and the configuration version used.
2. The Action Runner shall record runs it rejects, skips, or expires with the reason, so that every handled suggestion and approval leaves exactly one traceable record.
3. If khipuchat stops while a run is executing, then on the next start the Action Runner shall mark that run as interrupted and shall not execute it again automatically.
4. When khipuchat restarts, the Action Runner shall continue queued runs and unprocessed verdicts and approvals from where it stopped.
5. The Action Runner shall delete finished run records older than the retention period (default 90 days, configurable) and shall keep records that are still awaiting approval, queued, or running.
6. The Action Runner shall write log lines that name the run id, action id, status, and duration, and shall never write parameter values, command output, or secrets to the process log.

### Requirement 9: Result reporting
**Objective:** As the user, I want to be told how each action I approved or that ran automatically turned out, through my usual notification channel, so that I do not have to check a log.

#### Acceptance Criteria
1. When a run started by an approval, by auto policy, or by the operator finishes (succeeded, failed, or timed out), the Action Runner shall queue exactly one result notification for it through the notifier.
2. When an approval, or a suggestion admitted under auto policy, is rejected or skipped (expired approval or offer, unknown or disabled action, invalid parameters, rate limited, duplicate, or already handled), or a laptop run expires unclaimed, the Action Runner shall queue one notification saying the action did not run and why.
3. The Action Runner shall title each result notification with the action id and outcome, include the duration and the command's result summary when present, and attach the result link as the notification's open link when present.
4. The Action Runner shall never include raw command output, parameter values beyond those in the command's own result summary, or secrets in a result notification.
5. The Action Runner shall use normal urgency for successful runs and high urgency for failed, timed out, interrupted, or rejected runs.
6. Where an action's reporting level is `failures`, the Action Runner shall report only unsuccessful outcomes; where it is `none`, it shall report nothing for that action.
7. If queuing a result notification fails or khipuchat stops before it is queued, then the Action Runner shall retry on its next cycle without ever producing two notifications for the same run.
8. The Action Runner shall not queue notifications for suggestions that were only recorded as awaiting approval, or for verdict suggestions rejected before any approval.

### Requirement 10: Operator commands
**Objective:** As the operator, I want commands to check the configuration, inspect runs, test an action safely, and approve or cancel runs, so that I can set up and supervise actions without reading the database.

#### Acceptance Criteria
1. When the operator runs the check command, the Action Runner shall validate the configuration file, report each problem, report for each server action whether its command exists and is executable on this host, and exit non-zero when any problem exists.
2. When the operator runs the list command, the Action Runner shall show each action with its id, description, policy, effective auto state, execution host, enabled state, and parameters.
3. When the operator runs the log command, the Action Runner shall show recent runs newest first with id, time, action, source, status, and duration, filterable by action and status; and the show command shall display one run's full record including output excerpts.
4. When the operator runs an action from the command line with parameters, the Action Runner shall apply the same validation and limits as any other run, execute it (or queue it for the laptop when its host is the laptop and khipuchat runs on the server), print the outcome, and report it through the notifier.
5. When the operator runs an action with the dry-run option, the Action Runner shall print the exact command path, arguments, and parameter environment it would use, and shall execute and record nothing.
6. When the operator approves a run awaiting approval, the Action Runner shall queue it as in Requirement 4; when the operator cancels a run awaiting approval or queued, the Action Runner shall mark it cancelled and never execute it.
7. If the operator gives an unknown run id, unknown action id, or invalid parameters, then the Action Runner shall print an actionable message and exit non-zero.

### Requirement 11: Daemon lifecycle
**Objective:** As the operator, I want the action-runner to start and stop with the khipuchat sync daemon and to pick up work promptly, so that it needs no separate service.

#### Acceptance Criteria
1. While the sync daemon is running with a valid action configuration, the Action Runner shall check for new verdicts, approvals, and queued runs every 5 seconds by default, with the interval configurable by the operator.
2. When the daemon shuts down on a signal, the Action Runner shall start no new work (no new verdicts, approvals, or queued runs), stop a running command and everything it started, record it as interrupted, and finish within 15 seconds.
3. When the daemon runs a single pass, the Action Runner shall process pending verdicts, approvals, and queued runs on its host until none remain or its time bound (the 120 seconds the daemon gives it) is reached, before the daemon exits; this pending-work processing shall happen only in a single pass, never on signal shutdown.
4. If processing one verdict or approval fails unexpectedly, then the Action Runner shall retry it on the next cycle, and after three failures shall record it as rejected with an internal error and move past it.

### Requirement 12: Laptop execution (optional milestone)
**Objective:** As the user, I want actions whose tool only exists on my Mac to be queued by the server and picked up by a small agent on the Mac, so that the server never needs that tool and never sends the Mac anything to execute other than an action id and parameters.

#### Acceptance Criteria
1. Where the laptop milestone is enabled and khipuchat runs as a server, when a run for an action whose host is the laptop is queued, the Action Runner shall keep it queued for the laptop agent instead of executing it on the server.
2. While khipuchat runs locally on the Mac, the Action Runner shall execute laptop actions in the local daemon like server actions.
3. When the laptop agent asks for work through the authenticated ingress, the Action Runner shall hand out at most one queued laptop run per request, giving only the run id, action id, and validated parameters, and shall mark it as claimed by that agent.
4. The laptop agent shall execute only actions defined in the Mac's own action configuration with the laptop as host, shall re-validate parameters against its own schema, and shall reject any run whose action it does not define.
5. When the laptop agent reports a result, the Action Runner shall record it on the run and report it as in Requirement 9; a report for a run not claimed by that agent shall be refused.
6. If a queued laptop run is not claimed within the claim limit (default 1 hour), then the Action Runner shall mark it expired and report that the laptop agent did not pick it up.
7. If a claimed laptop run gets no result within its timeout plus a grace period, then the Action Runner shall mark it interrupted and report it.
8. The laptop agent shall run on a schedule under the user's macOS login session, shall refuse plain http to non-loopback hosts, shall keep its access token out of its schedule definition, and shall never log the token.
9. Where the laptop milestone is not enabled, the Action Runner shall expose no laptop routes and shall reject configurations that put an action on the laptop while khipuchat runs as a server, explaining the milestone.

### Requirement 13: Security, privacy, and scope guards
**Objective:** As the user, I want strong guarantees that this feature cannot be turned into a remote shell or a message sender, so that adding automation does not add risk.

#### Acceptance Criteria
1. The Action Runner shall provide no way for a model, a message, a verdict, an approval, a notification callback, or the laptop route to add, change, or name a command; only the operator's configuration file defines commands.
2. The Action Runner shall not send, post, or reply on Slack or any other messaging platform, and shall not use the platform sync sessions or their credentials.
3. The Action Runner shall add no Beeper dependency and no new third-party package.
4. The Action Runner shall store parameters, output excerpts, and result data only in the local archive, and shall send only the result notification content described in Requirement 9 outside the machine.
5. The Action Runner shall keep the triage action list and the notifier offer answers free of side effects: answering them never starts, queues, or records a run.

### Requirement 14: Operator documentation and example
**Objective:** As the operator, I want a guide and a ready example, so that I can configure my first action, including the future ADV report action, without reading code.

#### Acceptance Criteria
1. The Action Runner shall ship an example configuration containing a disabled `adv-report` action with a placeholder command and a placeholder transaction id parameter, clearly marked as waiting for the answer to OQ-1.
2. The Action Runner shall document the configuration format, the parameter schema subset, the argument and environment conventions, the result line format, the policies and limits, the triage rule mapping to an action, where server commands must be installed for a container deployment, the laptop agent setup, and the security model.
3. The Action Runner shall document every setting it reads, with defaults, in the environment template.
