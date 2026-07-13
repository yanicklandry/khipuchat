# Research & Design Decisions

**Feature**: `email-sync`
**Discovery Scope**: Extension — new platform adapter using imapflow

**Key Findings**:
- `imapflow` provides a clean async API: `client.connect()`, `client.getMailboxLock(path)`, `client.fetch(range, { envelope: true, bodyStructure: true, source: true })` with UID-based ranges.
- `Message-ID` header is the natural deduplication key (external_id). `In-Reply-To` provides the parent link.
- Thread root identification: messages with no `In-Reply-To` header (or whose `In-Reply-To` value is not in the local DB) are thread roots; they own the chat record.
- `'email'` is NOT currently in the Platform union — must be added to `src/platforms/types.ts`.
- Chat ID: `hashStr(threadRootMessageId)` — stable, matches iMessage/WeChat/Discord pattern.

## Design Decisions

### Decision: Two-phase thread resolution
- Phase 1: fetch all messages from both folders, store all as individual records with `reply_to_external_id`.
- Phase 2: assign `chat_id` — group by thread root via a `Map<messageId, chatId>` built during insertion.
- Thread root detection: if `In-Reply-To` is absent, the message IS the root (`chatId = hashStr(messageId)`). If present, look up parent's chatId in the map; if parent not seen yet, treat this message as a new root (handles out-of-order fetch).
- This approach avoids a second DB pass and handles partial syncs correctly.

### Decision: imapflow UID range batching
- Use `'1:*'` range with `{ uid: true }` to get all UIDs, then slice into batches of 200.
- `imapflow`'s `client.fetch()` accepts a UID set or range string.

### Decision: Injectable IMAP client for testing
```typescript
interface EmailClient {
  fetchFolder(folder: string): AsyncIterable<RawEmailMessage>
}
```
Tests provide a mock returning fixture `RawEmailMessage` objects — no real IMAP connection in tests.

## Risks & Mitigations
- **Sent folder name varies** (Sent, Sent Items, Sent Messages): try common names; fall back to listing mailboxes and finding a folder with `\Sent` special-use flag.
- **Large mailboxes**: batch of 200 messages; memory is bounded.
- **Message-ID absent**: rare but possible; skip the message and log a warning.

---

# Implementation Gap Analysis

**Date**: 2026-07-12
**Method**: Codebase inspection across `src/platforms/email/`, `src/platforms/types.ts`, `src/account-registry.ts`, `src/sync-all.ts`, `src/sync-runner.ts`, `tests/email.test.ts`, `package.json`.

## Executive Summary

The email-sync feature is **substantially complete**. Both implementation files exist and all 20 unit tests pass. The one remaining gap is a **credential key name mismatch** in the legacy env-var registry path — a one-line fix in `account-registry.ts` plus removal of the unused `IMAP_PORT` entry.

## What Already Exists

| Component | File | Status |
|---|---|---|
| IMAP client | `src/platforms/email/client.ts` | Complete |
| Sync adapter | `src/platforms/email/sync.ts` | Complete |
| Platform union | `src/platforms/types.ts` line 4 | `'email'` present |
| npm script | `package.json` | `sync:email` registered |
| sync-all inclusion | `src/sync-all.ts` | `email` in `PLATFORMS` |
| Unit tests | `tests/email.test.ts` | 20/20 passing |
| imapflow dep | `package.json` | `^1.3.3` installed |

The implementation covers: batched folder fetching (200 per batch), `listSpecialFolder('\\Sent')` with fallback names, thread resolution via in-memory Map, `is_sender` from case-insensitive From match, incremental sync with IMAP SEARCH `since`, and mocked-client test suite.

## Gap: LEGACY_ENV_VARS Key Name Mismatch

### Location
`src/account-registry.ts` line 36:

```typescript
email: ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS'],
```

### Problem
`createEmailAdapter` reads `credentials.fields['EMAIL_IMAP_HOST']`, `credentials.fields['EMAIL_IMAP_USER']`, `credentials.fields['EMAIL_IMAP_PASS']`. The requirements mandate these exact names. The legacy registry maps different keys (`IMAP_HOST` etc.), so `runAllAccountsSync('email', createEmailAdapter, ...)` in a no-config-file environment would silently pass empty credentials and exit with "missing variables".

`IMAP_PORT` is also dead: `client.ts` hardcodes port 993 and never reads it from credentials.

### Impact scope
- `npm run sync:email` and `npm run sync` are **not affected** (both bypass the registry by reading env vars directly or spawning subprocesses).
- Only `runAllAccountsSync` in a legacy-registry context is affected.

### Fix
```typescript
// account-registry.ts line 36 — change:
email: ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS'],
// to:
email: ['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS'],
```

Also update `tests/account-registry.test.ts` lines 65-70 to use the corrected env var names.

## Requirements Coverage

| Requirement | Implemented |
|---|---|
| `EMAIL_IMAP_HOST/USER/PASS` only | Yes (sync.ts reads these directly) |
| Exit on missing vars with list | Yes (process.exit(1)) |
| INBOX sync | Yes |
| Sent folder sync | Yes |
| Batch 200 messages | Yes |
| `Message-ID` as `external_id` | Yes |
| Display name from `From` | Yes |
| Plain-text only; skip if absent | Yes |
| `In-Reply-To` as `reply_to_external_id` | Yes |
| `platform = 'email'` | Yes |
| `is_sender` from `EMAIL_IMAP_USER` | Yes (case-insensitive) |
| One chat per thread root | Yes |
| All replies under same `chat_id` | Yes |
| Chat name from subject | Yes |
| `npm run sync:email` | Yes |
| Idempotency | Yes (upsert on `external_id`) |
| Tests with mocked IMAP client | Yes (20 tests) |

## Recommendation

Single fix needed: align `LEGACY_ENV_VARS.email` in `account-registry.ts` and its test. All other work is complete. Proceed to `/kiro-validate-impl email-sync` after applying the fix.

---

# Implementation Gap Analysis (Re-run)

**Date**: 2026-07-13
**Method**: Fresh codebase inspection — `src/platforms/email/sync.ts`, `src/platforms/email/client.ts`, `tests/email.test.ts`, `src/account-registry.ts`.

## Status of Previous Gap

The `LEGACY_ENV_VARS.email` key mismatch identified on 2026-07-12 **is still unresolved**. `src/account-registry.ts` line 36 still reads:

```typescript
email: ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS'],
```

Required fix (same as before):
```typescript
email: ['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS'],
```

## New Gap: No-Plain-Text Messages Not Skipped

### Location
`src/platforms/email/sync.ts` lines 77-78, inside `processFolder`.

### Problem
Requirement 3, AC3 states: "if a message has no plain-text part, the Email Sync shall skip it without error."

The current code always calls `insertMessage(mapMessage(raw, chatId, userEmail))`. When `raw.text` is `null`, `mapMessage` produces `{ text: null, type: 'other' }` and the message is inserted into the DB rather than skipped.

### Fix
Add a guard before `insertMessage`:

```typescript
const mapped = mapMessage(raw, chatId, userEmail)
if (mapped.text === null) continue   // Req 3 AC3: skip messages with no plain-text part
insertMessage(mapped)
totalMessages++
```

Note: the `totalMessages++` must also move inside the guard so the count stays accurate.

### Test Coverage
`tests/email.test.ts` has a `mapMessage` test verifying `type: 'other'` when text is null, but no integration test verifying the message is **skipped**. A test should be added:

```typescript
it('skips messages with no plain-text part', async () => {
  const noText = makeRaw({ messageId: 'no-text@ex.com', text: null })
  const client = makeMockClient([noText])
  await runBackfillImpl(client, 'user@ex.com')
  // chat is created for the thread root but no message should be stored
  // (or verify via getMessages if exported)
  expect(getChats()).toHaveLength(0)
})
```

## Open Questions

- Should the chat record also be suppressed when the only message in a thread has no plain-text part? The requirement does not specify. Conservative interpretation: skip the message; suppress the chat only if it would otherwise be empty.

## Updated Recommendation

Two fixes needed before marking implementation fully compliant:

1. **`account-registry.ts` line 36**: align `LEGACY_ENV_VARS.email` key names.
2. **`sync.ts` `processFolder`**: skip insertion when `raw.text` is null; add a corresponding test.

Run `/kiro-validate-impl email-sync` after both are applied.

---

# Design Refresh & Synthesis (2026-07-13)

**Trigger**: `/kiro-spec-design email-sync` re-run in merge mode against the live implementation. `design.md` (originally 2026-05-06) was rewritten to match the code that now exists and to encode the two open gaps as explicit design commitments.

## Synthesis Outcomes

- **Generalization**: incremental sync is not a separate code path but the backfill pipeline parameterized by `EmailSearchCriteria { since }`. `syncIncremental` and `runBackfill` share `runBackfillImpl`; the client narrows the fetch via IMAP `SEARCH since`. One interface, one implementation.
- **Build vs. adopt**: adopt RFC 5322 `Message-ID` / `In-Reply-To` headers for identity and threading rather than parsing `References`; reuse `hashStr` (FNV-1a), `runPlatformSync`, `upsertChat` / `insertMessage`, and the embedding re-index helpers rather than reimplementing. Only `imapflow` is new.
- **Simplification**: two files (`client.ts` protocol I/O, `sync.ts` domain). The `EmailClient` seam has one real implementation plus the test mock; the indirection is justified solely by testability without a live IMAP connection, so it stays.

## Design-vs-Implementation Divergences the refreshed design now asserts

1. **Req 3.3 (skip no-plain-text)**: `design.md` specifies a `raw.text === null` guard between `mapMessage` and `insertMessage`, with the message counter incremented only on actual insertion. Current `sync.ts` `processFolder` still inserts unconditionally. **Design is now the source of truth; code must be brought into line.**
2. **`account-registry.ts` legacy keys**: `design.md` records `LEGACY_ENV_VARS.email = ['EMAIL_IMAP_HOST', 'EMAIL_IMAP_USER', 'EMAIL_IMAP_PASS']` (no `IMAP_PORT`). Current line 36 still uses the wrong `IMAP_*` keys.

Both are covered by the earlier gap analyses above; the refreshed design makes them non-optional. Resolve via `/kiro-validate-impl email-sync` (or a targeted `/kiro-impl` pass) rather than re-implementing from scratch.
