# Implementation Plan

- [ ] 1. Foundation: dependency, neutral vocabulary, errors, configuration, test fixture
- [ ] 1.1 Promote the schema validator to a direct dependency and define the provider-neutral types and ports
  - Add the JSON Schema validator as a direct runtime dependency at the version already resolved in the lockfile, with no other dependency changes
  - Define the neutral message, tool, tool-call, usage, finish-reason, provider-info, response, structured request/result, client, and transport types exactly as specified in the design, with no `any` and no import of any provider package
  - The new module compiles under the test runner when imported by a trivial test (repo-wide `tsc` is known to be broken, so it is not the gate) and the dependency is listed in the manifest
  - _Requirements: 2.1, 2.2, 2.3, 2.6, 3.2_

- [ ] 1.2 Implement the error vocabulary, human-readable messages, and fallback eligibility
  - One error type carrying exactly one of the thirteen categories plus optional status, problems, attempts, primary category, and provider info
  - Human-readable messages always name provider, endpoint host, and model, give the next step for configuration, cloud-not-allowed (including the remote Ollama migration hint), unreachable, authentication, region/permission, and model-not-found, and never contain an API key
  - Fallback eligibility returns true only for unreachable, timeout, server, rate limited, authentication, and permission denied
  - New tests in `tests/llm-errors.test.ts` cover every category's message and the eligibility table, and pass
  - _Requirements: 1.7, 4.5, 6.1, 6.5, 7.1, 7.2_

- [ ] 1.3 Implement configuration resolution and destination classification
  - Resolve the `KHIPU_LLM_*` settings of the design settings table (except `KHIPU_LLM_LOCAL_HOSTS`, added by task 1.5) plus legacy `OLLAMA_HOST` / `OLLAMA_MODEL` from an injected environment with the documented defaults and precedence
  - Collect every configuration problem (missing endpoint or model for openai-compatible, unknown provider listing accepted values, bad URL or scheme, credentials in URL, invalid timeout, invalid fallback, fallback with an Ollama primary) into a single configuration error
  - Classify `localhost`, `127.0.0.0/8`, and `::1` as local and every other host, including private addresses and single-label hosts, as cloud (task 1.5 adds the operator-declared local-hosts exception); expose host-only endpoint identity
  - Unit tests for defaults, precedence, each problem, the classification table, and absence of the API key in all problem text pass
  - Creates new modules and tests only; `src/ask.ts` and `tests/ask.test.ts` are not touched (task 4.1 owns their migration)
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 4.1, 7.5_

- [ ] 1.4 Provide a reusable scripted fake transport for tests
  - A test fixture that implements the transport port, returns scripted responses or errors in order, records every request it receives, and accepts a configurable provider info (local or cloud)
  - A small self-test demonstrates scripted responses and recorded requests, and passes
  - _Requirements: 2.1, 2.2_

- [ ] 1.5 Add operator-declared local hosts to configuration and destination classification
  - Parse `KHIPU_LLM_LOCAL_HOSTS` as comma-separated entries: trim, drop empty entries, lowercase, deduplicate; accept only plain hostnames (dot-separated labels of letters, digits, and hyphens, no IP literals) and report one configuration problem per invalid entry (wildcard, IP, port, scheme, path, empty label), collected with the other configuration problems
  - Classify an endpoint as local when its hostname exactly equals a listed entry (case-insensitive, no suffix matching), for both the primary and the fallback endpoint, and mark that endpoint as local by operator declaration; loopback and `localhost` rules are unchanged and an empty list keeps the default classification
  - Unit tests in `tests/llm-config.test.ts` pass for: listed host local regardless of case, subdomain of a listed host still cloud, unlisted single-label host still cloud, each invalid entry form reported with the setting name, empty entries ignored, the fallback endpoint honoring the list, and the local-by-operator mark set only for listed hosts
  - _Depends: 1.3_
  - _Requirements: 4.1, 4.6, 4.7, 7.5_

- [ ] 2. Core: policy helpers and provider adapters
- [ ] 2.1 (P) Implement structured-output schema compilation and answer validation
  - Compile caller schemas once (cached), rejecting invalid names, non-object roots, and schemas the validator refuses with a schema error before any provider is contacted
  - Validate an answer by stripping one optional surrounding code fence, parsing JSON, and checking the schema, returning either a typed value or at most ten readable problems
  - Build the corrective user turn that names the schema and lists the problems
  - Unit tests for schema errors, fenced answers, non-JSON answers, and schema violations pass
  - _Requirements: 3.2, 3.3, 3.4, 3.5_
  - _Boundary: StructuredValidator_

- [ ] 2.2 (P) Implement the cloud call-log entry and sinks
  - Entry carries timestamp, provider, endpoint host, model, operation, purpose, outcome, error category, duration, attempt, and token counts; content (request turns and answer) is present only when content logging is enabled
  - File sink appends one JSON line per entry with owner-only permissions; otherwise one JSON line per entry goes to standard error
  - A failing write never throws to the caller and reports one standard-error notice instead
  - Unit tests show default entries contain no message text, prompts, tool data, answers, or key, content appears only when enabled, and a throwing writer is contained
  - _Requirements: 1.7, 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Boundary: CallLog_

- [ ] 2.3 (P) Implement the Ollama transport
  - Map neutral turns, tools, response schema, temperature, and output-token limit to the local Ollama request, and map the reply back with synthesized call ids, finish reason, and usage (unknown when not reported)
  - Reject non-object tool arguments as an invalid response naming the tool
  - Apply the per-request timeout through the client's fetch hook and map refused connections, missing models, aborts, and other failures to the matching categories (reimplementing the current Ollama error classification in the new module; the old function in the ask module is removed later by task 4.1, not here)
  - Unit tests with an injected Ollama port verify tool-call round trip, schema passed as the output format, usage mapping, and each error mapping
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 6.1, 6.4_
  - _Boundary: OllamaTransport_

- [ ] 2.4 (P) Implement the Chat Completions wire mapping and HTTP error mapping
  - Build requests with model, turns (assistant tool-call turns replayed in full, tool results keyed by call id), tools, strict JSON-schema response format, and optional temperature and output-token limit; never emit a tool-choice field or streaming
  - Parse responses from untyped JSON with type guards: empty content for null, tool arguments parsed and required to be objects, finish reasons mapped, usage read when numeric
  - Map HTTP statuses to categories per the design table, including 404 without a JSON error body as a base-URL configuration problem
  - New tests in `tests/llm-openai-wire.test.ts` cover request shape, response parsing, malformed arguments, missing usage, and every status mapping
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 6.1_
  - _Boundary: OpenAiWire_

- [ ] 2.5 Implement the OpenAI-compatible transport with timeout and bounded retry
  - POST to the chat completions path under the configured base URL with JSON body and bearer authorization when a key is configured
  - Abort each attempt after the configured timeout and report a timeout; report network failures as unreachable
  - Retry only rate-limited and server failures, at most twice, honoring the provider-advised delay capped at 30 seconds and otherwise an increasing delay with jitter; never retry other 4xx failures
  - Tests with injected fetch and sleep verify advised-delay retry, exhaustion after three attempts, no retry on invalid request and authentication, timeout on a hanging request, the bearer header, and that no thrown message contains the key
  - _Depends: 2.4_
  - _Requirements: 1.4, 1.7, 6.2, 6.3, 6.4_

- [ ] 3. Composition: client policy, fallback, factory
- [ ] 3.1 Implement the client with the cloud egress gate, call logging, and free-text chat
  - Before every transport call, refuse cloud destinations unless cloud use is enabled, with no transport call made; local destinations never need the opt-in
  - Free-text chat passes turns and tools through and returns the transport response unchanged; provider errors propagate with their category
  - Write exactly one call-log entry per transport call to a cloud destination (success or failure) and none for local destinations
  - Tests with the fake transport verify zero transport calls when blocked, allowed calls with opt-in, log entry count and fields, and no logging for local
  - _Depends: 1.4, 2.2_
  - _Requirements: 4.2, 4.3, 4.4, 5.1, 5.6_

- [ ] 3.2 Add structured chat with one corrective retry to the client
  - Compile the schema before the gate and any provider call; request the answer with the response schema and validate it
  - On a parse or validation failure, append the previous answer and the corrective turn and retry exactly once; on a second failure raise the structured-output error with the problems and two attempts and no partial value
  - Return value, raw answer, attempt count, usage summed across attempts (unknown if any attempt was unknown), and the serving provider; one log entry per attempt with its attempt number
  - Tests verify first-try success, invalid then valid, invalid twice, invalid schema without provider contact, and that the client never alters caller prompts or schema content
  - _Depends: 2.1_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 5.1_

- [ ] 3.3 Implement the local fallback composition
  - On a fallback-eligible primary failure, send the same request once to the fallback client and write a standard-error notice naming the fallback host and model; non-eligible failures propagate unchanged
  - Results report the provider and model that actually served them; a failed fallback raises the fallback category together with the primary category
  - Tests cover unreachable primary served by fallback, invalid-request primary not falling back, both failing, and a remote fallback host blocked by the gate
  - _Depends: 3.1, 3.2_
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 3.4 Implement the factory that builds the configured client from the environment
  - Resolve configuration, construct the transport for the selected provider, wrap it in the policy client with the shared sink and content setting, and wrap with fallback when configured
  - Configuration errors are raised at construction; gate errors at call time
  - For each endpoint classified local only through the local-hosts setting, write one standard-error notice at construction naming the host and the setting (host only, never path or key); no notice otherwise
  - Tests with injected fetch, Ollama port, and sink verify empty environment yields a local Ollama client, openai-compatible settings yield a cloud client with host-only info, fallback wiring, that a call-log file setting appends JSON lines to a temporary file, that an Ollama primary with a non-loopback `OLLAMA_HOST` and no opt-in is refused at call time with the migration hint and no request made, and that the same Ollama primary with `KHIPU_LLM_LOCAL_HOSTS` listing its host succeeds without the opt-in, writes no call-log entry, and writes exactly one local-hosts notice
  - _Depends: 1.5, 2.2, 2.3, 2.5, 3.2, 3.3_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 4.5, 4.6, 4.8, 5.4, 7.5_

- [ ] 4. Integration: `khipu ask`, configuration example, documentation
- [ ] 4.1 Move `khipu ask` onto the neutral client and migrate its tests
  - Replace Ollama-specific config, tool mapping, and error classification in the ask module with the neutral tool mapping (identical to the shared registry), the factory, and the categorized error messages; tag calls with the ask purpose
  - Keep the system prompt, 8-iteration cap, 8000-character tool-result bound, dispatch-error feedback, and iteration-limit text unchanged
  - Print usage listing every LLM setting for an empty question or `--help`; on failure print the categorized message to standard error and exit 1; update the `ask` help summary in the command router
  - Give the CLI entry an optional dependency parameter (client factory) so tests can inject a fake client for the configured-provider and error-exit paths; production callers pass nothing
  - Migrated ask tests (tool call then answer, cap, dispatch failure, immediate answer, tool list equals registry, help text, error exit) pass and the ask-parity test passes unchanged
  - _Depends: 1.2, 3.4_
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ] 4.2 (P) Document the LLM settings and the cloud flow
  - Add a commented block with all ten settings and local-only defaults to the example environment file
  - Add a README section listing each setting and default, the Muse Spark endpoint and recommended model, that the opt-in sends caller-selected message content to the provider, the Contributor-mode training warning, the geographic availability caveat with the local fallback as mitigation, the call-log line format, the remote `OLLAMA_HOST` migration note, the local-hosts setting with its hostname-only format, the compose example `KHIPU_LLM_LOCAL_HOSTS=ollama`, and the security note that listing a host asserts it is private because its traffic bypasses the opt-in and the call log, and that `KHIPU_LLM_API_KEY_FILE` works through cloud-deployment's secret file loading
  - Both files contain every setting name from the design settings table
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - _Boundary: Docs_

- [ ] 5. Validation
- [ ] 5.1 Run end-to-end scenarios and the full regression suite
  - All scenarios build the client through the factory from an environment pointing at a Muse-shaped endpoint, with injected fake fetch, injected no-op sleep, injected fake Ollama port, and an in-memory sink
  - Scenario A (opt-in on): a structured call whose endpoint first returns invalid JSON then a valid verdict-shaped object yields the typed value, two attempts, and exactly two content-free log lines (attempt 1 and 2)
  - Scenario B (opt-in and fallback on): the endpoint returns 503 three times; exactly three fetch calls are made, exactly one cloud log line with the server category is written, and the result is served by the fake Ollama port with no further log line (local destination)
  - Scenario C: scenario A without the opt-in fails with cloud-not-allowed and zero fetch calls
  - Scenario D (compose sibling Ollama): Ollama provider at `http://ollama:11434` with `KHIPU_LLM_LOCAL_HOSTS=ollama` and no opt-in answers through the fake Ollama port with zero call-log lines and one local-hosts notice
  - The full test suite passes under Node 24 with no new failures, including ask-parity
  - _Requirements: 3.3, 4.2, 4.6, 5.2, 6.2, 7.1, 8.1_

- [ ]* 5.2 Add an opt-in live smoke test against the Meta Model API to settle open items
  - Skipped unless a live-test flag and a real key are present; sends one tiny chat and one tiny structured call to the configured Muse Spark model
  - Records whether usage fields are populated under the assumed names and whether the output-token limit field is accepted, and fails with a clear message otherwise
  - Covers acceptance criteria 2.6 and 3.1 against the real provider; deferrable because unit and integration tests already guarantee behavior against the documented contract
  - _Requirements: 2.6, 3.1_
