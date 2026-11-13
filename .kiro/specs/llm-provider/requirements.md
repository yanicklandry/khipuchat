# Requirements Document

## Project Description (Input)
**Who has the problem**: The khipuchat user, who wants an intermediate assistant (Muse) to read incoming messages and decide what matters, and every khipuchat feature that needs a language model (`khipu ask` today, triage-agent next).

**Current situation**: khipuchat can only talk to a local Ollama model. `src/ask.ts` runs an Ollama tool-call loop (`ollama` ^0.6.3, `OLLAMA_HOST`, `OLLAMA_MODEL` default `qwen2.5`, 8-iteration cap, 8000-char tool result cap). `runAskLoop` already takes an `AskClient` interface, but it is typed with Ollama's `Message`/`Tool` shapes. `muse.ai` (Meta's consumer Muse agent, launched 2026-09-08) has no public API, so the callable target is Muse Spark, Meta's developer model on the Meta Model API.

**What should change**: Any khipuchat LLM caller picks a provider by configuration: `ollama` (local, default) or `openai-compatible` (Muse Spark via the Meta Model API as the first configured target; also usable with other compatible endpoints). Structured JSON output is supported so triage can get a typed verdict. Using a cloud provider requires an explicit opt-in flag, and every cloud call is logged (provider, model, token counts, no content by default). `khipu ask` moves onto the provider-neutral interface and its parity tests stay green. Out of scope: streaming UI, model management, fine-tuning, triage prompt and verdict-schema design (triage-agent), an Anthropic-native adapter.

## Introduction
The LLM Provider feature gives khipuchat one provider-neutral way to talk to a language model. Callers (the `khipu ask` command and the upcoming triage agent) send a conversation, optionally with archive tools, and receive either a free-text answer or a schema-validated structured result, without knowing which provider served it. Two provider kinds are supported: a local Ollama server (the default, unchanged behavior) and any OpenAI-compatible chat endpoint, with Muse Spark on the Meta Model API as the first documented target. Because Phase 5 rewrites the "no cloud" constraint, sending message content off the machine is never implicit: it requires an explicit opt-in, and every such call is recorded in a content-free call log.

## Boundary Context
- **In scope**: provider selection by configuration; provider-neutral conversation, tool-call and structured-output behavior; the "content leaves the machine" opt-in gate; the cloud call log; error reporting, bounded retry and timeout; optional fallback to the local provider; moving `khipu ask` onto the neutral interface; operator documentation of the settings.
- **Out of scope**: streaming output, model download or management, fine-tuning, an Anthropic-native provider, which questions triage asks and what its verdict schema contains (triage-agent), deciding which messages may be sent to a cloud model (triage-agent rules), deployment on the server (cloud-deployment), secret storage (owned by cloud-deployment's `_FILE` secret allowlist, Phase 5 cross-spec decision D2, which lists `KHIPU_LLM_API_KEY` so `KHIPU_LLM_API_KEY_FILE` works), any database table (this feature adds none; its call log is a JSON-lines file), and the new-message event stream (message-events).
- **Adjacent expectations**: triage-agent supplies its own prompts and verdict schema and consumes the structured-output capability; cloud-deployment supplies the environment in which the settings are provided, loads `KHIPU_LLM_API_KEY` from `KHIPU_LLM_API_KEY_FILE` before this feature reads its settings, and documents the local-hosts setting in its deployment guide (decision D10); the archive tool registry shared with MCP keeps its existing contract and is not changed by this feature.

## Requirements

### Requirement 1: Provider selection by configuration
**Objective:** As the khipuchat user, I want to choose the language model provider through configuration, so that every LLM feature uses the same provider without code changes.

#### Acceptance Criteria
1. The LLM Provider shall support exactly two provider kinds, `ollama` and `openai-compatible`, selected by one provider setting.
2. When no provider setting is present, the LLM Provider shall use the `ollama` provider with the existing default endpoint (`http://127.0.0.1:11434`) and default model (`qwen2.5`).
3. While the `ollama` provider is selected, the LLM Provider shall continue to honor the existing `OLLAMA_HOST` and `OLLAMA_MODEL` settings, with the generic endpoint and model settings taking precedence when both are present.
4. When the `openai-compatible` provider is selected, the LLM Provider shall take its endpoint, model, and optional API key from the generic endpoint, model, and API key settings.
5. If the `openai-compatible` provider is selected and the endpoint or model setting is missing, then the LLM Provider shall refuse to start the call and report a configuration error naming each missing setting.
6. If the provider setting holds an unrecognized value, then the LLM Provider shall refuse to start the call and report a configuration error listing the accepted values.
7. The LLM Provider shall never include the API key value in any error message, log entry, or command output.

### Requirement 2: Provider-neutral conversation and tool calling
**Objective:** As a khipuchat developer building an LLM feature, I want one conversation interface that works the same for every provider, so that callers such as `khipu ask` and triage never depend on a provider's message format.

#### Acceptance Criteria
1. The LLM Provider shall accept a conversation made of system, user, assistant, and tool-result turns, plus an optional list of tools, in one provider-independent form.
2. When the model answers without requesting tools, the LLM Provider shall return the answer text, the reason the answer ended, and the token usage reported by the provider.
3. When the model requests one or more tool calls, the LLM Provider shall return each call with a stable call identifier, the tool name, and the parsed arguments as a key/value object.
4. When a caller returns a tool result referencing a call identifier, the LLM Provider shall deliver that result to the model associated with the matching call in the provider's expected form.
5. If the model returns tool-call arguments that are not a valid key/value object, then the LLM Provider shall report an invalid-response error that names the tool instead of passing malformed arguments to the caller.
6. Where the provider does not report token usage, the LLM Provider shall report the usage as unknown rather than zero.

### Requirement 3: Structured output
**Objective:** As the triage agent, I want to request an answer that conforms to a JSON schema I supply, so that I receive a typed verdict I can store and act on.

#### Acceptance Criteria
1. When a caller requests structured output with a named JSON schema, the LLM Provider shall ask the selected provider to constrain its answer to that schema.
2. When the model's answer parses as JSON and conforms to the schema, the LLM Provider shall return the parsed value together with the raw answer text, token usage, and attempt count.
3. If the model's answer does not parse as JSON or does not conform to the schema, then the LLM Provider shall retry exactly once, telling the model what was wrong with its previous answer.
4. If the retried answer still does not parse or conform, then the LLM Provider shall report a structured-output error that includes the validation problems and the number of attempts, and shall not return a partial value.
5. If the caller supplies a schema that is itself invalid, then the LLM Provider shall report a schema error before contacting any provider.
6. The LLM Provider shall leave the content of the schema, prompts, and verdict meaning to the caller.

### Requirement 4: Cloud egress opt-in gate
**Objective:** As the khipuchat user, I want message content to leave my machine only when I have explicitly allowed it, so that local-only remains the default and no cloud flow happens by accident.

#### Acceptance Criteria
1. The LLM Provider shall classify a configured endpoint as local only when its host is a loopback address, `localhost`, or a hostname listed in the local-hosts setting (4.6), and as cloud otherwise, independently of the provider kind.
2. While the cloud opt-in setting is not exactly enabled, if the configured endpoint is classified as cloud, then the LLM Provider shall refuse every call before any network request and report that cloud use requires the opt-in setting.
3. While the cloud opt-in setting is enabled, the LLM Provider shall allow calls to a cloud endpoint.
4. When the endpoint is classified as local, the LLM Provider shall allow calls without the opt-in setting.
5. If an existing `OLLAMA_HOST` points at a non-loopback host and the opt-in setting is absent, then the LLM Provider shall refuse the call with a message that explains the new opt-in requirement.
6. Where the local-hosts setting (`KHIPU_LLM_LOCAL_HOSTS`) lists one or more comma-separated hostnames, the LLM Provider shall classify an endpoint (primary or fallback) whose hostname equals one of them, compared case-insensitively and exactly, as local, so that calls to it need no cloud opt-in and write no call-log entry.
7. If the local-hosts setting contains an entry that is not a plain hostname (for example a wildcard, an IP address, a port, a scheme, or a path), then the LLM Provider shall refuse to start the call and report a configuration error naming the setting and each invalid entry.
8. When an endpoint is classified as local only because of the local-hosts setting, the LLM Provider shall write one standard-error notice naming that endpoint host and the setting, once per client construction.

### Requirement 5: Cloud call log
**Objective:** As the khipuchat user, I want a record of every call that sent content to a cloud model, so that I can audit what left the machine and what it cost.

#### Acceptance Criteria
1. When a call to a cloud endpoint completes or fails, the LLM Provider shall write one call-log entry containing timestamp, provider kind, endpoint host, model, operation (free-text or structured), caller purpose, outcome, error category when failed, duration, attempt number, and prompt and completion token counts when reported.
2. The LLM Provider shall exclude message content, prompts, tool arguments, tool results, model answers, and the API key from call-log entries by default.
3. Where the content-logging setting is enabled, the LLM Provider shall additionally include the request turns and the model answer in each call-log entry.
4. Where a call-log file setting is present, the LLM Provider shall append each entry as one line to that file; otherwise it shall write each entry as one line to standard error.
5. If writing a call-log entry fails, then the LLM Provider shall still return the call result to the caller and report the logging failure on standard error.
6. When a call targets a local endpoint, the LLM Provider shall not write a call-log entry.

### Requirement 6: Error reporting, retry, and timeout
**Objective:** As a khipuchat user or caller, I want failures to be reported as clear categories with bounded waiting, so that I know what to fix and callers can degrade safely.

#### Acceptance Criteria
1. If a call fails, then the LLM Provider shall report exactly one error category among: configuration, cloud not allowed, unreachable, authentication, permission or region denied, model not found, rate limited, invalid request, server error, timeout, invalid response, schema error, and structured-output invalid.
2. If the provider reports rate limiting, a server error, or temporary unavailability, then the LLM Provider shall retry the call at most 2 more times, waiting the provider-advised delay when given (capped at 30 seconds) and an increasing delay otherwise.
3. If the provider reports an invalid request, authentication, permission, or not-found failure, then the LLM Provider shall not retry the call.
4. If a single provider request does not complete within the configured timeout (default 60 seconds), then the LLM Provider shall abandon it and report a timeout.
5. When a call fails, the LLM Provider shall give a human-readable message naming the provider, endpoint host, and model, plus a concrete next step for configuration, unreachable, authentication, region, and model-not-found failures.

### Requirement 7: Local fallback when the cloud provider is unavailable
**Objective:** As the khipuchat user running on a server, I want LLM features to keep working on my local Ollama model when Muse Spark cannot be used, so that triage does not go silent if the cloud model is unreachable or unavailable in my region.

#### Acceptance Criteria
1. Where the fallback setting names `ollama`, when a call to the primary provider fails with an unreachable, timeout, server error, rate limited, authentication, or permission or region denied category, the LLM Provider shall repeat the same call once on the local Ollama provider.
2. If the primary call fails with an invalid request, schema error, structured-output invalid, or configuration category, then the LLM Provider shall report that failure without falling back.
3. When a fallback call is made, the LLM Provider shall report to the caller which provider and model actually produced the result.
4. If the fallback call also fails, then the LLM Provider shall report the fallback failure together with the primary failure category.
5. The LLM Provider shall apply the cloud egress gate to the fallback endpoint in the same way as to the primary endpoint.

### Requirement 8: `khipu ask` on the provider-neutral interface
**Objective:** As the khipuchat user, I want `khipu ask` to keep working exactly as before by default and to use the configured provider when I choose one, so that the refactor costs me nothing and unlocks Muse Spark for archive questions.

#### Acceptance Criteria
1. When `khipu ask "<question>"` runs with no LLM settings, the khipu CLI shall answer through the local Ollama provider with the same system prompt, the same archive tools, an 8-iteration tool-call cap, and an 8000-character bound on each tool result.
2. When an LLM provider is configured, the khipu CLI shall answer `khipu ask` through that provider using the same tool loop.
3. If the provider call fails, then the khipu CLI shall print the categorized human-readable message on standard error and exit with status 1.
4. When `khipu ask` is run without a question or with `--help`, the khipu CLI shall print usage that lists the provider, endpoint, model, API key, cloud opt-in, fallback, and call-log settings.
5. The khipu CLI shall keep the archive tools available to `khipu ask` identical to the tools exposed over MCP.

### Requirement 9: Operator documentation of outbound LLM flows
**Objective:** As the khipuchat user, I want the cloud LLM flow documented where I configure khipuchat, so that I know exactly what is sent, where, and how to turn it on or off.

#### Acceptance Criteria
1. The khipuchat documentation shall list every LLM setting with its default, including the documented Muse Spark endpoint and recommended model values.
2. The khipuchat documentation shall state that enabling the cloud opt-in sends message content selected by the caller to the configured provider, and that Meta's Contributor-mode models permit Meta to train on that content.
3. The khipuchat documentation shall state that Muse Spark availability depends on Meta's geographic use policy and that the local fallback is the recommended mitigation.
4. The example environment file shall include every LLM setting, commented out, with the local-only defaults.
5. The khipuchat documentation shall describe the local-hosts setting, its hostname-only format, and a compose example (`KHIPU_LLM_LOCAL_HOSTS=ollama`), and shall state that by listing a host the operator asserts it is a private destination under their control, because content sent to it is neither gated by the cloud opt-in nor recorded in the call log.
6. The khipuchat documentation shall state that `KHIPU_LLM_API_KEY` can be supplied through `KHIPU_LLM_API_KEY_FILE`, as provided by cloud-deployment's secret file loading.
