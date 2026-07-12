# Research & Design Decisions

---
**Feature**: `wechat-sync`
**Discovery Scope**: Extension — follows the established iMessage adapter pattern
**Key Findings**:
- WeChat Mac stores per-contact/per-group messages in individual `Chat_<contactId>.db` SQLite files; the table name inside each file mirrors the filename prefix.
- The `WCDB_Contact.db` file holds wxid → display name mappings; contact resolution is simpler than iMessage (no system address book involved).
- `better-sqlite3` (already a project dependency) is sufficient for unencrypted DBs; WeChat Mac SQLCipher encryption has no static key derivation formula — key extraction requires process memory introspection (Frida), which is not viable for a standalone sync tool.

---

## Research Log

### WeChat Mac DB Structure
- **Context**: Need to understand file layout before designing the discoverer.
- **Sources Consulted**: WeChat forensics blog (blog.imipy.com), brief.md, iMessage adapter for pattern reference.
- **Findings**:
  - Container root: `~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/`
  - User hash directory (UUID-like) under the container root — one per WeChat account.
  - Message DBs: `<hash>/Message/Chat_<contactId>.db` — one per contact or group.
  - Table name inside each DB: `Chat_<contactId>` (matches the filename prefix).
  - Contact DB: `WCDB_Contact.db` — typically in `<hash>/` or `<hash>/Contact/`; design searches for it recursively to be robust.
  - Key columns in `Chat_<contactId>`: `MesSvrID` (INTEGER, server message ID), `CreateTime` (INTEGER, Unix seconds), `Message` (TEXT, nullable for media), `Des` (INTEGER, 0=sent by me/1=received).
- **Implications**: Discoverer must recursively glob `Chat_*.db` files; table name is derived from filename; `CreateTime` is already Unix seconds (no epoch offset needed, unlike iMessage Cocoa timestamps).

### SQLCipher / WCDB Encryption
- **Context**: Brief mentions databases "may use SQLCipher encryption with a key derived from the user's local WeChat installation."
- **Sources Consulted**: blog.imipy.com (reverse engineering WeChat macOS), brief.md.
- **Findings**:
  - WeChat Mac uses WCDB (Tencent's SQLite wrapper) which can enable SQLCipher.
  - The key is set in-process via `setCipherKey` on a singleton `DBEncryptInfo.m_dbEncryptKey` object.
  - No static formula exists for deriving this key from user metadata (contrast: Android uses `MD5(IMEI+UIN)[:7]`).
  - Extracting the key requires attaching to the running WeChat process (e.g., via Frida).
  - Many Mac WeChat installations do not enable SQLCipher; encryption is optional.
  - If encrypted, `better-sqlite3` throws `SQLITE_NOTADB` ("file is not a database") when opened without a key.
- **Implications**: Attempt open without key (covers unencrypted case). On `SQLITE_NOTADB`, log a diagnostic identifying the file and skip. Do NOT add `@journeyapps/sqlcipher` or process-injection code. Document this limitation clearly in error messages.

### Contact Resolution Strategy
- **Context**: Need display names for `sender_name` and chat `name` fields.
- **Sources Consulted**: iMessage contacts.ts, WeChat forensics sources, brief.md.
- **Findings**:
  - WCDB_Contact.db contains a contacts table (commonly `WCContact`) with columns `m_nsUsrName` (WeChat ID) and `m_nsNickName` (display name).
  - WeChat contacts are not in the macOS system address book — the iMessage 3-tier fallback (AddressBook → Swift Contacts → raw) does not apply.
  - If WCDB_Contact.db is missing or locked, falling back to the raw contactId is the only option.
- **Implications**: Single-strategy resolution (2 tiers: WCDB_Contact.db → raw ID). Simpler than iMessage.

### Dependency Decision
- **Context**: Whether to add any new runtime dependencies.
- **Findings**: `better-sqlite3` already covers all DB operations. `readdirSync`/`statSync` (already used in `contacts.ts`) covers filesystem traversal. No `glob` package needed.
- **Implications**: Zero new runtime dependencies.

---

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks | Notes |
|--------|-------------|-----------|-------|-------|
| Follow iMessage pattern | Multi-DB iteration of the existing openDb → map → upsert loop | Zero new abstractions, consistent codebase | None | **Selected** |
| Unified DB adapter factory | Abstract pattern over all local-SQLite adapters | Reduces duplication if 3+ adapters | Premature generalization for 2 adapters | Rejected — YAGNI |

---

## Design Decisions

### Decision: SQLCipher — Attempt Without Key, Warn and Skip on Failure

- **Context**: Requirement 5 asks to attempt local key derivation; Mac WCDB has no static key formula.
- **Alternatives Considered**:
  1. Add `@journeyapps/sqlcipher` — native dependency, build complexity, still needs key material.
  2. Frida process injection — requires WeChat running, fragile, invasive.
  3. Try without key → warn on SQLITE_NOTADB → skip (selected).
- **Selected Approach**: Open with `better-sqlite3 { readonly: true }`. Catch `SQLITE_NOTADB` error. Log a message naming the file and explaining likely encryption. Skip the file.
- **Rationale**: Most Mac WeChat users are unencrypted. This covers the common case with no added complexity. The error message satisfies Req 5.2. Req 5.1's "attempt" is satisfied by the open call itself.
- **Trade-offs**: Encrypted DBs are silently skipped (with a logged warning). Users with encrypted installations lose WeChat history. Acceptable given the alternative complexity.
- **Follow-up**: If encrypted DBs become a common user complaint, evaluate a Frida-based companion utility as a separate spec.

### Decision: contactId Derivation from Filename

- **Context**: Need a stable string key (contactId) and a numeric chat ID from each `Chat_<contactId>.db` filename.
- **Selected Approach**: Extract `contactId = basename.replace(/^Chat_/, '').replace(/\.db$/, '')`. Derive `chatId = hashStr(contactId)` using the same FNV-1a algorithm as iMessage's `hashGuid`. Chat type: `contactId.endsWith('@chatroom')` → `'group'`, else `'private'`.
- **Rationale**: Stable, deterministic, zero DB reads needed for the identifier. Same hash algorithm as iMessage keeps the codebase consistent.

### Decision: No New Runtime Dependencies

- **Context**: Whether to add `glob`, `fast-glob`, or SQLCipher libraries.
- **Selected Approach**: Use `readdirSync` + recursive traversal (Node built-ins only). No SQLCipher.
- **Rationale**: Existing code already uses `readdirSync` for directory traversal. Adding a glob library for a single use case would be over-engineering.

---

## Risks & Mitigations

- **WCDB_Contact.db schema undocumented** — Exact table/column names may differ across WeChat versions. Mitigation: `contacts.ts` wraps the query in try/catch and falls back to raw IDs on any error.
- **Encrypted installations lose history** — No viable static key derivation for Mac. Mitigation: clear error message with actionable guidance; track as known limitation.
- **WeChat running while syncing** — DBs may be locked. Mitigation: `readonly: true` opens work with SQLite WAL mode (allows concurrent readers). Non-WAL mode may still fail — caught and skipped per Req 1.4.
- **Multiple WeChat accounts** — Container may have multiple hash directories. Mitigation: recursive glob finds Chat_*.db under all of them.

---

## References

- [Reverse Engineering WeChat on macOS: Building a Forensic Tool](https://blog.imipy.com/post/reverse-engineering-wechat-on-macos--building-a-forensic-tool.html)
- `src/platforms/imessage/sync.ts` — structural template for the WeChat adapter
- `src/platforms/imessage/contacts.ts` — contact resolution pattern reference

---

# Gap Analysis Update — 2026-07-11

**Discovery Scope**: Brownfield — implementation substantially complete; audit against requirements.

## Analysis Summary

- Implementation is significantly more advanced than the original tasks.md described: it handles both WeChat 3.x (Chat_*.db with MesSvrID/CreateTime/Message/Des) and WeChat 4.x (message_N.db with Msg_<md5> tables, server_id/create_time/message_content, Name2Id, SQLCipher key loading from `.wechat-keys.json`) schemas.
- 74 tests pass across `tests/wechat.test.ts` and `tests/wechat-image.test.ts`. All requirement areas have test coverage.
- One requirements gap identified: `sender_name` is always `null` in `mapMessage` (Req 3.3 requires it be set to the resolved display name).
- `tasks.md` is entirely stale: all tasks show as unchecked but the implementation already exists and is more comprehensive than the tasks described.

---

## Current State Investigation

### What Exists

| File | Status | Notes |
|------|--------|-------|
| `src/platforms/wechat/sync.ts` | Complete | V3 + V4 schemas, encryption, incremental sync, adapter |
| `src/platforms/wechat/contacts.ts` | Complete | contact.db (V4) + WCDB_Contact.db (V3), remark fallback |
| `tests/wechat.test.ts` | Complete | 58 tests: unit + integration + error paths |
| `tests/wechat-image.test.ts` | Complete | 16 tests: image message type handling |
| `src/platforms/types.ts` | Complete | `'wechat'` in Platform union |
| `package.json` | Complete | `sync:wechat`, `setup:wechat` scripts |
| `src/sync-all.ts` | Complete | `'wechat'` included in platform list |
| `scripts/setup-wechat.sh` | Complete | Frida-based key extraction tool |

### Key Implementation Divergences from Original Design

The actual implementation diverged significantly from the initial design, reflecting discoveries made during implementation:

1. **File layout**: WeChat 4.x uses numbered `message_N.db` files (0–11) in `db_storage/message/`, not individual `Chat_<contactId>.db` files. `discoverMessageDbs` reflects this.
2. **Table names**: V4 uses `Msg_<md5(user_name)>` tables alongside a `Name2Id` lookup table, not `Chat_<contactId>` tables directly.
3. **Encryption**: The original design said "try without key, skip on SQLITE_NOTADB." The actual implementation adds key loading from `.wechat-keys.json` written by `scripts/setup-wechat.sh` (Frida-based extraction), covering the encrypted case.
4. **Incremental sync**: `runIncrementalImpl` and `setLastSyncedAt` per chat provide per-chat watermark tracking, not just the platform-level `sync_state` from the original plan.
5. **Sender detection V4**: `real_sender_id` + `Name2Id` + `extractSelfWxid` is used to determine `is_sender` in V4 schema, where the original design only handled the legacy `Des` column.
6. **Container path**: Uses `xwechat_files` layout (`~/Library/.../Data/Documents/xwechat_files/wxid_*`) not the original `Application Support/com.tencent.xinWeChat/` path.

---

## Requirements Feasibility Analysis

### Requirement-to-Asset Map

| Req | Summary | Status | Asset | Notes |
|-----|---------|--------|-------|-------|
| 1.1 | Locate all message databases | **Met** | `discoverMessageDbs` + `findUserDir` | Finds `message_N.db` files; covers multi-DB layout |
| 1.2 | Missing container → install message + exit | **Met** | `validateContainer` (`ENOENT` branch) | |
| 1.3 | FDA denied → Full Disk Access guidance + exit | **Met** | `validateContainer` (permission error branch) | |
| 1.4 | Individual DB error → warn + continue | **Met** | `openWechatDb` returns null; caller skips | |
| 2.1 | Extract all message records | **Met** | `runBackfillImpl` / `runIncrementalImpl` | All rows per table |
| 2.2 | Map: unique ID, timestamp, text, direction | **Met** | `mapMessage` (V3 + V4 paths) | Both schema versions handled |
| 2.3 | Store with platform='wechat' | **Met** | `mapMessage`, `mapChat` | Platform literal hardcoded |
| 2.4 | One chat record per discovered DB table | **Met** | `upsertChat(mapChat(...))` per table | Stable external_id from table name |
| 2.5 | No-text messages stored as type='other' | **Met** | `mapMessage` (non-text → 'other' or 'image') | Image type also handled |
| 3.1 | Read display names from contacts DB | **Met** | `buildWechatContactMap` | Both V3 and V4 contact schemas |
| 3.2 | Contacts DB unavailable → fall back to raw ID | **Met** | Returns empty map; caller falls back to table name | |
| 3.3 | Resolved display name as `sender_name` per message | **Gap** | `mapMessage` returns `sender_name: null` always | Design called for `contactMap.get(contactId) ?? contactId`; not implemented |
| 4.1 | `npm run sync:wechat` | **Met** | `package.json` scripts | |
| 4.2 | No duplicate records on re-run | **Met** | `insertMessage` uses `INSERT OR IGNORE` | Idempotent by external_id + chat_id |
| 4.3 | New messages additive, existing unchanged | **Met** | Per-chat `last_synced_at` watermark | |
| 4.4 | Queryable via MCP platform filter | **Met** | `'wechat'` in Platform union, stored as platform='wechat' | |
| 5.1 | Attempt open locally; no network | **Met** | Key loaded from `.wechat-keys.json` (local file); no network calls | |
| 5.2 | Clear error on decryption failure | **Met** | `openWechatDb` logs specific message on `SQLITE_NOTADB` | |
| 5.3 | Never write to WeChat DBs | **Met** | `{ readonly: true }` on every `new Database(...)` call | |

### Identified Gap

**Req 3.3 — `sender_name` always null**

`mapMessage` unconditionally sets `sender_name: null`. The requirement says: "The WeChat Sync shall use the resolved display name as the `sender_name` on each message." The original design specified `sender_name = row.Des === 0 ? null : (contactMap.get(contactId) ?? contactId)`.

Impact: messages stored without sender name attribution. For private chats the chat name encodes the counterparty name, so search results can still show context. For group chats, it is not possible to know who sent each message from the archive alone.

Risk: Medium — the data is already stored; fixing this requires re-syncing to backfill `sender_name`.

---

## Implementation Approach Options

### Option A: Patch `sender_name` in `mapMessage`

- Extend `mapMessage` to accept the `contactMap` and `userName` from the table/chat context.
- For V3: `sender_name = isSend ? null : (contactMap.get(tableName) ?? tableName)`.
- For V4 group chats: use `senderIdMap.get(real_sender_id)` resolved through `contactMap`.
- Existing callers (`runBackfillImpl`, `runIncrementalImpl`) already have `displayName` and `contactMap` in scope; plumbing is minimal.

Trade-offs:
- Requires adding a `senderName?: string` param to `mapMessage` or passing `contactMap + userName`.
- Requires a `--force` re-sync to populate `sender_name` on already-imported messages.
- Test updates needed to assert `sender_name` values.

### Option B: Leave null and document as known limitation

- `sender_name` for private chats is redundant (the chat name captures it). For group chats it is a real missing piece.
- Low effort, zero migration risk.
- Leaves Req 3.3 unmet.

### Option C: Hybrid — populate `sender_name` for received messages only, null for sent

- `is_sender=1` messages: `sender_name = null` (the user is always "me").
- `is_sender=0` messages: `sender_name = contactMap.get(userName) ?? userName ?? tableName`.
- Closely matches the original design intent and is consistent with how iMessage handles it.
- This is the recommended approach if Req 3.3 must be satisfied.

---

## Effort and Risk

| Dimension | Rating | Justification |
|-----------|--------|---------------|
| Remaining effort (Req 3.3 fix) | S | Pattern is clear; callers already have contactMap in scope; 1–2 hours of changes + tests |
| Risk (Req 3.3 fix) | Low | Pure additive change to `mapMessage`; no schema change; `--force` re-sync needed to backfill |
| Tasks.md staleness | S | Update all task checkboxes to reflect current state; no code change |
| Overall feature readiness | High | 74/74 tests passing; all other requirements met; one gap well-understood |

---

## Recommendations for Design/Implementation Phase

1. **Fix Req 3.3** with Option C: thread `senderName: string | null` into `mapMessage` via `MessageMapOpts`. For `is_sender=0` messages in both V3 and V4, set `sender_name` to the resolved contact display name. Update `runBackfillImpl` and `runIncrementalImpl` callers. Add assertions to existing tests.
2. **Update tasks.md** to mark all implemented tasks complete and add a new task for the Req 3.3 sender_name fix.
3. **No new runtime dependencies** needed. All patterns already exist in the codebase.
