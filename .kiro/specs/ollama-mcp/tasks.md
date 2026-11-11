# Implementation Plan

- [x] 1. Foundation: dependency and shared tool registry
- [x] 1.1 Add the ollama dependency and ask npm script (P)
  - Add `"ollama"` to `dependencies` in `package.json` (official client) and run install so the package resolves under Node 24
  - Add `"ask": "tsx src/ask.ts"` to `scripts`
  - Observable done: `import { Ollama } from 'ollama'` type-checks, and `npm run ask -- "test"` resolves to the ask script (even before it is implemented)
  - _Requirements: 2.1_
  - _Boundary: package.json_

- [x] 1.2 Extract the shared tool registry (TOOL_DEFINITIONS + dispatchTool)
  - Create `src/tool-registry.ts` exporting a `ToolDefinition` interface, a readonly `TOOL_DEFINITIONS` array carrying the name, description, and JSON Schema for all eight archive tools moved verbatim from the current MCP `ListTools` handler, and an `async dispatchTool(name, args)` that reproduces the exact argument coercion and per-tool handler dispatch from the current MCP `CallTool` handler, including the `list_messages` branch on `chat_id` (per-chat vs archive-wide)
  - Await every handler and return the raw result; throw an `Unknown tool: <name>` error for an unrecognized name
  - Import only from the query handlers, image handlers, and `db.ts` types; do not import the MCP SDK or the ollama client
  - Observable done: `TOOL_DEFINITIONS` lists all eight tool names; `await dispatchTool('list_chats', {})` returns the same value as calling the list-chats handler directly; `dispatchTool('nope', {})` rejects with an unknown-tool error; the file is under 200 lines
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - _Boundary: tool-registry.ts_

- [x] 1.3 Refactor the MCP server to consume the registry
  - In `src/mcp.ts`, remove the inline tool-definition array and the argument-coercion/dispatch switch; import `TOOL_DEFINITIONS` and `dispatchTool`
  - Have the tool-list handler return the registry definitions, and the tool-call handler keep the existing `MCP_SECRET` bearer check, call `dispatchTool`, and wrap the result in the existing text content envelope
  - Leave the handler re-exports and the stdio entrypoint unchanged
  - Observable done: `tests/mcp.test.ts` passes unchanged (tool-list names/descriptions/schemas, tool-call results, and `MCP_SECRET` enforcement identical to before); `src/mcp.ts` is shorter than before the refactor
  - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - _Boundary: mcp.ts_
  - _Depends: 1.2_

- [x] 2. Local ask command (Ollama agent loop)
- [x] 2.1 Ollama config resolution, tool mapping, and system prompt (P)
  - Create `src/ask.ts` with `resolveOllamaConfig()` reading `OLLAMA_HOST` (default `http://127.0.0.1:11434`) and `OLLAMA_MODEL` (default `qwen2.5`) from `process.env` without importing `config.ts`
  - Add `toOllamaTools()` mapping each registry definition to the Ollama `{ type:'function', function:{ name, description, parameters } }` shape, and `buildSystemPrompt()` describing the KhipuChat archive assistant role
  - Observable done: `resolveOllamaConfig()` returns the documented defaults when env is unset and the overrides when set; `toOllamaTools()` returns one function entry per tool preserving names and schemas
  - _Requirements: 2.2, 2.3, 5.1_
  - _Boundary: ask.ts_
  - _Depends: 1.2_

- [x] 2.2 Bounded tool-call loop over dispatchTool
  - Implement `runAskLoop(client, model, question)` that seeds the conversation with the system prompt and the user question, calls the Ollama chat API with the mapped tools, and while the response contains tool calls appends the assistant message, runs each call through `dispatchTool`, and appends a tool-role message carrying a length-bounded serialized result before re-invoking chat
  - Enforce a hard iteration cap; on cap, stop and return the best available answer; wrap each tool dispatch in a try/catch that serializes a failure back as that tool's result and continues
  - Observable done: against a mock client returning one tool call then a final answer, the loop dispatches the tool, appends a tool message, and returns the final content; a mock that loops forever stops at the cap; a dispatch throw does not abort the loop
  - _Requirements: 5.2, 5.3, 5.4, 6.3_
  - _Boundary: ask.ts_
  - _Depends: 1.2, 2.1_

- [x] 2.3 Error classification and CLI entrypoint
  - Add `classifyOllamaError()` distinguishing an unreachable endpoint (naming Ollama and the resolved host) from a missing model (naming the model and suggesting a pull), each yielding a human-readable message
  - Implement `main()`: read the question from argv and print usage without contacting the model when it is absent; otherwise initialize the database, build the client, run the loop, print the final answer to stdout and exit 0; on the first chat failure, print the classified friendly message to stderr and exit non-zero
  - Observable done: `khipu ask "<q>"` against a running local model prints a natural-language answer and exits 0; with Ollama stopped it prints an Ollama+host error and exits non-zero; with an unknown model it prints a model+pull error and exits non-zero; `khipu ask` with no question prints usage and never contacts the model
  - _Requirements: 1.1, 1.2, 1.5, 2.1, 2.4, 5.5, 6.1, 6.2, 6.4_
  - _Boundary: ask.ts_
  - _Depends: 2.2_

- [x] 3. CLI routing for `khipu ask`
- [x] 3.1 Wire ask into the khipu command router and usage
  - In `src/khipu.ts`, add `ask: 'ask.ts'` to `OPERATIONAL_SCRIPTS`, add an `ask` block to `SUBCOMMAND_USAGE` documenting `khipu ask "<question>"`, and list `ask` under the query commands in the top-level `USAGE` text
  - Observable done: `khipu ask "<q>"` resolves to a `run` of `ask.ts` with the question forwarded as its argument; `khipu ask --help` prints the ask usage and exits 0; the top-level `khipu --help` lists `ask`
  - _Requirements: 1.1, 1.3, 1.4_
  - _Boundary: khipu.ts_
  - _Depends: 2.3_

- [x] 4. Tests and verification
- [x] 4.1 Ask-parity test (P)
  - Create `tests/ask-parity.test.ts` mirroring `tests/query-parity.test.ts`: seed an in-memory database, then assert `await dispatchTool('search_messages', args)` deep-equals `handleSearchMessages(query, filters)` and `await dispatchTool('list_chats', args)` deep-equals `handleListChats(filters)`
  - Assert the set of `TOOL_DEFINITIONS` names equals the set of tool names returned by the MCP tool-list handler
  - Observable done: all parity assertions pass, proving the ask surface dispatches through the same logic as MCP
  - _Requirements: 3.5, 7.1, 7.2_
  - _Boundary: ask-parity.test.ts_
  - _Depends: 1.2, 1.3_

- [x] 4.2 Ask loop unit and integration tests
  - Add tests for `resolveOllamaConfig` defaults/overrides, `toOllamaTools` shape, and the unknown-tool dispatch error
  - Drive `runAskLoop` with a mock Ollama client covering: one-tool-call-then-answer, forever-looping capped at the limit, a dispatch failure returned to the model without aborting, and `classifyOllamaError` mapping connection vs missing-model errors
  - Observable done: all ask unit and integration assertions pass
  - _Requirements: 2.2, 2.3, 3.3, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3_
  - _Boundary: ask tests_
  - _Depends: 2.3_

- [x]* 4.3 MCP regression verification
  - Run the full suite and confirm `tests/mcp.test.ts` passes unchanged against the refactored server (tool-list shapes, tool-call results, `MCP_SECRET` enforcement, `search_messages` schema, and `khipu index` descriptions)
  - Observable done: the complete test suite is green, including the pre-existing MCP tests, with no edits to `tests/mcp.test.ts`
  - _Requirements: 4.1, 4.2, 4.3, 7.3_
  - _Depends: 1.3_

## Implementation Notes

- Registry extraction was mechanical: `TOOL_DEFINITIONS` and `dispatchTool` in `src/tool-registry.ts` are byte-for-byte the arrays/switch that were inline in `mcp.ts` (including the `list_messages` `chat_id` per-chat vs archive-wide branch and all numeric/string coercions). `mcp.ts` `ListTools` now returns `{ tools: TOOL_DEFINITIONS }` and `CallTool` keeps the `MCP_SECRET` bearer check + text-content envelope, delegating to `dispatchTool`. `tests/mcp.test.ts` passes unchanged (66 tests).
- `ollama` was installed with `npm install ollama --ignore-scripts` to avoid rebuilding the native `better-sqlite3-multiple-ciphers` under the Node-24 ABI lock. Resolved to `ollama@^0.6.3`.
- `ask.ts` deliberately does NOT import `config.ts` (which eagerly `requireEnv`s Telegram vars at load). It reads `OLLAMA_HOST`/`OLLAMA_MODEL` from `process.env` directly.
- Ollama contract used: `new Ollama({ host })`; `client.chat({ model, messages, tools })` returns `{ message }` where `message.tool_calls[i].function.arguments` is already a parsed object (passed straight to `dispatchTool`). Tool results are appended as `{ role: 'tool', content, tool_name }` messages.
- `runAskLoop` uses a hard cap of 8 iterations and bounds each serialized tool result to 8000 chars (so a large `get_image` base64 never floods context). Per-dispatch `try/catch` serializes failures back to the model so one bad tool call never aborts the command. `runAskLoop` accepts a minimal `AskClient` interface so tests drive it with a mock — no real Ollama server is contacted in tests.
- `classifyOllamaError` checks connection keywords (ECONNREFUSED / fetch failed / connect / timeout / etc.) first; only a non-connection "not found / try pulling" error is treated as a missing model.
- Full suite: 995 tests across 46 files, all green. New files: `src/tool-registry.ts` (78 lines), `src/ask.ts` (172 lines), `tests/ask-parity.test.ts`, `tests/ask.test.ts`. The `tsc` typecheck is known-broken in this repo and was not used as a gate (per project state); `npm test` is the gate.
