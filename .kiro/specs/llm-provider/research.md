# Research & Design Decisions

## Summary
- **Feature**: `llm-provider`
- **Discovery Scope**: Extension (generalizes the ollama-mcp `AskClient`) plus one new external integration (Meta Model API), so light discovery for the codebase and full verification for the external API.
- **Key Findings**:
  - The Meta Model API is OpenAI Chat Completions compatible at `https://api.meta.ai/v1` with bearer auth; tool calls use the OpenAI shape (`id`, `type: "function"`, `function.arguments` as a JSON string) and structured output uses `response_format: { type: "json_schema", json_schema: { name, schema, strict } }`. A plain `fetch` adapter is sufficient; no SDK needed.
  - Meta only supports `tool_choice: "auto"` (anything else returns HTTP 400), so the neutral interface must not expose `tool_choice`.
  - `ajv` 8.20.0 is already installed transitively (via `@modelcontextprotocol/sdk`) and Ollama 0.6.3 accepts a JSON schema object in `format`, so structured output needs no new download on either provider.

## Research Log

### Meta Model API: endpoint, auth, models (primary docs)
- **Context**: Brief asks to verify Muse Spark base URL, model ids, and pricing against primary Meta docs (secondary sources disagree).
- **Sources Consulted**: `https://ai.developer.meta.com/docs/` (302 redirects to `https://dev.meta.ai/docs/`), `https://dev.meta.ai/docs/models.md`, `https://dev.meta.ai/docs/pricing-rate-limits`, fetched 2026-11-12.
- **Findings**:
  - Base URL `https://api.meta.ai/v1`; endpoint `POST /chat/completions`; auth `Authorization: Bearer <MODEL_API_KEY>`.
  - Model ids (Standard mode): `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`. Contributor mode: `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor`. Models page states Muse Spark 1.3 is recommended for new work. Context window 1,048,576 tokens. Also listed: `muse-wonder-1.0` (preview), `muse-ember-1.0` (not targeted here).
  - Pricing per 1M tokens, Standard (1.1/1.2/1.3 share one price): input $1.25, cached input $0.15, output $4.25. Contributor: input $0.10, cached input $0.002, output $0.20.
  - Contributor mode grants Meta "permission to use your content to train future Meta models"; Standard mode states "your content is not used to train Meta models".
  - Rate limits per team (not per key): Standard 3,000 RPM / 4,000,000 TPM; Contributor 150 RPM / 3,000,000 TPM.
  - Secondary sources (search result summaries) still cite `muse-spark-1.1` or `1.2` as default; primary docs now show `1.3`. Design documents `muse-spark-1.3` as the recommended value and does not hardcode any model id.
- **Implications**: No Muse-specific default is baked into code; the operator sets endpoint and model explicitly (documented values). Docs must warn that Contributor-mode ids imply training on message content.

### Meta Model API: tool calling
- **Sources Consulted**: `https://dev.meta.ai/docs/tool-calling`.
- **Findings**:
  - Tools: `{ type: "function", function: { name, description, parameters, strict? } }`; `strict` defaults to `false`.
  - `tool_choice`: only `"auto"` supported; `"none"`, `"required"`, and named choices return HTTP 400.
  - Response: `choices[0].message.tool_calls[]` with `id`, `type`, `function.name`, `function.arguments` (JSON-encoded string, "not guaranteed to validate"). `finish_reason: "tool_calls"`; `content` typically null or empty.
  - Follow-up turn must include the full assistant message with its `tool_calls` (omitting it returns HTTP 400), then one `{ role: "tool", tool_call_id, content }` per call.
  - Parallel tool calls on by default (`parallel_tool_calls`).
- **Implications**: Neutral `LlmToolCall` carries `id`; the assistant turn is replayed with `toolCalls`; arguments are JSON-parsed in the adapter and rejected as `invalid_response` when not an object (Req 2.5). The adapter never sends `tool_choice`.

### Meta Model API: structured output
- **Sources Consulted**: `https://dev.meta.ai/docs/structured-output`.
- **Findings**:
  - `response_format: { type: "json_schema", json_schema: { name, schema, strict } }`; answer is a JSON string in `choices[0].message.content`.
  - Output is always schema-constrained; `strict: true` additionally makes the server validate the schema against the strict subset (root plain object, `additionalProperties: false` on every object, `required` lists every property, no `allOf`/`oneOf`, `anyOf` allowed below root). Violations return HTTP 400 only when `strict: true`.
  - Limits: no recursive schemas (400), depth 10, 5,000 properties, 120,000 chars of names/enums/consts.
  - Not documented: refusal field, `finish_reason` values other than `tool_calls`, `json_object` mode, which models support structured output.
- **Implications**: Send `strict: true` by default (portable with other OpenAI-compatible servers, fails fast on bad schemas). Client-side validation with Ajv is still performed (Req 3.2 to 3.4) because other compatible endpoints and Ollama do not guarantee conformance.

### Meta Model API: errors and retry
- **Sources Consulted**: `https://dev.meta.ai/docs/error-handling`.
- **Findings**: Error body `{ error: { message, type, param, code } }` (`code` often null); unknown paths return 404 with empty body. 400/401/402/403/404/413 must not be retried unchanged; 429 and 500 retry with exponential backoff and jitter; 503 always retryable; `Retry-After` header present (60 s for `service_overloaded` / `backend_unavailable`).
- **Implications**: Error mapping table in design; bounded retry (2 retries, Retry-After capped at 30 s so a triage call fits its ~1 minute budget). 402 maps to `auth` (billing) for messaging purposes.

### Meta Model API: geographic availability (UNVERIFIED)
- **Sources Consulted**: models page ("Model availability can vary by country", points to Geographic Use Policy); web search summaries (third-party) citing US launch July 2026, later Japan and Singapore, restricted territories including mainland China, Hong Kong, Macau, Russia.
- **Findings**: Meta's Geographic Use Policy page could not be retrieved; no primary source confirms the country list or the HTTP status returned for a disallowed region. The brief calls Muse Spark a "US-only preview"; primary docs no longer label 1.3 as preview.
- **Implications**: Open item. Region denial is assumed to surface as 403 (mapped to `permission_denied`, a fallback-eligible category). Availability for the user's location and server region must be verified manually before relying on Muse; local fallback (Req 7) is the mitigation. Terms of service also bind on the user's location, not only the server's.

### Meta Model API: usage fields (UNVERIFIED)
- **Sources Consulted**: create-chat-completion reference (did not list fields; points to a Schemas page not fetched).
- **Findings**: Usage object shape not confirmed from primary docs; OpenAI-compatible convention is `usage.prompt_tokens` / `usage.completion_tokens`.
- **Implications**: Adapter reads those two fields when they are numbers and otherwise reports `null` (Req 2.6). Verify against a live response during implementation.

### Ollama structured output and usage
- **Sources Consulted**: `node_modules/ollama/dist/shared/ollama.1bfa89da.d.ts` (installed 0.6.3).
- **Findings**: `ChatRequest.format?: string | object` accepts a JSON schema; `ChatResponse` has `done_reason`, `prompt_eval_count`, `eval_count`; `ToolCall` has `function.name` and `function.arguments` (object) but no id; `Message.tool_name` identifies tool results.
- **Implications**: Ollama adapter synthesizes call ids (`call_<index>`), maps tool results by `tool_name`, passes the schema in `format`, and maps eval counts to usage.

### Existing codebase integration points
- **Findings**:
  - `src/ask.ts` (159 lines) owns config, tool mapping, prompt, loop, error classification, CLI. `AskClient.chat({ model, messages, tools })` is typed with Ollama `Message` / `Tool`.
  - `tests/ask.test.ts` imports `toOllamaTools`, `resolveOllamaConfig`, `classifyOllamaError`, `AskClient`, `AskChatResult` and Ollama types; it must be migrated with the refactor. `tests/ask-parity.test.ts` only exercises `dispatchTool` vs handlers and stays untouched.
  - `src/tool-registry.ts` `ToolDefinition.inputSchema: Record<string, unknown>` is reused verbatim as `LlmTool.parameters`.
  - `src/khipu.ts` has `ask` help text ("Ask a local Ollama model") that needs updating.
  - Steering `structure.md`: flat `src/`, no feature directories outside `src/platforms/`; so new modules use an `llm-` filename prefix in `src/`.
  - `.env.example` has no Ollama settings today.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Adapters implement full `LlmClient` | Each adapter owns chat, structured retry, gate, log | Fewer files | Gate, log, and retry duplicated per adapter; easy to forget the gate in a new adapter | Rejected |
| Transport port + one composing client | Adapters implement a thin `LlmTransport.complete`; `createLlmClient` adds gate, call log, structured validation/retry, error typing | Policy lives once; adapters are pure wire mapping; fake transport makes tests trivial | One extra indirection | Selected (hexagonal port/adapter) |
| Adopt an SDK (`openai` npm) | Use official SDK pointed at Meta base URL | Typed wire shapes | New dependency for a single POST; SDK retries would hide policy | Rejected, brief asks for plain fetch |

## Design Decisions

### Decision: Transport port with a single policy-owning client
- **Context**: Req 4, 5, 6 apply to every provider; a new provider must not be able to skip the gate.
- **Alternatives Considered**: adapters own everything; decorator chain (gate decorator, log decorator, structured decorator).
- **Selected Approach**: `LlmTransport` (wire only, throws `LlmError`) and `createLlmClient(transport, options)` which checks the gate at construction and call time, logs cloud calls, and implements `chatStructured` on top of `transport.complete`.
- **Rationale**: Smallest design that centralizes policy; decorators would be 3 extra files for one composition.
- **Trade-offs**: Transient retry is HTTP-specific so it lives in the OpenAI-compatible transport rather than the client.
- **Follow-up**: Ensure the factory is the only exported way to obtain a real client.

### Decision: Generalization: chatStructured is chat plus a response schema
- **Context**: Free-text and structured calls differ only by an optional response schema and post-validation.
- **Selected Approach**: `LlmCompletionRequest` has an optional `responseSchema`; transports translate it (Ollama `format`, OpenAI `response_format`). `chatStructured` does not accept tools (triage builds context itself via `dispatchTool`), avoiding the untested Meta combination of tools plus `response_format`.
- **Follow-up**: If triage later needs tools during structured calls, extend the request type; this is a revalidation trigger.

### Decision: Build vs adopt for schema validation
- **Selected Approach**: Adopt `ajv` (^8, MIT), promoted from transitive to direct dependency. Ajv's `ValidateFunction<T>` is a type guard, giving a typed result without `any` or unchecked casts.
- **Alternatives**: hand-rolled subset validator (more code, more bugs); `zod` (would require callers to author zod instead of JSON Schema, while providers need JSON Schema anyway).

### Decision: Cloud classification by destination, not provider kind
- **Context**: A remote `OLLAMA_HOST` also sends content off the machine; a loopback OpenAI-compatible server (llama.cpp, vLLM) does not.
- **Selected Approach**: Local iff URL hostname is `localhost`, in `127.0.0.0/8`, or `::1`. Everything else is cloud and needs `KHIPU_LLM_ALLOW_CLOUD=1`.
- **Trade-offs**: Behavior change for anyone using a remote `OLLAMA_HOST` today (explicit migration message, Req 4.5). A compose-sibling Ollama (`http://ollama:11434`) counts as cloud and needs the opt-in; documented.
- **Amendment (Phase 5 cross-spec decision D10, 2026-11-12)**: `KHIPU_LLM_LOCAL_HOSTS` (comma-separated exact hostnames, case-insensitive, no wildcards, no IPs, no ports) lets the operator declare hosts such as the compose service `ollama` as local, so triage `local-only` routing to a sibling Ollama container works without `KHIPU_LLM_ALLOW_CLOUD`. Without the setting the default classification above is unchanged. The operator asserts these hosts are private; a stderr notice names every endpoint classified local through this setting (Req 4.6 to 4.8).

### Decision: Call log as JSON lines (stderr or file), not a DB table
- **Context**: Req 5 needs an auditable record; message-events and triage-agent are adding DB tables in parallel (migration conflict risk); triage-agent already records model and latency per decision.
- **Selected Approach**: `CallLogSink` writing one JSON object per line to `KHIPU_LLM_CALL_LOG` file (append) or stderr. Docker captures stderr on the cloud box.
- **Trade-offs**: Not queryable via SQL; acceptable for audit, and a DB sink can be added later behind the same interface.
- **Phase 5 cross-spec decision D6**: confirmed no table, so this spec adds no `schema.ts` module and no `SCHEMA_MODULES` entry. A later DB sink would follow D6 (DDL-only module registered in `src/schema-registry.ts`).

### Decision: Simplification
- No streaming, no `tool_choice`, no temperature defaults beyond pass-through, no per-call provider override, no provider registry: exactly two transports chosen by a switch in the factory.
- Fallback limited to one fixed target (`ollama`) with one attempt.

## Risks & Mitigations
- Muse Spark not available in the user's country or server region: verify manually; local fallback (Req 7); region denial mapped to a fallback-eligible category.
- Content leakage to a training-enabled model: docs call out Contributor-mode ids; call log records model id for audit.
- Remote `OLLAMA_HOST` users break after upgrade: explicit error text naming `KHIPU_LLM_ALLOW_CLOUD=1`.
- Small local models produce invalid JSON for structured calls: one corrective retry, then a typed `structured_output_invalid` error so triage can degrade (its own rules decide).
- Usage field names unverified for Meta: null-safe parsing, live check during implementation.
- `ajv` only present transitively: add as a direct dependency in a foundation task.

## References
- [Meta Model API docs index](https://ai.developer.meta.com/docs/) : base URL and auth
- [Models](https://dev.meta.ai/docs/models.md) : model ids, recommended 1.3, country availability note
- [Tool calling](https://dev.meta.ai/docs/tool-calling) : tool request and response shapes, tool_choice limits
- [Structured output](https://dev.meta.ai/docs/structured-output) : response_format and strict subset
- [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) : prices, RPM/TPM, Contributor data use
- [Error handling](https://dev.meta.ai/docs/error-handling) : status codes, retry, Retry-After
- [Ajv](https://ajv.js.org/) : JSON Schema validator adopted for client-side validation
