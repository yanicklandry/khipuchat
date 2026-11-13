# Brief: triage-agent

## Problem
The user receives many messages across workspaces; a few are operationally important. Example: a new transaction posted in Slack `#08-expedition` means a new ADV report must be generated. Today the user only notices by reading Slack. They want an intermediate assistant (Muse Spark, or a local model) to read new messages, take their location into account, and decide what deserves their attention and what should be done.

## Current State
No consumer of new messages exists. message-events (new) provides the durable event stream; llm-provider (new) provides the model; presence-context (new) provides location. `tool-registry.ts` gives read-only archive tools (thread lookup, search) the model can call.

## Desired Outcome
Each new live message is evaluated within ~1 minute of sync. The result is a stored, typed verdict: `{ important: boolean, urgency: 'low'|'normal'|'high'|'critical', reason, suggested_action?: { id, params }, presence_snapshot }`. Important verdicts are handed to notifier (and, if a suggested action is allowlisted, to action-runner). The user can see why every decision was made and replay it.

## Approach
Two stages to keep cost and leakage low:
1. **Rule prefilter (deterministic, local)**: config-defined watch rules (`platform`, `account`/workspace, `chat` e.g. `#08-expedition`, sender, keyword/regex, DM-to-me, mentions) with a default policy (`skip` / `llm` / `always-notify`). Most messages never reach the LLM.
2. **LLM judgment**: for messages the rules escalate, build context (message, recent thread via `dispatchTool`, rule hints such as "transactions here require an ADV report", presence summary: together/apart + place + local time) and call `chatStructured` with the verdict schema. Rules can also map directly to a suggested action without the LLM.
Store every verdict in a `triage_decisions` table (event id, rule matched, model, latency, verdict, user feedback). `khipu triage replay <message-id>` and `khipu triage test --rules` for tuning; user feedback ("not important") captured from notifier callbacks to refine rules later.

## Scope
- **In**: event consumer loop (in the watch daemon process), rule config + matcher, context builder, verdict schema + validation, decisions table + CLI, hand-off interfaces to notifier and action-runner, tests with fake LLM.
- **Out**: delivery mechanics (notifier), executing actions (action-runner), learning/auto-tuning rules from feedback (later), multi-message digest summaries (later candidate).

## Boundary Candidates
- Rule engine (pure, fully unit-testable)
- Context builder (archive + presence)
- LLM judge (prompt + schema)
- Decision store + CLI

## Out of Boundary
- Provider plumbing (llm-provider), event durability (message-events), location ingestion (presence-context).

## Upstream / Downstream
- **Upstream**: message-events, llm-provider, presence-context, tool-registry.
- **Downstream**: notifier, action-runner.

## Existing Spec Touchpoints
- **Extends**: none directly (new module), consumes ollama-mcp's tool registry.
- **Adjacent**: semantic-search (could later be used for "similar past important messages" context).

## Constraints
- Only messages escalated by rules may be sent to a cloud LLM; rules can force local-only (Ollama) per source.
- LLM failure must degrade safely: rule-level `always-notify` still fires; LLM errors produce a "could not triage" notification for high-priority rules rather than silence.
- Idempotent per event (at-least-once delivery from message-events).
- TS strict, files under 200 lines.
