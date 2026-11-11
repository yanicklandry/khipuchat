# Research Log: ollama-mcp

## Summary

- **Feature**: `ollama-mcp`
- **Discovery Scope**: Extension (integration-focused). A new local query surface built entirely on existing, unchanged query handlers plus one new external client (`ollama`). The core architectural move is a pure refactor (extract a shared tool registry from `mcp.ts`) plus one thin new consumer (`ask.ts`).
- **Key Findings**:
  - `src/mcp.ts` already keeps every tool branch as a thin arg-coercion shim over shared handlers in `query-handlers.ts` / `image-handlers.ts`. The inline `ListTools` schemas and the `CallTool` switch extract cleanly into `TOOL_DEFINITIONS` + `dispatchTool` with no logic change.
  - `tests/mcp.test.ts` reaches into `createMcpServer()._requestHandlers` for `tools/list` and `tools/call` and asserts on tool names, descriptions, `inputSchema.properties`, and call results. The refactor must preserve those exact shapes; this is the regression guard the brief relies on.
  - The `ollama` npm client is OpenAI-shaped for tools: `tools: [{ type: 'function', function: { name, description, parameters } }]`, and returns `response.message.tool_calls[].function.{name, arguments}` with `arguments` already parsed to an object. Tool results are appended as `{ role: 'tool', content, tool_name }` messages.
  - Importing `src/config.ts` eagerly calls `requireEnv('TELEGRAM_API_ID')` at module load, so `ask.ts` must NOT import `config.ts`; it resolves `OLLAMA_HOST`/`OLLAMA_MODEL` directly from `process.env` to avoid coupling `khipu ask` to Telegram credentials.

## Research Log

### Existing MCP tool surface

- **Context**: The registry extraction must be behavior-identical.
- **Sources Consulted**: `src/mcp.ts` (lines 44-109), `src/query-handlers.ts`, `src/image-handlers.ts`, `tests/mcp.test.ts`.
- **Findings**:
  - Eight tools are advertised: `list_chats`, `find_chat_by_name`, `list_messages`, `search_messages`, `get_chat_summary`, `semantic_find_contacts`, `semantic_search_messages`, `get_image`.
  - The `CallTool` handler does shared coercion (`platform`, `account`, `since`, `until`, `type`, `limit`) then a per-tool switch. `list_messages` branches on `chat_id` presence to call either `handleListMessages` (per-chat) or `handleListArchiveMessages` (archive-wide) — so eight tools map onto nine handlers.
  - `semantic_*` and `get_image` handlers are async; the sync handlers are not. `dispatchTool` must therefore be `async` and `await` uniformly.
  - The `MCP_SECRET` bearer check lives in `CallTool` and reads `req.params._meta.authorization`. This is transport/auth concern and stays in `mcp.ts`, not in the registry.
- **Implications**: `dispatchTool(name, args)` owns the coercion + switch + handler call and returns the raw result; `mcp.ts` keeps the SDK server, the `MCP_SECRET` guard, and the `{ content: [{ type:'text', text: JSON.stringify(result) }] }` wrapping. `ListTools` becomes `{ tools: TOOL_DEFINITIONS }`.

### Ollama JS client tool-calling contract

- **Context**: `ask.ts` needs the exact client shape.
- **Sources Consulted**: `ollama` npm client (ollama-js) README + API reference (via Context7).
- **Findings**:
  - Custom host: `new Ollama({ host })`.
  - `await client.chat({ model, messages, tools })`; `tools` entries are `{ type: 'function', function: { name, description, parameters: <JSONSchema> } }`.
  - Response: `response.message.tool_calls?` is an array; each has `.function.name` (string) and `.function.arguments` (already an object, not a JSON string — unlike OpenAI).
  - Tool-use loop: append the assistant message, then one `{ role: 'tool', content: <stringified result>, tool_name: <name> }` per call, and re-invoke `chat` until `tool_calls` is empty; then read `response.message.content`.
  - Connection failure throws (fetch error / ECONNREFUSED); a missing model surfaces as an error whose message references the model name.
- **Implications**: `ask.ts` maps each `TOOL_DEFINITIONS` entry `{ name, description, inputSchema }` to `{ type:'function', function:{ name, description, parameters: inputSchema } }` — a direct field rename, so the JSON Schema is shared verbatim between MCP and Ollama. A `try/catch` around the first `chat` call classifies unreachable-host vs missing-model for friendly errors.

### CLI entry-point wiring

- **Context**: `khipu ask "<question>"` must route like other operational commands.
- **Sources Consulted**: `src/khipu.ts` (`OPERATIONAL_SCRIPTS`, `SUBCOMMAND_USAGE`, `USAGE`, `resolveCommand`), `package.json` scripts.
- **Findings**:
  - Operational subcommands resolve to `path.join(SRC, script)` with `args: argv.slice(1)`, so `khipu ask "why…"` forwards `["why…"]` to `ask.ts` as its args. `ask.ts` reads the question from `process.argv`.
  - Per-subcommand `--help` is served from `SUBCOMMAND_USAGE[sub]`; adding an `ask` entry gives `khipu ask --help` for free.
  - `khipu.test.ts` asserts on the resolver; adding `ask` to `OPERATIONAL_SCRIPTS` makes it a valid `run` target with no special-casing.
- **Implications**: Add `ask: 'ask.ts'` to `OPERATIONAL_SCRIPTS`, an `ask` block to `SUBCOMMAND_USAGE`, an `ask` line to `USAGE`, and `"ask": "tsx src/ask.ts"` to `package.json` scripts.

### Configuration coupling hazard

- **Context**: Where to read `OLLAMA_HOST` / `OLLAMA_MODEL`.
- **Sources Consulted**: `src/config.ts`.
- **Findings**: `config.ts` builds `config` at import time via `requireEnv('TELEGRAM_API_ID' | 'TELEGRAM_API_HASH' | 'TELEGRAM_PHONE_NUMBER')`, throwing if any is unset. `mcp.ts` deliberately does not import `config.ts`.
- **Implications**: `ask.ts` resolves the two Ollama env vars directly (a tiny local `resolveOllamaConfig()` reading `process.env` with defaults), so `khipu ask` works on a machine that never configured Telegram. Documented as a deliberate design decision, not an oversight.

### Image tool result size

- **Context**: `get_image` returns base64 image bytes; feeding those to a text model wastes the context window.
- **Findings**: `dispatchTool('get_image', …)` must return the identical `GetImageResult` for parity, but `ask.ts` controls how a tool result is serialized into the model conversation.
- **Implications**: `dispatchTool` stays pure (parity preserved); `ask.ts` bounds the serialized tool-result string (cap length, note truncation) so a large `content_base64` never floods the model context. This is a presentation concern local to `ask.ts`.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A. Shared registry + thin ask consumer (chosen) | Extract `TOOL_DEFINITIONS` + `dispatchTool` from `mcp.ts`; `mcp.ts` and `ask.ts` both consume it | Zero handler duplication; single source of truth; matches established surface-parity pattern; net line reduction in `mcp.ts` | Refactor must stay byte-identical for MCP (guarded by `mcp.test.ts`) | Directly matches the brief |
| B. `ask.ts` calls handlers directly, no registry | Duplicate the coercion switch inside `ask.ts` | No `mcp.ts` change | Duplicates the arg-coercion logic; two sources of truth drift; violates parity ethos | Rejected |
| C. Generalize a full "surface adapter" abstraction | A base class both MCP and ask extend | Maximal reuse | Premature abstraction for two consumers; more code than the registry | Rejected (over-engineering) |

## Design Decisions

### Decision: `dispatchTool` is async and returns the raw handler result

- **Context**: Three of nine handlers are async; MCP wraps results in `content`, ask stringifies them.
- **Alternatives Considered**: 1) sync dispatch with per-caller awaiting; 2) return already-wrapped MCP content.
- **Selected Approach**: `async dispatchTool(name, args): Promise<unknown>` returns the handler's raw value; each surface formats it.
- **Rationale**: Keeps the registry transport-agnostic (R3.4) and makes the parity assertion (`await dispatchTool(...)` deep-equals the direct handler call) trivial.
- **Trade-offs**: Callers must await even for sync handlers — negligible cost, uniform contract.
- **Follow-up**: Parity test covers a sync tool (`search_messages`/`list_chats`) and confirms equality.

### Decision: `ask.ts` reads Ollama config from `process.env`, not `config.ts`

- **Context**: Importing `config.ts` throws without Telegram creds.
- **Selected Approach**: Local `resolveOllamaConfig()` reading `OLLAMA_HOST`/`OLLAMA_MODEL` with defaults.
- **Rationale**: `khipu ask` must not require unrelated platform credentials.
- **Trade-offs**: Two env vars live outside the central `Config` type; acceptable and clearly scoped.

### Decision: bounded iteration loop with a hard cap

- **Context**: A misbehaving model could loop on tool calls forever.
- **Selected Approach**: Cap the tool-call loop (e.g. 8 iterations); on cap, stop and print the best available content (R5.4).
- **Rationale**: Predictable termination; no runaway local inference.

## Risks & Mitigations

- **MCP regression during extraction** — Mitigation: `tests/mcp.test.ts` (`tools/list` shapes, `tools/call` results, `MCP_SECRET`) plus the ask-parity test run in the same suite; extraction is a mechanical move, not a rewrite.
- **Non-tool-capable model configured** (e.g. a base model without tool support) — Mitigation: document the requirement (`qwen2.5`/`llama3.1`); the loop still terminates and prints whatever the model returns; missing-model errors are classified (R6.2).
- **Large `get_image` base64 flooding context** — Mitigation: `ask.ts` bounds serialized tool-result length.
- **File-size budget (200-line limit)** — Mitigation: `tool-registry.ts` is definitions + one switch (well under 200); `ask.ts` is the client + loop + config + serialization (under 200); `mcp.ts` shrinks.

## References

- `src/mcp.ts`, `src/query-handlers.ts`, `src/image-handlers.ts`, `src/khipu.ts`, `src/config.ts` — current implementation.
- `tests/mcp.test.ts`, `tests/query-parity.test.ts`, `tests/surface-e2e.test.ts` — regression + parity guards.
- ollama-js client (Context7 `/ollama/ollama-js`) — chat tool-calling contract, custom host, tool-result messages.
- `.kiro/specs/ollama-mcp/brief.md`; `.kiro/steering/roadmap.md` (Phase 3 entry); `.kiro/steering/tech.md`, `structure.md`.
