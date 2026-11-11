# Brief: ollama-mcp

## Problem
The archive can only be queried conversationally through Claude (via the stdio MCP server). A user who wants a fully local, no-cloud LLM to chat over their messages — consistent with KhipuChat's "messages never leave your machine" ethos — has no option. Semantic search already runs locally (ONNX embeddings); the conversational layer does not.

## Current State
`src/mcp.ts` `createMcpServer()` registers 8 tools. Each tool branch is a thin arg-coercion shim that delegates to a shared handler in `src/query-handlers.ts` (+ `src/image-handlers.ts`): `handleListChats`, `handleFindChatByName`, `handleListMessages`, `handleListArchiveMessages`, `handleSearchMessages`, `handleGetChatSummary`, `handleSemanticFindContacts`, `handleSemanticSearchMessages`, `handleGetImage`. The tool JSON Schemas are written inline in `ListToolsRequestSchema`. CLI and web are peer surfaces over the same handlers; `tests/query-parity.test.ts` and `tests/surface-e2e.test.ts` enforce agent-native parity.

## Desired Outcome
`khipu ask "<question>"` runs a local Ollama model that has tool access to the same query handlers, answers in natural language, and never calls any cloud service. Anything Claude can answer through MCP, the local model can answer through `ask` — a fourth surface with its own parity test.

## Approach
- Extract the inline tool definitions + call-switch from `mcp.ts` into `src/tool-registry.ts`: a `TOOL_DEFINITIONS` array (name + JSON Schema) and a single `dispatchTool(name, args): Promise<unknown>` holding the arg-coercion + handler-call logic. `mcp.ts` imports both (net line reduction; `mcp.test.ts` guards against regression).
- `src/ask.ts`: Ollama agent loop using the official `ollama` npm client. Build a system prompt, pass `TOOL_DEFINITIONS` as Ollama `tools`, run the tool-call loop calling `dispatchTool`, print the final answer. Read `OLLAMA_HOST` (default `http://127.0.0.1:11434`) and `OLLAMA_MODEL` (default `qwen2.5`) from env/config.
- Entry point: add `ask: 'ask.ts'` to `OPERATIONAL_SCRIPTS` in `khipu.ts` + a `SUBCOMMAND_USAGE.ask` block; add `ollama` to package.json deps and an `"ask"` npm script.
- `tests/ask-parity.test.ts`: assert `dispatchTool('search_messages', args)` equals `handleSearchMessages(...)` directly, mirroring `query-parity.test.ts`.

Chosen because it reuses 100% of existing handlers with zero business-logic duplication, matches the established surface-parity pattern, and fits the self-hosted/local-inference ethos already set by local embeddings.

## Scope
- **In**: `tool-registry.ts` extraction, `ask.ts` Ollama loop, `khipu ask` entry point, `ollama` dependency, ask-parity test, refactor of `mcp.ts` to consume the registry.
- **Out**: streaming/token UI, multi-turn session persistence, model auto-pull/management, exposing Ollama over the web UI or network, multimodal/vision reasoning on images, replacing Claude/MCP (this is additive), Ollama-specific auth.

## Boundary Candidates
- Shared tool registry + dispatch (`tool-registry.ts`) — the seam both MCP and Ollama consume.
- Ollama client + agent loop (`ask.ts`) — isolated; the only file that imports `ollama`.
- CLI entry wiring (`khipu.ts`).

## Out of Boundary
- Query-handler logic itself (unchanged — reused as-is).
- Embedding/index pipeline (unchanged).

## Upstream / Downstream
- **Upstream**: `query-handlers.ts`, `image-handlers.ts`, `khipu.ts` command router, `config.ts`.
- **Downstream**: `mcp.ts` becomes a consumer of `tool-registry.ts`; future surfaces (e.g. web chat) could reuse the same registry.

## Existing Spec Touchpoints
- **Extends**: implicitly the semantic-search / query-handlers surface set (adds a 4th surface).
- **Adjacent**: `mcp.ts` (must stay behavior-identical — parity tests + `mcp.test.ts` guard this).

## Constraints
- Node 24, tsx, TypeScript strict, no `any`. Keep files under 200 lines.
- No external/cloud calls — Ollama runs locally (`ollama serve`), assume user ran `ollama pull <model>`.
- Ollama tool-calling requires a tool-capable model (qwen2.5 / llama3.1); document this. The `ollama` npm client talks to `OLLAMA_HOST`.
