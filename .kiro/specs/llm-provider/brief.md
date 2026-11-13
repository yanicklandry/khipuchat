# Brief: llm-provider

## Problem
The user wants an intermediate assistant, Muse, to read incoming messages and decide what matters. khipuchat can only talk to a local Ollama model today. Also: `muse.ai` (Meta's consumer Muse agent, launched 2026-09-08) has no public API, so the callable target is **Muse Spark**, Meta's developer model on the Meta Model API.

## Current State
- `src/ask.ts` runs an Ollama tool-call loop (`ollama` ^0.6.3, `OLLAMA_HOST`, `OLLAMA_MODEL` default `qwen2.5`, 8-iteration cap, 8000-char tool result cap).
- `runAskLoop` already takes an `AskClient` interface, but typed with Ollama's `Message`/`Tool` shapes.
- `src/tool-registry.ts` holds `TOOL_DEFINITIONS` + `dispatchTool` shared with MCP.

## Desired Outcome
Any khipuchat LLM caller (`khipu ask`, triage-agent) picks a provider by config: `ollama` (local, default) or `openai-compatible` (Muse Spark via Meta Model API as the first configured target; also works for other compatible endpoints). Structured JSON output is supported so triage can get a typed verdict. Using a cloud provider requires an explicit opt-in flag, and every cloud call is logged (provider, model, token counts, no content by default).

## Approach
Introduce provider-neutral `LlmMessage` / `LlmTool` / `LlmResponse` types and an `LlmClient` interface (`chat`, `chatStructured(schema)`). Adapters: `ollama-client.ts` (wrap existing), `openai-compatible-client.ts` (plain `fetch` to `/v1/chat/completions` with tools and `response_format: json_schema`; no SDK needed). Config: `KHIPU_LLM_PROVIDER`, `KHIPU_LLM_BASE_URL`, `KHIPU_LLM_MODEL`, `KHIPU_LLM_API_KEY`, `KHIPU_LLM_ALLOW_CLOUD=1`. `ask.ts` moves to the neutral interface; ask-parity tests stay green. Verify Muse Spark model ids, base URL, and pricing against primary Meta docs during design (secondary sources disagree).

## Scope
- **In**: neutral types + interface, two adapters, config + opt-in gate, structured output helper with schema validation and one retry, call log, refactor of `ask.ts`, tests with a fake client.
- **Out**: streaming UI, model management/pull, fine-tuning, prompt design for triage (triage-agent owns prompts), Anthropic-native adapter (can be added later; openai-compatible covers the stated need).

## Boundary Candidates
- Neutral LLM types + interface
- Provider adapters (one file each)
- Config + cloud opt-in gate + call log

## Out of Boundary
- What questions are asked and what the verdict schema is (triage-agent).

## Upstream / Downstream
- **Upstream**: ollama-mcp (`ask.ts`, `tool-registry.ts`).
- **Downstream**: triage-agent, `khipu ask`.

## Existing Spec Touchpoints
- **Extends**: ollama-mcp (`AskClient` generalization).
- **Adjacent**: mcp.ts / tool-registry.ts (unchanged contract).

## Constraints
- Muse Spark is a US-only preview: availability from the user's location/server region must be verified; Ollama fallback must work if Muse is unreachable.
- Message content leaving the machine is a Phase 5 rewritten-constraint item: opt-in, logged, documented.
- TS strict, no `any`, files under 200 lines.
