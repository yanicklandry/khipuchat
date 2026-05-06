# Implementation Plan

- [ ] 1. Foundation — dependencies, script, and test scaffold
- [ ] 1.1 Add Express and test dependencies
  - Add `"express": "^4.18.0"` to `dependencies` in `package.json`
  - Add `"@types/express"`, `"supertest"`, `"@types/supertest"` to `devDependencies`
  - Add `"web": "tsx src/web/server.ts"` to the `scripts` block
  - Create the `src/web/` directory
  - `npm test` still passes (no new failures from dependency additions)
  - _Requirements: 1.1, 6.2_

- [ ] 1.2 Create test file skeleton and in-memory app helper
  - Create `tests/web.test.ts` with a `beforeEach` that initialises an in-memory SQLite DB via `initDb(':memory:')` and calls `createApp()` to get a testable Express instance
  - Import `supertest` and confirm the test file compiles with no TypeScript errors
  - The skeleton test (`GET /` returns 200) passes with `npm test`
  - _Requirements: 1.3_

- [ ] 2. Core — API routes and UI page (parallel)
- [ ] 2.1 (P) Implement the three JSON API route handlers
  - Create `src/web/routes.ts` exporting an Express `Router`
  - `GET /api/chats`: calls `handleListChats()`, responds 200 JSON
  - `GET /api/search?q=`: if `q` is absent or empty responds 200 `[]`; otherwise calls `handleSearchMessages(q)`, responds 200 JSON
  - `GET /api/messages/:chatId`: parses chatId as integer; responds 400 `{ error: 'invalid chatId' }` if NaN; calls `handleListMessages(chatId)`, responds 200 JSON
  - All three routes catch handler errors and respond 500 `{ error: message }`
  - `GET /api/messages/not-a-number` returns 400 in tests
  - _Requirements: 1.5, 2.4, 3.4, 3.5, 4.5_
  - _Boundary: API Routes (routes.ts)_

- [ ] 2.2 (P) Implement the self-contained HTML/CSS/JS UI page
  - Create `src/web/ui.ts` exporting a `HTML_PAGE: string` template literal
  - CSS: full-width search bar at top; sidebar (chat list) and main panel side-by-side below
  - Inline JS: on load `fetch('/api/chats')` populates the sidebar; each chat item has a `data-chat-id` attribute
  - Clicking a sidebar chat calls `fetch('/api/messages/:chatId')` and renders the thread in the main panel
  - Submit on search input calls `fetch('/api/search?q=...')` (skipped if input is empty or whitespace-only); results rendered in main panel; clicking a result loads its chat thread
  - Each chat entry and each message includes `<span class="badge">{platform}</span>`
  - Sent messages (`is_sender === 1`) are right-aligned; received are left-aligned
  - Messages with `text === null` render as `[media]`
  - `HTML_PAGE` contains `<html`, `<style`, and `<script` tags; contains no references to external URLs
  - _Requirements: 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.3_
  - _Boundary: UI Page (ui.ts)_

- [ ] 3. Integration — Express server wiring
- [ ] 3.1 Implement the Express server and main entry point
  - Create `src/web/server.ts` exporting `createApp(): express.Application`
  - `createApp` mounts the router from `routes.ts` and a `GET /` handler that responds with `HTML_PAGE` from `ui.ts`
  - `main()`: calls `initDb('./telegram.db')`, then `createApp().listen(3333, '127.0.0.1', callback)`
  - On `EADDRINUSE` error: logs a message identifying port 3333 as occupied and calls `process.exit(1)`
  - Add `require.main === module` guard following the iMessage/WeChat pattern
  - `GET /` via supertest returns 200 with `Content-Type: text/html`
  - _Requirements: 1.1, 1.2, 1.4, 6.2_
  - _Depends: 2.1, 2.2_

- [ ] 4. Test coverage
- [ ] 4.1 API route integration tests
  - `GET /api/chats` returns 200 with a JSON array; each entry has `id`, `name`, `platform`, `message_count`
  - `GET /api/search?q=hello` returns 200 with a JSON array; each entry has `chat_name`, `text`, `platform`
  - `GET /api/messages/1` (with a seeded chat) returns 200 with a JSON array; each entry has `sender_name`, `text`, `is_sender`, `platform`
  - `GET /api/messages/bad` returns 400
  - `GET /api/search` (no `q`) returns 200 `[]`
  - All tests pass with `npm test`
  - _Requirements: 2.4, 3.4, 3.5, 4.5_

- [ ] 4.2 UI page static tests
  - `HTML_PAGE` is a non-empty string containing `<html`, `<style`, and `<script` tags
  - `HTML_PAGE` contains no `https://` references (no external URLs)
  - `HTML_PAGE` contains `/api/chats`, `/api/search`, and `/api/messages` references (verifies routes are wired in client JS)
  - All tests pass with `npm test`
  - _Requirements: 6.1, 6.3_
