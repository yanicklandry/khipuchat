# Implementation Plan

- [ ] 1. Foundation: DB schema and persistence seam
- [ ] 1.1 Extend the Message interface and messages DDL with four nullable media columns
  - Add four optional fields (`media_file_path?: string | null`, `media_url?: string | null`, `media_width?: number | null`, `media_height?: number | null`) to the `Message` interface in `src/db.ts`
  - Add the matching TEXT/INTEGER NULL columns to the `messages` CREATE TABLE statement
  - Fresh-DB test: `initDb()` succeeds and `pragma table_info(messages)` lists all four new columns
  - _Requirements: 2.1, 2.2, 2.3_

- [ ] 1.2 Update insertMessage to bind media fields with null-coalescing defaults and add the forward migration
  - Extend the INSERT SQL in `insertMessage` to include all four media columns
  - Bind each as `msg.media_file_path ?? null` (and equivalently for the others) so any adapter that never sets media keys inserts without throwing and without touching the ON CONFLICT behaviour
  - In `src/db-migrations.ts`, add four `columnExists`-guarded `ALTER TABLE messages ADD COLUMN` statements to `runMigrations`
  - Observable: calling `insertMessage` with a `Message` object that has no media keys set does not throw, and the four columns arrive as NULL in the database
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.2_
  - _Depends: 1.1_

- [ ] 2. Image metadata extraction helper
  - Create `src/platforms/wechat/image-meta.ts` exporting `ImageMeta` interface and `extractImageMeta(row, isV4): ImageMeta`
  - Use `isV4` flag to select the correct content column (`message_content` vs `strContent`/`Message`) from the row
  - Parse `media_file_path` from a bare non-XML path string or from the `<Image>` element via regex; parse `media_url` from `cdnthumburl` / `cdnmidimgurl` attributes; parse `media_width` / `media_height` from `cdnthumbwidth` / `cdnthumbheight` as finite integers
  - Return all-null `ImageMeta` for Buffer content (zstd blob / `WCDB_CT_message_content=4`), absent/null content, or any regex miss — never throw
  - Import `WechatMessageRow` via `import type` only (erased at runtime, prevents a cycle with `sync.ts`)
  - Observable: `extractImageMeta` called with a well-formed legacy image XML row returns a non-null `media_file_path` or `media_url`; called with a Buffer row returns `{ media_file_path: null, media_url: null, media_width: null, media_height: null }` without throwing
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3_
  - _Boundary: WeChat Adapter (image-meta.ts)_
  - _Depends: 1.1_

- [ ] 3. Integration: wire extraction into WeChat mapMessage
  - In `src/platforms/wechat/sync.ts`, import `extractImageMeta` from `image-meta.ts`
  - After the existing `isImageMessage` guard in `mapMessage`, call `extractImageMeta(row, isV4)` and spread its fields into the returned `Message` for image rows only
  - Leave non-image rows untouched: no media fields spread, no change to classification, `text`, or any other field
  - Observable: a WeChat image row that previously appeared in the archive with `type: 'image'` and no metadata now also carries a non-null `media_file_path` or `media_url` when the source XML contains one; a non-image row produces an identical `Message` to pre-change behaviour
  - _Requirements: 2.1, 2.2, 2.3, 4.3_
  - _Depends: 2._

- [ ] 4. Validation: tests
- [ ] 4.1 Unit tests for extractImageMeta in `tests/wechat-image-meta.test.ts`
  - Test: legacy XML row with a path string returns correct `media_file_path` (2.1)
  - Test: XML containing `cdnthumburl` / `cdnmidimgurl` returns correct `media_url` (2.2)
  - Test: XML containing `cdnthumbwidth` / `cdnthumbheight` returns integer `media_width` and `media_height` (2.3)
  - Test: Buffer input, absent/null content, and unparseable string each return all-null `ImageMeta` without throwing (2.4)
  - Test: equivalent legacy vs. V4 row produces the same `ImageMeta` shape (3.3)
  - Observable: all five test groups pass with `npm test`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3_

- [ ] 4.2 DB integration tests and regression check in `tests/wechat-image-meta.test.ts`
  - Test: `insertMessage` with a WeChat image `Message` carrying all four populated media fields persists them; `getMessages` returns the same values (confirms 2.1–2.3 and downstream SELECT * parity)
  - Test: `insertMessage` with a non-WeChat `Message` that has no media keys inserts successfully with the four columns NULL — regression guard for the named-parameter seam (4.1, 4.2)
  - Test: `runMigrations` on a pre-feature schema (without the four columns) adds all four; re-running on an already-migrated schema is a no-op (migration idempotency)
  - Run `npm test` and confirm `tests/wechat-image.test.ts` (16 existing cases for Type 4, 43, 49, local_type 4 detection) still passes — this is the regression guard for Req 1 and Req 3 cross-schema consistency
  - Observable: `npm test` exits 0; no failures in `wechat-image.test.ts` or the new test file
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 4.1, 4.2_
  - _Depends: 4.1_
