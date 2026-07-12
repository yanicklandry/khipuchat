# Implementation Plan

- [x] 1. Foundation — dependencies, script, and test scaffold
- [x] 1.1 Add Express and supporting dependencies
  - Add `express` (v5), `express-basic-auth`, `simple-icons` to `dependencies` in `package.json`
  - Add `@types/express`, `supertest`, `@types/supertest` to `devDependencies`
  - Add `"web": "tsx src/web/server.ts"` to the `scripts` block
  - Create the `src/web/` directory
  - `npm test` still passes after adding dependencies
  - _Requirements: 1.1, 6.2_

- [x] 1.2 Create test file skeleton and in-memory app helper
  - Create `tests/web.test.ts` with a `beforeEach` that initialises an in-memory SQLite DB via `initDb(':memory:')` and calls `createApp()` to get a testable Express instance
  - Import `supertest` and confirm the test file compiles with no TypeScript errors
  - A skeleton test (`GET /` returns 200) passes with `npm test`
  - _Requirements: 1.3_

- [x] 2. Core — API routes and UI components
- [x] 2.1 (P) Implement JSON API route handlers
  - Create `src/web/routes.ts` exporting an Express `Router`
  - Optional auth guard: when `WEB_USER` and `WEB_PASS` env vars are both set, apply `express-basic-auth` on `/api/*`; otherwise pass through
  - `GET /api/chats`: reads optional `?account=`; calls `handleListChats(undefined, account)`; responds 200 JSON
  - `GET /api/search?q=`: empty or missing `q` responds 200 `[]`; otherwise reads optional `?account=` and calls `handleSearchMessages(q, undefined, undefined, account)`; responds 200 JSON
  - `GET /api/messages/:chatId`: parses chatId as integer (400 on NaN); validates optional `?before=` (positive integer) and `?limit=` (1-100, default 50); calls `handleListMessages(chatId, { before, limit })`; responds 200 `{ messages, has_more }`
  - `GET /api/semantic-search?q=`: empty `q` responds 200 `[]`; validates optional `?limit=` (1-100, default 20); if `isIndexed('messages')` is false responds 200 `{ error, results: [] }`; otherwise calls `embedOne(q)` then `semanticSearchMessages(vector, { limit })` and responds 200 with flat results
  - All routes catch handler errors and respond 500 `{ error: message }`
  - `GET /api/messages/not-a-number` returns 400; invalid `before`/`limit` return 400
  - _Requirements: 1.5, 2.4, 3.4, 3.5, 4.5_
  - _Boundary: API Routes (routes.ts)_

- [x] 2.2 (P) Implement platform icon map
  - Create `src/web/icons.ts` exporting `buildPlatformIconMap(): Record<string, string>`
  - Map known platforms (`telegram`, `wechat`, `discord`, `whatsapp`, `imessage`, `email`) to 16px inline SVG strings from `simple-icons`
  - Resize each SVG, set `fill="currentColor"`, and strip the `xmlns` attribute so the page makes no external request
  - Unknown platforms are omitted from the map; the HTML Builder provides a letter fallback
  - `buildPlatformIconMap()` returns SVG strings with no `xmlns` attribute and no external URL references
  - _Requirements: 5.1, 5.2, 5.3, 6.1_
  - _Boundary: Platform Icons (icons.ts)_

- [x] 2.3 (P) Implement scroll pagination client script
  - Create `src/web/ui-scroll.ts` exporting `SCROLL_JS: string` (a vanilla-JS script embedded verbatim into the page; no runtime import, preserving the no-build constraint)
  - `attachScrollSentinel(container, chatId, oldestTimestamp, onOlderLoaded, hasMore)` uses `IntersectionObserver` to fetch `/api/messages/:chatId?before=<oldest>&limit=50` when scrolled to the top
  - Guards concurrent fetches with an `_isFetching` flag; preserves scroll position after prepending older messages; shows a loading indicator; renders a Retry affordance on fetch failure
  - Exports `scrollToBottom` and `disconnectScroll` for thread-switch lifecycle management
  - `SCROLL_JS` is a non-empty string containing the `attachScrollSentinel` function definition
  - _Requirements: 4.1_
  - _Boundary: Scroll Client (ui-scroll.ts)_

- [x] 2.4 Implement the self-contained HTML/CSS/JS UI page
  - Create `src/web/ui.ts` exporting `buildHtmlPage(accounts, selectedAccount?): string` and `HTML_PAGE = buildHtmlPage([])` for backward compatibility
  - Three-zone layout: full-width search bar at top; sidebar (type filter, optional account dropdown, platform filter chips, chat list) and main panel side by side below
  - Bake `buildPlatformIconMap()` JSON and `SCROLL_JS` inline at call time; contain no `<link>` to external stylesheets, no `<script src="https://...">`, and no external font references
  - Platform badge: inline SVG from the icon map for known platforms; single-letter fallback derived from the raw `platform` string for unknown ones
  - Search mode toggle switches between `/api/search` (keyword) and `/api/semantic-search` (semantic); semantic `{ error }` responses surfaced inline
  - `doSearch()` trims input and returns early when blank, submitting no request
  - Sent messages (`is_sender === 1`) right-aligned; received left-aligned; group chats show sender name
  - Media-only messages (`text` empty/null) render `[type]` as italic placeholder rather than an empty bubble
  - After rendering a thread, attaches scroll sentinel for lazy-loading older pages
  - All user-derived strings pass through an HTML-escape helper before insertion
  - `buildHtmlPage([])` is a non-empty string containing `<html`, `<style`, and `<script`; contains no `https://` references
  - _Requirements: 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.3_
  - _Boundary: HTML Builder (ui.ts)_
  - _Depends: 2.2, 2.3_

- [x] 3. Integration — Express server wiring
- [x] 3.1 Implement the Express server and main entry point
  - Create `src/web/server.ts` exporting `createApp(): express.Application`
  - `createApp` mounts the router from `routes.ts` and a `GET /` handler: reads optional `?account=` query param, calls `listArchiveAccounts()`, sets `Content-Type: text/html; charset=utf-8`, and responds with `buildHtmlPage(accounts, selectedAccount)`
  - `main()` calls `initDb('./khipuchat.db')`, then `createApp().listen(3333, '127.0.0.1', ...)`
  - Binds explicitly to `'127.0.0.1'` (not `'0.0.0.0'`) to satisfy Req 1.2
  - On `EADDRINUSE`: writes a clear message identifying port 3333 to stderr and calls `process.exit(1)`
  - `require.main === module` guard prevents listener start when module is imported in tests
  - `GET /` via supertest returns 200 with `Content-Type: text/html`
  - _Requirements: 1.1, 1.2, 1.4, 6.2_
  - _Depends: 2.1, 2.4_

- [x] 4. Validation — test coverage
- [x] 4.1 API route integration tests
  - `GET /api/chats` returns 200 JSON array; each entry has `chat_id`, `name`, `platform`, `message_count`
  - `GET /api/search?q=hello` returns 200 JSON array; each entry has `chat_name`, `text`, `platform`
  - `GET /api/messages/:chatId` returns 200 `{ messages, has_more }`; each message has `sender_name`, `text`, `is_sender`, `platform`
  - `GET /api/messages/:chatId?before=<ts>&limit=50` returns an older page and correct `has_more`
  - `GET /api/messages/not-a-number` returns 400; invalid `before`/`limit` return 400
  - `GET /api/search` (no `q`) and `GET /api/semantic-search` (no `q`) return 200 `[]`
  - `GET /api/semantic-search?q=...` with no index returns 200 `{ error, results: [] }`
  - With `WEB_USER`/`WEB_PASS` set, `/api/*` without credentials returns 401; with correct credentials returns 200
  - All tests pass with `npm test`
  - _Requirements: 1.5, 2.4, 3.4, 3.5, 4.5_

- [x] 4.2 UI page and icons static tests
  - `buildHtmlPage([])` is a non-empty string containing `<html`, `<style`, and `<script` tags
  - `buildHtmlPage([])` contains no `https://` references (verifies no external URLs, Req 6.1)
  - `buildHtmlPage([])` contains `/api/chats`, `/api/search`, and `/api/messages` references (verifies client JS wiring)
  - `buildPlatformIconMap()` returns SVG strings with no `xmlns` attribute
  - All tests pass with `npm test`
  - _Requirements: 6.1, 6.3_
