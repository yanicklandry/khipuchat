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
