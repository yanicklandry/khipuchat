# Brief: action-runner

## Problem
Being notified is only half the job. For known patterns (a new `#08-expedition` transaction means "generate a new ADV report"), the user wants the assistant to start the work, not just remind them. Low priority (P3): plan now, may never be built.

## Current State
Nothing executes actions. triage-agent (new) can emit `suggested_action { id, params }`; notifier (new) can collect an approval through an action button.

## Desired Outcome
A registry of allowlisted actions, each a named command with typed parameters extracted from the message (e.g. transaction id, date). An action runs only when its policy allows: `ask-first` (default: user taps "Do it" in the notification) or `auto` (explicitly enabled per action). The result (success, output link, error) is reported back through notifier and logged.

## Approach
`actions` config: `{ id: 'adv-report', command: '<user-provided script/CLI>', params schema, policy: 'ask-first' | 'auto', timeout, runs_on: 'server' | 'laptop' }`. Runner executes with `execFile` (no shell), parameters passed as validated args/env, never string-interpolated. `action_runs` table (decision id, action id, params, approved_by, status, output excerpt). Laptop-side actions are queued for a small agent on the Mac to pull (reuses the presence laptop agent channel) when the tool only exists there. The ADV report generator itself is the user's existing tooling, invoked, not reimplemented.

## Scope
- **In**: action registry + param schema validation, approval flow wiring (notifier callbacks), safe execution with timeout, run log, result notification, laptop pull-queue (optional milestone).
- **Out**: implementing the ADV report generator, free-form LLM-generated shell commands (never allowed), multi-step agent workflows, actions that post to Slack or other platforms.

## Boundary Candidates
- Registry + param validation
- Approval policy + execution sandbox
- Run log + result reporting

## Out of Boundary
- Deciding which action applies (triage-agent), delivery (notifier).

## Upstream / Downstream
- **Upstream**: triage-agent, notifier, cloud-deployment, presence-context (laptop agent channel).
- **Downstream**: none planned.

## Existing Spec Touchpoints
- **Extends**: none (new module).
- **Adjacent**: security-hardening (execution must not widen attack surface; callbacks signed and single-use).

## Constraints
- The LLM can only choose among allowlisted action ids and fill schema-validated params; it can never supply a command.
- Default policy is ask-first; `auto` must be opted in per action.
- Open question for design: what "ADV report" generation is concretely (tool, inputs, where it runs). Needs user input before requirements.
