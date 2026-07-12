# Research & Design Decisions

---
**Feature**: `web-ui`
**Discovery Scope**: Extension — HTTP layer over existing MCP handler functions
**Key Findings**:
- `handleListChats`, `handleListMessages`, `handleSearchMessages` in `src/mcp.ts` already implement all data logic needed; the web layer is a thin adapter over these.
- Express is not yet in package.json — one new runtime dependency required; `@types/express` and `supertest`/`@types/supertest` as dev deps.
- The single-page UI (inline HTML/CSS/JS) is served as one static response; all dynamic content is fetched client-side via the three JSON API endpoints.

---

## Research Log

### Existing Handler Functions
- **Context**: Need to reuse mcp.ts handlers without modifying them.
- **Findings**: All five handlers (`handleListChats`, `handleSearchMessages`, `handleListMessages`, `handleFindChatByName`, `handleGetChatSummary`) call `getDb()` directly and return typed arrays. They are safe to call from route handlers with no modifications.
- **Implications**: Route handlers are 1–3 line wrappers. No new DB logic required.

### Express Not in Package.json
- **Context**: Brief says "no new npm dependencies beyond Express (already planned)."
- **Findings**: Express v4 is not present. Must add `express` (runtime), `@types/express`, `supertest`, `@types/supertest` (dev).
- **Implications**: package.json modification is a prerequisite task.

---

## Design Decisions

### Decision: Inline HTML/CSS/JS in ui.ts (template literal)
- **Alternatives**: Separate static files in `src/web/static/`; server-side templating.
- **Selected**: Export a single TypeScript string constant containing the complete HTML document with embedded `<style>` and `<script>` blocks.
- **Rationale**: Satisfies the no-build-step constraint. No `fs.readFile` at runtime; no static file serving complexity. One import path.
- **Trade-offs**: Editing HTML inside a TS string is less ergonomic — acceptable given the UI is intentionally minimal.

### Decision: Three-file layout under src/web/
- `server.ts`: Express setup + main()
- `routes.ts`: three API route handlers
- `ui.ts`: HTML constant
- **Rationale**: Each file has one clear responsibility and stays well under 200 lines.

---

## Risks & Mitigations

- **Port conflict** — server exits with clear message (Req 1.4).
- **NaN chatId** — routes.ts validates `:chatId` and returns 400 on parse failure.
- **DB not initialized** — server.ts calls `initDb` before mounting routes; any early request will return 500 with a readable message.

---

# Gap Analysis (2026-07-12)

**Spec phase at analysis time:** tasks-generated / ready_for_implementation
**Finding:** Implementation already present in `src/web/` — this analysis documents coverage and residual gaps.

## Summary

- All six requirements are satisfied by the existing code. The task checklist in `tasks.md` is out of sync with actual code state.
- Implementation exceeds spec scope in two additive areas: `/api/semantic-search` route and per-account `?account=` filtering on chats and search.
- `routes.ts` imports handler functions from `../mcp`, which re-exports them from `query-handlers.ts`. `src/mcp.ts` is not modified — boundary constraint satisfied.
- No missing capabilities. Effort: **S**. Risk: **Low**.

## Requirement-to-Asset Map

| Requirement | Status | Asset |
|---|---|---|
| 1.1 `npm run web` script | DONE | `package.json` "web" script |
| 1.2 Bind to 127.0.0.1 only | DONE | `server.ts` `app.listen(3333, '127.0.0.1', ...)` |
| 1.3 Full HTML page on GET / | DONE | `ui.ts` `buildHtmlPage()` |
| 1.4 EADDRINUSE exit with message | DONE | `server.ts` `server.on('error', ...)` |
| 1.5 2 s response time | DONE (by design) | Synchronous SQLite queries, no blocking I/O |
| 2.1–2.3 Chat sidebar | DONE | `ui.ts` client JS `renderChatList()` |
| 2.4 GET /api/chats | DONE | `routes.ts` — also supports `?account=` |
| 3.1–3.3 Cross-platform search results | DONE | `ui.ts` `doSearch()` |
| 3.4 Empty query guard | DONE | `routes.ts` whitespace trim + early return |
| 3.5 GET /api/search?q= | DONE | `routes.ts` |
| 4.1–4.3 Thread view, chronological, sent/received | DONE | `ui.ts` `buildMsgEl()`, `openThread()` |
| 4.4 Media placeholder `[media]` | DONE | `buildMsgEl`: renders `[type]` when text is falsy |
| 4.5 GET /api/messages/:chatId | DONE | `routes.ts` — also supports `?before` and `?limit` pagination |
| 5.1–5.3 Platform badge (raw DB value, no mapping) | DONE | `icons.ts` SVG map, fallback to first letter |
| 6.1 No external URLs | DONE | Verified by test stripping SVG xmlns |
| 6.2 No build step | DONE | Template literal in `ui.ts`, `tsx` direct run |
| 6.3 Plain HTML/CSS/vanilla JS | DONE | No framework, no bundler |

## Beyond-Spec Additions (Non-Breaking)

1. **`GET /api/semantic-search`** — ONNX vector search with graceful fallback when index absent. Covered by tests.
2. **`?account=` filter** — Server-side and UI `<select>` dropdown for multi-account installs. Covered by tests.

## Residual Gaps

| Gap | Severity |
|---|---|
| `tasks.md` all checkboxes show unchecked — out of sync with code reality | Cosmetic |

## Recommendations

- Mark all tasks in `tasks.md` as complete.
- Run `/kiro-validate-impl web-ui` to formally validate the existing implementation against the spec.
