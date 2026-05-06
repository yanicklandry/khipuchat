# Brief: wechat-sync

## Problem
WeChat is a primary messaging platform for many users but has no export API and no official desktop history sync. Users want their WeChat conversations in the local archive without any cloud involvement.

## Current State
No WeChat integration. Platform abstraction is in place. iMessage established the pattern of reading a local SQLite DB directly — WeChat follows the same approach.

## Desired Outcome
`npm run sync:wechat` reads the WeChat Mac app's local SQLite database, maps conversations and messages to the shared schema, stores them as `platform='wechat'` records, and is idempotent.

## Approach
WeChat Mac stores messages in SQLite at:
`~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/<hash>/Message/`

Each contact/group has its own `.db` file. The databases may use SQLCipher encryption with a key derived from the user's local WeChat installation. Implementation follows the iMessage pattern exactly: open DB read-only, map rows to the shared Message schema, use `better-sqlite3`. If encryption is present, derive the key using the documented local method (no credentials sent anywhere).

The key tables in each WeChat message DB:
- `Chat_<hash>`: message rows with `CreateTime`, `Message`, `Des` (0=sent, 1=received), `MesSvrID` as external_id

## Scope
- **In**: `src/platforms/wechat/sync.ts`, discovery of WeChat DB files, per-contact DB iteration, message mapping, `npm run sync:wechat`, Full Disk Access guidance in error messages, tests with mock DB (same in-memory SQLite pattern as imessage tests)
- **Out**: Sending messages, media/image extraction, WeChat moments, WeChat Pay records, Windows WeChat (macOS only for now)

## Boundary Candidates
- DB discovery — find all `Chat_*.db` files under the WeChat container path
- Per-DB message extraction — open each DB, read message table, map rows
- Contact name resolution — WeChat stores contact display names in a separate `WCDB_Contact.db`; resolve names from there

## Out of Boundary
- DB schema changes — platform-abstraction owns the schema
- MCP tool changes — platform filter handles WeChat automatically once data is in DB
- Cross-platform (Windows) WeChat — different DB location and format, separate future spec

## Upstream / Downstream
- **Upstream**: platform-abstraction (PlatformAdapter interface, db functions)
- **Downstream**: web-ui (displays WeChat messages), release (packaged)

## Existing Spec Touchpoints
- **Extends**: src/platforms/types.ts (add 'wechat' to Platform union)
- **Adjacent**: src/platforms/imessage/sync.ts — follow the same structural pattern (openDb, mapChat, mapMessage, runBackfillImpl injectable)

## Constraints
- macOS only (reads `~/Library/Containers/com.tencent.xinWeChat/`)
- Requires Full Disk Access for Terminal (same as iMessage) — surface a clear error message if access is denied
- Read-only access only — never write to WeChat's DB files
- If SQLCipher encryption is present on the user's installation, document the key derivation step clearly; do not fail silently
