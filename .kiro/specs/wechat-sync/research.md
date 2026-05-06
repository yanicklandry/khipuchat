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
