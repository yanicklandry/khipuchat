# Requirements Document

## Introduction

The `ollama-mcp` feature adds a fourth query surface to KhipuChat: `khipu ask "<question>"`, a fully local, no-cloud conversational agent that answers natural-language questions over the message archive. Today the archive can be queried conversationally only through Claude (via the stdio MCP server); semantic search already runs locally (ONNX embeddings), but the conversational layer does not. This feature closes that gap so a self-hosted user can chat over their messages with a local Ollama model, consistent with KhipuChat's "messages never leave your machine" ethos.

The eight MCP tools in `src/mcp.ts` are currently defined inline: their JSON Schemas live in the `ListTools` handler and their argument coercion + handler dispatch live in the `CallTool` handler. This feature extracts that shared surface into a new `src/tool-registry.ts` exposing a `TOOL_DEFINITIONS` array and a single `dispatchTool(name, args)` function, which both `src/mcp.ts` (refactored to consume the registry) and a new `src/ask.ts` (an Ollama tool-call loop) reuse. Anything Claude can answer through MCP, the local model answers through `ask`, over the same handlers, with its own surface-parity test.

## Boundary Context

- **In scope**: extraction of the shared tool registry (`TOOL_DEFINITIONS` + `dispatchTool`) from `src/mcp.ts`; refactor of `src/mcp.ts` to consume the registry with byte-for-byte identical MCP behavior; a new `src/ask.ts` Ollama agent loop reusing all existing query handlers through `dispatchTool`; the `khipu ask "<question>"` CLI entry point (dispatch, usage text, npm script); adding the `ollama` npm dependency; reading `OLLAMA_HOST` (default `http://127.0.0.1:11434`) and `OLLAMA_MODEL` (default `qwen2.5`) from the environment; graceful behavior when Ollama is unreachable, the model is missing, or a tool call errors; an `ask-parity` test mirroring `query-parity.test.ts`.
- **Out of scope**: streaming/token UI; multi-turn session persistence across invocations; model auto-pull or model management; exposing Ollama over the web UI or the network; multimodal/vision reasoning over image bytes; replacing Claude/MCP (this feature is additive); any Ollama-specific authentication; changes to the query-handler business logic itself; changes to the embedding/index pipeline.
- **Adjacent expectations**: This feature depends on the existing query handlers in `src/query-handlers.ts` and `src/image-handlers.ts`, the `khipu.ts` command router (`OPERATIONAL_SCRIPTS`, `SUBCOMMAND_USAGE`, `USAGE`), and `src/db.ts` initialization, without modifying handler logic. The eight MCP tools must remain behavior-identical after the extraction; `tests/mcp.test.ts` and the surface-parity tests guard this. The local model requires a tool-capable model (e.g. `qwen2.5`, `llama3.1`) and a running `ollama serve` with the model already pulled — these are operator prerequisites, not managed by this feature.

## Requirements

### Requirement 1: Local Ask Command Entry Point

**Objective:** As a self-hosting operator, I want a `khipu ask "<question>"` command, so that I can ask natural-language questions about my archive from the terminal using a local model.

#### Acceptance Criteria

1. When the operator runs `khipu ask "<question>"`, the KhipuChat CLI Router shall dispatch the invocation to the Ask Command with the question text forwarded as its argument.
2. When the operator runs `khipu ask` with no question, the Ask Command shall print usage guidance describing how to supply a question and shall exit without contacting the model.
3. When the operator runs `khipu ask --help` or `khipu ask -h`, the KhipuChat CLI Router shall print the `ask` subcommand usage and exit with status 0.
4. The KhipuChat CLI Router shall list `ask` in its top-level usage text as a query command.
5. When the Ask Command completes successfully, the Ask Command shall print the model's final natural-language answer to standard output and exit with status 0.

---

### Requirement 2: Fully Local, No-Cloud Inference

**Objective:** As a privacy-conscious operator, I want the ask command to run entirely against a local model, so that my messages never leave my machine.

#### Acceptance Criteria

1. The Ask Command shall send all inference requests to a local Ollama endpoint and shall not call any cloud or non-local LLM service.
2. The Ask Command shall resolve the Ollama endpoint from the `OLLAMA_HOST` environment variable, defaulting to `http://127.0.0.1:11434` when it is unset.
3. The Ask Command shall resolve the model name from the `OLLAMA_MODEL` environment variable, defaulting to `qwen2.5` when it is unset.
4. The Ask Command shall read message data only through the shared query handlers and shall not transmit raw archive contents anywhere other than to the local Ollama endpoint as tool results within the conversation.

---

### Requirement 3: Shared Tool Registry Extraction

**Objective:** As a maintainer, I want the MCP tool definitions and call dispatch extracted into a single shared module, so that MCP and the ask command reuse one source of truth with zero business-logic duplication.

#### Acceptance Criteria

1. The Tool Registry shall expose a `TOOL_DEFINITIONS` collection containing, for every archive query tool, its name, description, and JSON Schema, matching the tool set the MCP server previously defined inline.
2. The Tool Registry shall expose a single `dispatchTool(name, args)` operation that performs argument coercion and calls the corresponding query handler, returning the handler's raw result.
3. When `dispatchTool` is called with an unknown tool name, the Tool Registry shall raise an error identifying the unknown tool.
4. The Tool Registry shall not import from the MCP SDK, the Ollama client, or any surface-specific transport code, so that it remains reusable by any surface.
5. When `dispatchTool(name, args)` and the corresponding query handler are invoked with equivalent arguments, the Tool Registry shall return a result equal to calling that handler directly.

---

### Requirement 4: MCP Behavior Preserved After Refactor

**Objective:** As an existing Claude/MCP user, I want the MCP server to behave exactly as before after the registry extraction, so that no MCP client experiences a regression.

#### Acceptance Criteria

1. When an MCP client requests the tool list, the KhipuChat MCP Server shall return the same tool names, descriptions, and input schemas it returned before the extraction.
2. When an MCP client calls a tool, the KhipuChat MCP Server shall return the same result content it returned before the extraction.
3. While `MCP_SECRET` is set in the environment, the KhipuChat MCP Server shall continue to enforce bearer-token authorization on every tool call exactly as before.
4. The KhipuChat MCP Server shall obtain its tool list and its call dispatch from the Tool Registry rather than from inline definitions.

---

### Requirement 5: Ollama Tool-Call Agent Loop

**Objective:** As an operator asking a question, I want the local model to autonomously call the archive tools and answer in natural language, so that I get a synthesized answer rather than raw query output.

#### Acceptance Criteria

1. When the Ask Command starts a conversation, the Ask Agent shall provide the model a system prompt describing its role as a KhipuChat archive assistant and shall pass the registry tools in the Ollama tool format.
2. When the model response contains tool calls, the Ask Agent shall execute each tool call through `dispatchTool` and append each tool result to the conversation as a tool-role message before requesting the next model response.
3. While the model continues to return tool calls, the Ask Agent shall continue the call loop until the model returns a response with no tool calls or a maximum iteration limit is reached.
4. When the maximum iteration limit is reached before a final answer, the Ask Agent shall stop the loop and print the best available answer or a clear message that no final answer was produced.
5. The Ask Agent shall initialize the database before dispatching any tool so that tool calls query the live archive.

---

### Requirement 6: Graceful Degradation

**Objective:** As an operator, I want clear, actionable errors when Ollama or the model is unavailable, so that a missing local prerequisite does not produce an opaque crash.

#### Acceptance Criteria

1. If the Ollama endpoint is unreachable when the Ask Command runs, the Ask Command shall print a human-readable error identifying Ollama and the resolved host and shall exit with a non-zero status.
2. If the configured model is not available on the Ollama server, the Ask Command shall print a human-readable error naming the model and suggesting the operator pull it, and shall exit with a non-zero status.
3. If a single tool call raised by the model fails during dispatch, the Ask Agent shall return the error to the model as the tool result and continue the loop rather than aborting the whole command.
4. The Ask Command shall not produce an unhandled exception or stack-trace-only output for the unreachable-endpoint or missing-model conditions.

---

### Requirement 7: Surface Parity Verification

**Objective:** As a maintainer, I want an ask-parity test proving the ask surface queries the same logic as MCP, so that the fourth surface stays consistent with the reference implementation.

#### Acceptance Criteria

1. The Ask Parity Test shall assert that dispatching a tool through `dispatchTool` returns a result equal to calling the corresponding query handler directly with equivalent arguments, for representative read and search tools.
2. The Ask Parity Test shall assert that the tool registry advertises the same set of tool names the MCP server exposes.
3. When the full test suite runs, the existing MCP regression tests shall continue to pass against the refactored MCP server.
