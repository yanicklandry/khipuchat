# Brief: web-ui-enhancements

## Problem
The web UI thread view currently shows messages in database-fetch order (oldest first by default) but has no chat-like scroll behavior: there is no auto-scroll to the newest message, no pagination-on-scroll, and no way to load older history without refreshing. Additionally, the semantic search backend exists (MCP tools `semantic_search_messages` and `semantic_find_contacts`) but is not exposed in the web UI at all — users can only do keyword search.

## Current State
- `/api/messages/:chatId` returns all messages in one flat list
- `src/web/ui.ts` renders messages top-to-bottom as returned; no scroll anchoring
- Search bar calls `/api/search` which does keyword/FTS search only
- Semantic search is fully implemented in `src/vec-db.ts` + `src/mcp.ts` but has no web route or UI entry point

## Desired Outcome
- Opening a chat thread auto-scrolls to the **bottom** (newest messages)
- The layout is "oldest at top, newest at bottom" — standard chat window convention
- Scrolling up toward the top triggers loading of the previous page of messages (infinite scroll upward)
- The search bar has a toggle or mode switch between keyword search and semantic (meaning-based) search
- Semantic search results render identically to keyword search results (same chat-list + thread view)

## Approach
- **Pagination**: Add `?before=<message_id>&limit=50` query param to `/api/messages/:chatId`; front-end loads last page on open, prepends earlier pages on scroll-up with an IntersectionObserver at the top sentinel
- **Scroll anchoring**: After initial load, `scrollIntoView` the bottom message; after prepend, restore scroll position to the first previously-visible message
- **Semantic search route**: Add `/api/semantic-search?q=...` route in `src/web/routes.ts` that calls the existing `vec-db` kNN query; reuse the same response shape as `/api/search`
- **UI toggle**: Small "keyword / semantic" pill toggle next to the search bar; plain JS, no framework

## Scope
- **In**: Paginated `/api/messages/:chatId`, scroll-to-bottom on open, load-older on scroll-up, `/api/semantic-search` route, semantic/keyword toggle in search bar
- **Out**: Infinite scroll downward, real-time message push, sending messages, redesigning the full UI

## Boundary Candidates
- API layer: pagination param on existing route + new semantic-search route (`src/web/routes.ts`)
- Frontend scroll logic: IntersectionObserver + scroll anchor management (`src/web/ui.ts`)
- Frontend search toggle: mode state + conditional fetch URL (`src/web/ui.ts`)

## Out of Boundary
- Does not change the embedding/indexing pipeline (`src/embeddings.ts`, `src/index-embeddings.ts`)
- Does not change MCP tool definitions in `src/mcp.ts`
- Does not add new platforms or change the sidebar

## Upstream / Downstream
- **Upstream**: `web-ui` (Express server, routes, UI structure), `semantic-search` (vec-db kNN query functions already implemented)
- **Downstream**: None — this is a leaf feature

## Existing Spec Touchpoints
- **Extends**: `web-ui` (modifies `src/web/routes.ts` and `src/web/ui.ts`)
- **Adjacent**: `semantic-search` (calls its db functions; does not modify them)

## Constraints
- No external JS frameworks, no build step — inline CSS + vanilla JS only
- Server stays Express; no WebSocket or SSE needed
- Semantic search fallback: if vec-db has no embeddings yet, return empty results with a user-facing message
- Each source file stays under 200 lines (split routes/ui if needed)
