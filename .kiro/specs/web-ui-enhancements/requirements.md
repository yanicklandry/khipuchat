# Requirements Document

## Project Description (Input)

KhipuChat's web UI currently renders chat threads in database-fetch order with no scroll anchoring, no pagination, and no way to load older history without a full page refresh. The semantic search backend (MCP tools `semantic_search_messages` and `semantic_find_contacts`) is fully implemented in `src/vec-db.ts` and `src/mcp.ts` but is not exposed in the web UI — users can only do keyword/FTS search. This feature enhances the existing web UI by:

1. Adding proper chat-window scroll behavior: auto-scroll to newest message on open, "oldest at top / newest at bottom" layout, and infinite-scroll-upward pagination via an IntersectionObserver sentinel.
2. Exposing semantic (meaning-based) search through a toggle next to the existing search bar, backed by a new `/api/semantic-search` route.

**Boundary candidates**: `src/web/routes.ts` (pagination param + new route), `src/web/ui.ts` (scroll logic + search toggle). No changes to `src/embeddings.ts`, `src/index-embeddings.ts`, `src/mcp.ts`, or the database schema.

**Upstream dependencies**: `web-ui` spec (Express server, routes, UI structure already implemented); `semantic-search` spec (`semanticSearchMessages` / `semanticFindContacts` functions in `src/vec-db.ts` already implemented).

---

## Requirements

### 1. Paginated Message API

**1.1** When a request is made to `GET /api/messages/:chatId`, the Web Server shall accept optional query parameters `before` (a message ID integer) and `limit` (a positive integer, default 50, maximum 100) and return only the matching page of messages in ascending timestamp order.

**1.2** When `before` is omitted, the Web Server shall return the last `limit` messages for the chat (i.e., the most recent page).

**1.3** If `before` is present but is not a valid positive integer, the Web Server shall respond with HTTP 400 and `{ "error": "invalid before parameter" }`.

**1.4** If `limit` is present but is not a valid positive integer or exceeds 100, the Web Server shall respond with HTTP 400 and `{ "error": "invalid limit parameter" }`.

**1.5** The Web Server shall include a `has_more` boolean field in the response (or equivalent pagination metadata) so the client can determine whether older messages exist.

---

### 2. Scroll-to-Bottom on Thread Open

**2.1** When a chat is selected from the sidebar, the Web UI shall scroll the message thread view to the bottom so the newest message is visible without manual scrolling.

**2.2** While a thread is loading, the Web UI shall not display a partially-scrolled view; the scroll position shall be set after the messages have been rendered.

**2.3** When a thread is re-selected (already open), the Web UI shall scroll to the bottom again.

---

### 3. Infinite Scroll — Load Older Messages

**3.1** When the user scrolls to the top of the message thread view, the Web UI shall automatically fetch the previous page of messages (using the `before` parameter of the oldest currently-displayed message) and prepend them above the existing messages.

**3.2** While older messages are being fetched, the Web UI shall display a loading indicator at the top of the thread and prevent duplicate fetch requests.

**3.3** After older messages are prepended, the Web UI shall restore the scroll position so that the first previously-visible message remains in view (no scroll jump).

**3.4** When no older messages exist (`has_more` is false), the Web UI shall remove the top sentinel and not make further fetch requests.

**3.5** If fetching older messages fails, the Web UI shall display an inline error message at the top of the thread and allow the user to retry.

---

### 4. Semantic Search Route

**4.1** When a request is made to `GET /api/semantic-search?q=<query>`, the Web Server shall embed the query and return ranked results using the existing `semanticSearchMessages` function from `src/vec-db.ts`, with the same JSON shape as `/api/search` results.

**4.2** If `q` is missing or empty, the Web Server shall respond with HTTP 200 and an empty array `[]`.

**4.3** If the embedding index has not been built (i.e., `isIndexed('messages')` returns false), the Web Server shall respond with HTTP 200 and `{ "error": "Embedding index not built. Run: npm run index:embeddings", "results": [] }`.

**4.4** If the embedding or search operation fails, the Web Server shall respond with HTTP 500 and `{ "error": "<message>" }`.

**4.5** The `/api/semantic-search` route shall accept an optional `limit` query parameter (positive integer, default 20, maximum 100); invalid values shall return HTTP 400.

---

### 5. Semantic Search Toggle in the UI

**5.1** The Web UI shall display a "keyword / semantic" toggle control adjacent to the search input so users can switch between the two search modes.

**5.2** When the user submits a search query with the "keyword" mode active, the Web UI shall call `/api/search` (existing behavior).

**5.3** When the user submits a search query with the "semantic" mode active, the Web UI shall call `/api/semantic-search`.

**5.4** When semantic search results are returned, the Web UI shall render them in the same layout as keyword search results (chat name, sender, message text, timestamp, platform badge).

**5.5** If the server returns `{ "error": "...", "results": [] }` for a semantic search (index not built), the Web UI shall display the error message to the user instead of an empty results list.

**5.6** The search mode selection shall persist across searches within the same browser session (no page reload needed to switch back).

---

### 6. Non-Functional and Constraint Requirements

**6.1** The Web UI shall use only vanilla JavaScript, inline CSS, and no external libraries or build steps (constraint inherited from the `web-ui` spec).

**6.2** Each modified source file (`src/web/routes.ts`, `src/web/ui.ts`) shall remain under 200 lines; if a file would exceed 200 lines, the implementation shall split it into logical sub-modules under `src/web/`.

**6.3** The Web Server shall respond to all `/api/semantic-search` requests within 3 seconds for a corpus of up to 1 million indexed messages.

**6.4** The Web UI shall not make additional network calls to external services; all search and message data shall be fetched from the local Express server.
