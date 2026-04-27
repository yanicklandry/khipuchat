# KhipuChat

## What this is
Self-hosted Telegram sync daemon + MCP server. Replaces Beeper.
Full spec in SPEC.md.

## Stack
Node 20, TypeScript, GramJS, better-sqlite3, @modelcontextprotocol/sdk, Vitest

## Rules
- NEVER skip tests. Each phase must have passing tests before moving to the next.
- NEVER modify passing tests to make them pass.
- NEVER use any, always type strictly.
- Keep each file under 200 lines. Split if needed.
- All DB operations are synchronous (better-sqlite3 is sync).
- MCP server communicates via stdio only.
- .env is gitignored. Never hardcode credentials.
- After every phase: run `npm test` and confirm green before continuing.

## Test command
npm test

## DB file location
./telegram.db (gitignored)

## Current phase
Update this as you complete phases:
[x] Phase 1 — Config + DB
[x] Phase 2 — Auth wizard  
[x] Phase 3 — Backfill + listener
[x] Phase 4 — MCP server