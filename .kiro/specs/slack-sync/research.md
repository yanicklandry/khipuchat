# Gap Analysis — slack-sync

_Generated: 2026-07-12_

---

## Executive Summary

The `slack-sync` adapter is **already fully implemented** in `src/platforms/slack/`. Both files (`client.ts`, `sync.ts`) exist and all 22 unit/integration tests in `tests/slack.test.ts` pass. The `npm run sync:slack` script is wired in `package.json`. This is a **near-zero gap** scenario: the spec was written to describe an adapter that was written ahead of it (or concurrently).

Key findings:

- All five requirements are covered by the existing implementation.
- The `PlatformAdapter` interface is satisfied (`runBackfill`, `syncIncremental`, `startListener` are all present).
- Incremental sync (`oldest` cursor) is implemented and tested.
- Rate limiting (429 + Retry-After + 1200ms pacing) is implemented in `client.ts`.
- Two test scenarios from `tasks.md` are absent: missing-token exit-1 test and 429 retry test for the Slack client.

---

## Codebase Analysis

### Existing Implementation

| File | Status | Notes |
|---|---|---|
| `src/platforms/slack/client.ts` | Complete | `SlackClient` interface, `createSlackClient`, 429 handling, user name cache |
| `src/platforms/slack/sync.ts` | Complete | `mapChat`, `mapMessage`, `runBackfillImpl`, `runIncrementalImpl`, `createSlackAdapter`, `slackAdapter`, `main()` |
| `tests/slack.test.ts` | Mostly complete | 22 tests passing; missing-token and 429 retry scenarios absent |
| `package.json` | Complete | `"sync:slack": "tsx src/platforms/slack/sync.ts"` already present |

### Requirement Coverage

| Requirement | Covered | Evidence |
|---|---|---|
| R1: SLACK_USER_TOKEN only, exit on absence | Yes | `sync.ts:96-101`, `createSlackAdapter` checks `credentials.fields['SLACK_USER_TOKEN']` |
| R2: conversations.list with all types, cursor, skip archived | Yes | `client.ts:51-63` lists `im,mpim,public_channel,private_channel` with `exclude_archived=true`; `sync.ts:55` also checks `conv.is_archived` |
| R3: conversations.history, ts as external_id, timestamp, sender, service messages | Yes | `sync.ts:31-48` — all mappings correct |
| R4: 429 + Retry-After, ~50 req/min pacing | Yes | `client.ts:33-43` — 1200ms pre-request delay + 429 retry |
| R5: npm script, idempotency via upsert | Yes | `insertMessage` uses `upsertChat` + insert-or-ignore semantics from `db.ts` |

### Integration with Shared Infrastructure

The adapter correctly integrates with:
- `runPlatformSync` from `sync-runner.ts` (incremental + backfill mode selection, `sync_state` tracking)
- `upsertChat` / `insertMessage` from `db.ts`
- `embedNewMessages` / `embedNewChats` from `index-embeddings.ts` (called after each conversation)
- `AccountRegistry` via `createSlackAdapter(account, credentials)` factory
- `PlatformAdapter` contract from `platforms/types.ts`

### Minor Gaps vs. tasks.md

1. **Missing test: SLACK_USER_TOKEN absence exits with code 1.**
   - The `createDiscordAdapter` test in `tests/discord.test.ts:281-294` has the pattern: spy on `process.stderr.write` and `process.exit`, call `adapter.runBackfill(db)`, assert exit code 1 and stderr message.
   - `tests/slack.test.ts` does not have an equivalent test for `createSlackAdapter`.

2. **Missing test: 429 retry for Slack client.**
   - `tests/discord.test.ts:232-275` tests 429 retry end-to-end by stubbing `globalThis.fetch`.
   - `tests/slack.test.ts` has no equivalent; the retry logic in `client.ts:36-43` is untested.

3. **`conversations.list` also sets `exclude_archived=true` at URL level** while `sync.ts` checks `conv.is_archived` in code. This is intentional double-protection and not a bug.

4. **`hashStr` is exported from `sync.ts` but not used internally.** It exists for historical reasons (appears to be a legacy helper from early design). It does not break anything.

---

## Implementation Approach

Since the adapter is already complete, the only work remaining is:

### Option A: No additional work (recommended for spec closure)

The existing implementation satisfies all five requirements. Treat the two missing tests as optional polish. Close the spec and proceed to validation.

**Pros**: Zero risk, zero churn. All requirements are met by passing tests.
**Cons**: Two test scenarios from `tasks.md` are absent.

### Option B: Add the two missing tests

Add to `tests/slack.test.ts`:
1. `createSlackAdapter — missing token`: mirrors the Discord pattern, ~15 lines.
2. `rate-limit handling (429 + Retry-After)`: stubs `globalThis.fetch`, verifies retry behavior in `slackFetch`, ~25 lines.

**Pros**: Achieves full `tasks.md` coverage. Provides regression protection for the retry path.
**Cons**: Minor effort (~40 lines of test code). No production code changes needed.

---

## Conclusion

**Recommendation: Option B** — add the two missing tests before closing the spec. The production implementation is complete and correct. Adding these tests brings `tests/slack.test.ts` to parity with the `tasks.md` acceptance criteria and matches the quality bar set by `tests/discord.test.ts`.

No schema changes, no new dependencies, no `src/` modifications are needed.

### Next Steps

- Run `/kiro-spec-design slack-sync` (design already approved — can skip to tasks validation).
- Or proceed directly to `/kiro-validate-impl slack-sync` to verify implementation against all requirements.
- If adding missing tests: implement Option B, then re-run `npm test` to confirm 24/24 pass.
