# Brief: notifier

## Problem
Once a message is judged important, the user must actually be told, on the device they are using, without being spammed. khipuchat has no outbound delivery of any kind.

## Current State
No notification, webhook, SMTP or push code exists. presence-context (new) answers "together / apart, where". cloud-deployment (new) provides authenticated ingress for callbacks.

## Desired Outcome
An important verdict becomes one notification with: source (workspace / channel / sender), a short summary, the AI's reason, the suggested action, and buttons (Open, Do it, Not important). Routing uses presence: together = laptop/desktop channel, apart = phone channel, critical = Pushover priority that bypasses Do Not Disturb. Duplicates and bursts are collapsed; quiet hours respected except critical.

## Approach
`Notifier` interface with channel adapters, plain `fetch`, no SDKs:
- **ntfy** (self-hostable hub, topics per device, action buttons via HTTP actions to the ingress),
- **Pushover** (critical iOS alerts, priority 2 with acknowledgment),
- **Telegram bot** (fallback; khipuchat already knows Telegram, but this is a bot token, separate from the sync session).
Routing policy in config (by urgency x presence x quiet hours). `notifications` table (verdict id, channel, status, sent_at, acked_at). Ingress callback routes `POST /notify/action/:id` (signed, single-use tokens) feeding triage feedback and action-runner approvals. Also used for system alerts (e.g. Slack session token needs re-auth).

## Scope
- **In**: interface + 3 adapters, routing policy, dedupe/rate-limit/quiet hours, delivery log, action-button callbacks, `khipu notify test`, docs.
- **Out**: building a native iOS app / APNs, email or SMS delivery (later candidates), replying on the source platform.

## Boundary Candidates
- Channel adapters (one file each)
- Routing policy (pure function of verdict + presence + time)
- Delivery log + callback handling

## Out of Boundary
- Deciding importance (triage-agent), executing actions (action-runner).

## Upstream / Downstream
- **Upstream**: triage-agent, presence-context, cloud-deployment (ingress).
- **Downstream**: action-runner (approvals), triage-agent (feedback).

## Existing Spec Touchpoints
- **Extends**: none (new module).
- **Adjacent**: security-hardening (callback auth), telegram adapter (do not reuse the user session for sending).

## Constraints
- Notification content leaves the machine via third-party relays (ntfy cloud APNs bridge on iOS, Pushover, Telegram): keep payloads short, configurable redaction.
- Notifications are to the user only; never post on the source platform.
- Secrets in env / config registry, never logged.
