# Implementation Plan

## web-ui-enhancements

---

- [ ] 1. Extend message handler with pagination support
- [x] 1.1 Extend `GET /api/messages/:chatId` in `src/web/routes.ts` to accept `?before=<timestamp>` and `?limit=<n>` query params
  - The current handler calls `getMessages(chatId, 500)` (hard-coded limit, no `before`). Replace this with param-aware logic.
  - Parse `before` as a positive integer (unix timestamp) if present; respond 400 `{ error: 'invalid before parameter' }` if non-integer or negative.
  - Parse `limit` as a positive integer in range 1–100 if present (default 50); respond 400 `{ error: 'invalid limit parameter' }` if out of range or non-integer.
  - Pass validated `(chatId, limit, before)` to `db.getMessages(chatId, limit + 1, before)`. Use the extra row to determine `has_more`, then slice to `limit`.
  - Return `{ messages: MessageResult[], has_more: boolean }` (instead of the current flat array).
  - `GET /api/messages/:chatId` with no params still returns messages with default limit 50 (backward-compatible).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Boundary: src/web/routes.ts_

- [x] 1.2 Update `handleListMessages` in `src/mcp.ts` to accept `{ before?: number; limit?: number }` options and return `{ messages: MessageResult[], has_more: boolean }`
  - Add optional second parameter `opts?: { before?: number; limit?: number }` with defaults `limit=50`.
  - SQL query: `SELECT … WHERE chat_id = ? [AND id < before] ORDER BY timestamp ASC LIMIT limit+1`. Use the extra row to determine `has_more`, then slice to `limit`.
  - Return `{ messages: MessageResult[], has_more: boolean }` instead of the flat array.
  - `handleListMessages(chatId)` (no opts) continues to return the last 50 messages (backward-compatible default).
  - _Requirements: 1.1, 1.2, 1.5_
  - _Boundary: mcp.ts handleListMessages_
  - _Depends: 1.1_

- [x] 1.3 Update `GET /api/messages/:chatId` route to delegate to `handleListMessages` (replaces direct `db.getMessages` call)
  - After task 1.1 adds param parsing and task 1.2 extends `handleListMessages`, update the route to call `handleListMessages(chatId, { before, limit })` instead of `getMessages` directly.
  - Forward the `{ messages, has_more }` response object to the client unchanged.
  - Remove the direct `import { getMessages } from '../db'` if no longer needed.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Boundary: src/web/routes.ts_
  - _Depends: 1.1, 1.2_

- [x] 1.4 Update `tests/web.test.ts` to cover pagination behavior and fix the response-shape regression
  - Update existing `GET /api/messages/:chatId` assertion to expect `{ messages: [...], has_more: boolean }` shape.
  - Add test: `GET /api/messages/1?limit=2` returns 2 messages and a `has_more` field.
  - Add test: `GET /api/messages/1?before=99999` returns `{ messages: [], has_more: false }`.
  - Add test: `GET /api/messages/1?before=abc` returns 400.
  - Add test: `GET /api/messages/1?limit=200` returns 400.
  - All new and existing route tests pass (`npm test`).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Boundary: tests/web.test.ts_
  - _Depends: 1.3_

---

- [ ] 2. Add `/api/semantic-search` route
- [x] 2.1 Add `GET /api/semantic-search` handler to `src/web/routes.ts`
  - Validate `q` (string, non-empty) and optional `limit` (int 1–100, default 20); return 400 on invalid `limit`.
  - If `q` is missing or empty: respond `200 []`.
  - Call `isIndexed('messages')`; if false: respond `200 { error: 'Embedding index not built. Run: npm run index:embeddings', results: [] }`.
  - Call `embedOne(q)` (async) then `semanticSearchMessages(vector, { limit })`.
  - Map `SemanticMessageResult[]` to `SearchResult[]` shape: drop `distance`, coerce `sender_name ?? ''` and `text ?? ''`.
  - Catch all errors → `500 { error: message }`.
  - Route handler is `async`; import `isIndexed`, `semanticSearchMessages` from `src/vec-db.ts` and `embedOne` from `src/embeddings.ts`.
  - `routes.ts` remains under 200 lines.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 6.2, 6.3_
  - _Boundary: API Routes routes.ts_

- [x] 2.2 Add `tests/web.test.ts` coverage for `/api/semantic-search`
  - Add test: `GET /api/semantic-search` (no `q`) returns `200 []`.
  - Add test: with index seeded, `GET /api/semantic-search?q=hello` returns `200` results array matching `SearchResult` shape.
  - Add test: with no index, `GET /api/semantic-search?q=hello` returns `200 { error: '...', results: [] }`.
  - Add test: `GET /api/semantic-search?q=hello&limit=abc` returns `400`.
  - All new and existing tests pass.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - _Boundary: tests/web.test.ts_
  - _Depends: 2.1_

---

- [ ] 3. Extract scroll JS to `src/web/ui-scroll.ts`
- [ ] 3.1 Create `src/web/ui-scroll.ts` exporting `SCROLL_JS: string`
  - The string contains self-contained vanilla JS (no `import` syntax) implementing:
    - `scrollToBottom(container)` — schedules `container.scrollTop = container.scrollHeight` via `requestAnimationFrame`.
    - `attachScrollSentinel(container, chatId, oldestId, onOlderLoaded)` — inserts `<div id="scroll-sentinel">` as first child of `container`; creates an `IntersectionObserver` (threshold `0`, rootMargin `'100px'`) targeting the sentinel.
    - Observer callback: if `isFetching` guard is set, skip; otherwise record `firstVisibleMessage`, set `isFetching = true`, show `<div id="scroll-loading">` indicator, fetch `GET /api/messages/${chatId}?before=${oldestId}&limit=50`.
    - On success: call `onOlderLoaded(messages)` to prepend rows; restore scroll with `firstVisibleMessage.scrollIntoView({ block: 'start' })`; clear `isFetching`; if `has_more === false` disconnect observer and remove sentinel.
    - On error: hide loading indicator, show `<div id="scroll-error">` with retry button; clear `isFetching`.
    - `disconnectScroll()` helper disconnects and nulls the current observer (called on thread switch).
  - No server-side imports; file is a TypeScript module exporting one string constant.
  - File is under 200 lines.
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 6.1, 6.2_
  - _Boundary: ui-scroll.ts_

---

- [ ] 4. Update `src/web/ui.ts` — thread scroll integration
- [ ] 4.1 (P) Wire scroll-to-bottom into thread open and thread re-select
  - Import `SCROLL_JS` from `./ui-scroll` and embed it in the `<script>` block of `HTML_PAGE`.
  - In the `openThread(chatId)` JS function: after rendering messages call `scrollToBottom(threadContainer)`.
  - On re-select of the same chat: call `scrollToBottom(threadContainer)` again (Req 2.3).
  - Call `disconnectScroll()` before opening a new thread to clean up the previous observer.
  - After initial render, call `attachScrollSentinel(container, chatId, oldestMessageId, prependMessages)` where `prependMessages` is a function that inserts message rows at the top of the thread.
  - Thread correctly displays oldest at top, newest at bottom on first load.
  - `ui.ts` remains under 200 lines after this change.
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5_
  - _Boundary: ui.ts_
  - _Depends: 3.1_

- [ ] 4.2 (P) Update message rendering to use `{ messages, has_more }` response shape
  - The JS fetch in `openThread` now receives `{ messages, has_more }` from `/api/messages/:chatId`.
  - Extract `messages` array for rendering; pass `has_more` (and the oldest message id) to `attachScrollSentinel`.
  - No visible change to message rendering HTML (sender, text, timestamp, badge unchanged).
  - _Requirements: 1.5, 2.1_
  - _Boundary: ui.ts_
  - _Depends: 1.2_

---

- [ ] 5. Update `src/web/ui.ts` — semantic search toggle
- [ ] 5.1 Add keyword/semantic pill toggle to search bar markup
  - Add two adjacent `<button>` elements (`data-mode="keyword"` and `data-mode="semantic"`) inside the search bar container.
  - Style as a pill: background highlight on `.active` class; default active mode is `keyword`.
  - Clicking a mode button sets the `searchMode` JS variable and updates `.active` class.
  - Toggle is rendered as part of the static HTML in `HTML_PAGE`.
  - _Requirements: 5.1, 5.6, 6.1_
  - _Boundary: ui.ts_

- [ ] 5.2 Wire search submission to mode-aware fetch URL
  - On search submit: if `searchMode === 'keyword'` fetch `/api/search?q=`; else fetch `/api/semantic-search?q=`.
  - If the semantic response contains an `error` field (index not built case), render an error banner in the results panel instead of an empty list (Req 5.5).
  - Semantic results render with the same HTML template as keyword results: sender name, message text, timestamp, platform badge, click handler to load thread (Req 5.4).
  - Search mode persists across multiple searches without page reload (Req 5.6).
  - Switching back to keyword mode and searching calls `/api/search` again.
  - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6_
  - _Boundary: ui.ts_
  - _Depends: 5.1, 2.1_

---

- [ ] 6. Integration validation and regression
- [ ] 6.1 Run full test suite and verify all requirements
  - `npm test` passes with all existing and new tests green.
  - Manual browser check: open a chat with 100+ messages; confirm auto-scroll to bottom, load-older on scroll-up, no scroll jump after prepend.
  - Manual browser check: semantic search returns results matching keyword search semantically; error banner appears when index not built.
  - `src/web/routes.ts`, `src/web/ui.ts`, `src/web/ui-scroll.ts` each under 200 lines (confirmed with `wc -l`).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4_
  - _Depends: 4.1, 4.2, 5.2, 2.2_
