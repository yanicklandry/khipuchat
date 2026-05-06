# Brief: slack-sync

## Problem
Slack DMs and channel messages are locked in Slack's retention policy and search limits. Users want their own local copy searchable without paying for Slack's export tier.

## Current State
No Slack integration. Platform abstraction is ready.

## Desired Outcome
`npm run sync:slack` fetches all DMs and joined channels the user is a member of, stores them as `platform='slack'` records, and is idempotent.

## Approach
Personal Slack app with a user token (not a bot token) using `im:history` + `mpim:history` + `channels:history` + `groups:history` OAuth scopes. Use Slack Web API via plain fetch (no SDK needed — the API is simple REST). Paginate via `cursor` parameter on `conversations.history`. Map Slack messages to the shared Message schema.

## Scope
- **In**: `src/platforms/slack/sync.ts`, Slack Web API calls (conversations.list, conversations.history), cursor-based pagination, `npm run sync:slack`, env var `SLACK_USER_TOKEN`, tests with mocked Slack API responses, deduplication via message `ts` as external_id
- **Out**: Real-time event subscriptions, sending messages, file/attachment download, Slack workspace admin features

## Boundary Candidates
- Slack API client wrapper — thin typed wrapper around fetch
- Message mapping — Slack message JSON → shared Message interface (handle `subtype` service messages)
- Backfill runner — pagination loop per channel, injectable for testing

## Out of Boundary
- DB schema changes — platform-abstraction owns the schema
- MCP changes — platform filter handles Slack automatically once data is in DB

## Upstream / Downstream
- **Upstream**: platform-abstraction (PlatformAdapter interface, db functions)
- **Downstream**: release (packaged)

## Existing Spec Touchpoints
- **Extends**: src/platforms/types.ts (add 'slack' to Platform union)
- **Adjacent**: src/db.ts — call only exported functions

## Constraints
- User token OAuth only (no bot token — user token gives access to all channels the user is in)
- SLACK_USER_TOKEN in .env
- Respect Slack rate limits: Tier 3 = 50+ req/min for history endpoints
- Slack `ts` field (Unix timestamp as string, e.g. "1512085950.000216") used as external_id
