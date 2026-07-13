# Research Log — web-ui-enhancements

## Discovery Scope

**Feature type**: Extension (existing system — modifies `src/web/routes.ts` and `src/web/ui.ts`)
**Discovery process**: Light (integration-focused)

---

## Codebase Analysis

### Key Findings

1. **`src/web/routes.ts`** (53 lines) — Currently defines three routes. Has ~147 lines of headroom within the 200-line limit. Adding the pagination extension and the semantic-search route will bring it to ~90–100 lines; no split needed.

2. **`src/web/ui.ts`** (233 lines) — Already over the 200-line limit. Adding toggle markup and search-mode JS will push it further. Extraction of a `ui-scroll.ts` helper (exporting a `SCROLL_JS: string` constant inlined by `ui.ts`) is required.

3. **`src/mcp.ts` — `handleListMessages`** — Returns a flat `MessageResult[]`. Pagination requires changing this signature to accept `{ before?: number; limit?: number }` options and return `{ messages: MessageResult[], has_more: boolean }`. This is a breaking change in the `web-ui` ownership area but is coordinated by this spec. The existing `tests/web.test.ts` test for `GET /api/messages/:chatId` must be updated.

4. **`src/vec-db.ts`** — `semanticSearchMessages(queryVector, filters)` and `isIndexed(table)` are fully implemented. `SemanticMessageResult` shape: `{ chat_id, chat_name, sender_name, text, timestamp, platform, distance }`. Mapping to `SearchResult` is straightforward: drop `distance`, coerce nulls.

5. **`src/embeddings.ts`** — Exports `embedOne(text): Promise<Float32Array>`. The semantic search route handler must be `async`.

6. **No `better-sqlite3` blocking concern** — All DB calls in `vec-db.ts` are synchronous; only `embedOne` is async. The route handler pattern `async (req, res) => { ... }` with `try/catch` is consistent with the project's existing error handling.

---

## Architecture Decisions

### Decision 1: `ui-scroll.ts` as a JS string constant

**Choice**: Export `SCROLL_JS: string` from `ui-scroll.ts`; `ui.ts` imports it and embeds it in the `<script>` block of `HTML_PAGE`.

**Rationale**: Consistent with how `ui.ts` currently constructs the page — the entire page is a template literal. Splitting the JS string into a separate module keeps each file under 200 lines without introducing a build step or bundler.

**Alternative rejected**: Splitting `ui.ts` into a separate static JS file served by Express. Rejected because it adds a new route and a new file type to the server, increasing complexity beyond what the brief calls for.

### Decision 2: Extend `handleListMessages` rather than query the DB directly from routes.ts

**Choice**: Extend `handleListMessages` to accept pagination options and return `{ messages, has_more }`.

**Rationale**: Keeps all data-access logic in `mcp.ts` (existing pattern). Routes remain thin.

**Risk**: Breaking change. Mitigated by updating the single `tests/web.test.ts` callsite.

### Decision 3: Semantic route maps `SemanticMessageResult` → `SearchResult` at the route layer

**Choice**: The route handler does the field mapping (drop `distance`, handle nulls). The `vec-db.ts` interface is unchanged.

**Rationale**: Avoids adding a new type export to `vec-db.ts` and keeps the upstream boundary clean.

---

## Synthesis Outcomes

- **Generalization**: Pagination (`before` + `limit`) is a standard cursor-based pattern. Implementing it once in `handleListMessages` + route handler is sufficient; no generic pagination abstraction is needed.
- **Build vs. Adopt**: IntersectionObserver is a Web Platform API (no library needed). All other capabilities are already in the codebase.
- **Simplification**: The scroll sentinel approach (one `<div>` at the top, one observer) is the minimum viable implementation. No scroll-position tracking library, no virtual list.

---

## Gap Analysis — 2026-07-13 (post-partial-implementation)

### Current Implementation State

All server-side work is complete and all 967 tests pass. Client-side scroll behavior has functional gaps.

| File | Lines | Status |
|------|-------|--------|
| `src/web/routes.ts` | 135 | Complete. Pagination and `/api/semantic-search` implemented. Under 200 lines. |
| `src/web/ui-scroll.ts` | 119 | Exists. Scroll helpers extracted. Under 200 lines. |
| `src/web/ui.ts` | 256 | Complete feature set, BUT **exceeds 200-line limit (req 6.2)**. |

### Gap 1: `ui.ts` Exceeds 200-Line Limit (req 6.2 violation)

`ui.ts` is 256 lines after extracting scroll logic to `ui-scroll.ts`. The original research doc estimated 233 lines before extraction, expecting the extraction would bring it under 200. That estimate was wrong — extraction only moved the scroll JS but `ui.ts` accumulated additional code (toggle markup, mode-aware search, account filter helper, platform filter rendering).

**Required action**: Extract `buildAccountFilterHtml` and the platform-filter + chat-list rendering helpers into a `src/web/ui-chats.ts` sub-module, exporting the HTML string or a render function. This should recover ~60 lines, bringing `ui.ts` to ~195 lines.

### Gap 2: `prependMessages` Reverses Insertion Order and Displaces the Sentinel

`prependMessages` in `ui.ts` (line 193–196):

```js
function prependMessages(msgs) {
  const isGroup = currentChatType === 'group';
  msgs.forEach(m => { panel.insertBefore(buildMsgEl(m, isGroup), panel.firstChild); });
}
```

**Bug A: Reversed order.** `msgs` arrives in ascending timestamp order (oldest first, per req 1.1). Inserting each message before `panel.firstChild` causes every new element to leapfrog the previous one — the final DOM order has the NEWEST message of the batch at the top and the OLDEST at the bottom of the prepended block.

**Bug B: Sentinel displacement.** When the sentinel is the first child, `panel.firstChild === sentinel`. The first `insertBefore` call moves the new message element before the sentinel, making the message the new `firstChild`. All subsequent inserts push that message further down. After the loop the sentinel is no longer the first child of the container — it is buried after all newly prepended messages. The `IntersectionObserver` watches the sentinel but the sentinel is now mid-content, so subsequent scroll-up events will not reliably re-trigger loading.

**Required fix**: Iterate `msgs` in reverse and always insert relative to the sentinel (not `firstChild`):

```js
// Inside the onOlderLoaded callback in ui-scroll.ts (has sentinel in closure):
for (let i = msgs.length - 1; i >= 0; i--) {
  container.insertBefore(buildMsgEl(msgs[i], isGroup), sentinel.nextSibling);
}
```

Because `prependMessages` in `ui.ts` does not have access to `sentinel` (it is closed over inside `attachScrollSentinel`), the cleanest fix is to change the `onOlderLoaded` callback contract: instead of passing a DOM-manipulation callback, pass a message-builder callback and do the insertion inside `attachScrollSentinel` where `sentinel` is in scope. Alternatively, expose `sentinel` via a returned handle.

### Gap 3: `IntersectionObserver` Uses Viewport Root Instead of Scroll Container

In `ui-scroll.ts` (line 108):

```js
_observer = new IntersectionObserver(function(entries) { ... }, { threshold: 0, rootMargin: '100px' });
```

No `root` is specified, so the browser uses the viewport as the intersection root. The scrollable element is `#panel` (`overflow-y: auto`), which is a scrollable div inside the page — not the viewport itself. For the observer to fire when the sentinel scrolls into the visible area of `#panel`, the observer must use `root: container`.

**Required fix**:

```js
_observer = new IntersectionObserver(function(entries) { ... }, {
  root: container,
  threshold: 0,
  rootMargin: '100px'
});
```

### Summary of Required Actions

| # | Gap | Requirement | Severity | Action |
|---|-----|-------------|----------|--------|
| 1 | `ui.ts` 256 lines | 6.2 | Medium | Extract `buildAccountFilterHtml` + chat-list helpers into `ui-chats.ts` |
| 2 | Prepend order reversed; sentinel displaced | 3.1, 3.3, 3.4 | High | Fix insertion loop in `attachScrollSentinel`; keep sentinel as first child |
| 3 | Observer root = viewport, not panel | 3.1, 3.2 | High | Add `root: container` to `IntersectionObserver` options |

### What Is Complete and Correct

- All API routes (pagination, semantic search, error handling) are implemented and tested.
- `ui-scroll.ts` structure (`scrollToBottom`, `attachScrollSentinel`, `disconnectScroll`) is sound; only the insertion logic and observer root need fixing.
- Search toggle (keyword/semantic), mode-aware fetch, error banner for unbuilt index, and result rendering are all correctly implemented in `ui.ts`.
- `handleListMessages` in `src/mcp.ts` returns `{ messages, has_more }` shape as required.
- All 967 tests pass.
