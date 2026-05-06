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
