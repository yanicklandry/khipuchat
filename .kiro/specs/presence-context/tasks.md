# Implementation Plan

> Prerequisites from message-events (designed, not yet implemented): task 1.3 needs the schema registry (`src/schema-registry.ts` with its ordered `SCHEMA_MODULES` list, called once from `initDb`, decision D6). Until it lands, 1.3 can be built and unit-tested against `applyPresenceSchema` directly, but its registry entry and the `initDb` check wait for it.
>
> Prerequisites from cloud-deployment (designed, not yet implemented): tasks 4.1 and 6.2 need the ingress (`src/ingress/types.ts` with `IngressContext.env` (D4), `src/ingress/modules.ts`, `createIngressApp`, the ingress isolation test over the transitive import closure); task 5.2 needs `src/db-path.ts` (`resolveDbPath`, cloud-deployment task 1.1); task 6.1 needs `docs/DEPLOYMENT.md` and the environment-template consistency test that cloud-deployment creates. Every other task is independent of cloud-deployment and can start immediately.
>
> Manual gate: task 1.1 must be run by the operator on a real Mac (permission prompt, sleep and wake). Autonomous implementation must pause at 1.1 and wait for the recorded verdict before starting 2.3, 2.4, 4.2 and 5.2.

- [ ] 1. Foundation: go/no-go spike, shared types, settings, storage, shared launchd helper
- [ ] 1.1 Laptop location go/no-go spike on a real Mac (manual operator gate)
  - Operator-run: needs a person at the Mac to grant the permission prompt and to sleep and wake the machine; blocks 2.3, 2.4, 4.2 and 5.2
  - Install CoreLocationCLI from the Homebrew cask, run it once in Terminal with the coordinate-only format, and grant the location permission when macOS asks
  - Load a throwaway per-user LaunchAgent (GUI session, calendar schedule every minute, run at load) that runs the same command and writes its output to a log, then lock and sleep the Mac for at least 3 minutes and wake it
  - Confirm three things: the agent obtains a fix without a new prompt, a run happens shortly after wake, and the coordinate-only format triggers no address lookup (no address fields in output)
  - Record the verdict (GO, or NO-GO with the observed error and the fallback chosen: login-item runner or laptop left as unknown) and exact command output in a new "Spike result" section of research.md, then remove the throwaway agent
  - Done when research.md contains a dated GO or NO-GO verdict with evidence; on NO-GO, stop before tasks 2.3, 2.4, 4.2 and 5.2's agent commands and return to design
  - _Requirements: 3.1, 3.4, 4.1, 4.2_

- [ ] 1.2 Presence types and settings resolution
  - Define the shared presence vocabulary from the design contract: device roles, sources, together state, unknown reasons, new and stored fixes, device presence, local time, thresholds, snapshot, view, precision, and the configuration error carrying a problem list
  - Resolve every server-side presence setting with its default (together threshold 200 m, phone staleness 180 min, laptop staleness 30 min, max combined accuracy 1000 m, retention 50 fixes and 7 days, coarse LLM precision, optional phone device id and default timezone) and parse the named places syntax with optional timezone
  - Resolve laptop reporter settings (server URL, token, interval that must divide 60, optional location tool path) separately so the server never requires them
  - Provide the timezone-name validation helper used by settings, payload parsing and local time, and apply it to place and default timezones
  - Report every invalid setting or place entry at once, each naming the setting or entry, and never echo the token value
  - Take the environment as a required argument with no implicit process environment fallback, so the ingress can pass its context environment (D4); every setting, including named places, stays an inline environment value, and no data file is read (D5)
  - Done when unit tests show defaults on an empty environment, a named problem for each invalid value, malformed and duplicate places rejected, invalid timezone names rejected, and no token text in any error
  - _Requirements: 6.4, 6.6, 7.4, 5.1, 1.7, 9.2_

- [ ] 1.3 Device location storage with retention
  - Define the device locations table and its role and fix-time index idempotently in a DDL-only presence schema module that imports nothing but database types, and register it with one import and one entry in message-events' schema registry; do not modify the archive module and do not create tables lazily from the store (D6)
  - Record a fix with duplicate suppression on device, source, and fix time, and prune that role beyond the retention count and age in the same transaction
  - Read the current fix per role by greatest fix time regardless of arrival order, count fixes per role, and delete all fixes returning the count
  - Persist only the allowed fields so nothing else from a payload can be stored
  - Done when in-memory database tests show the table created through archive initialisation via the registry entry, the schema module importing only types, duplicates ignored, pruning limited to the inserted role, out-of-order arrival still yielding the latest fix, forget returning the deleted count, and existing archive tests still passing
  - _Requirements: 1.5, 2.5, 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Depends: message-events schema registry_

- [ ] 1.4 (P) Shared launchd plist helper
  - Build a feature-neutral module at the source root that turns a typed background-job description (label, program arguments, working directory, calendar or interval schedule, run at load, keep alive, throttle interval, session type, process type, log paths, optional environment) into a deterministic, fully XML-escaped plist, rejecting invalid jobs with the offending field named
  - Install or replace a job in the user's login session (macOS only: boot out an existing job, ignoring not-loaded, write the plist, bootstrap it), uninstall it (boot out, delete, report removed or absent), and report installed status; call launchctl with an argument list, never a shell, with every side effect injectable for tests
  - Import only Node built-ins and nothing from presence or any other feature, so action-runner's laptop agent and the sync background job fix (roadmap setup-sync-stale-path) can reuse it unchanged; this module's exported contract is a revalidation trigger for action-runner (D9)
  - Done when unit tests show the plist for a calendar job, an interval job and a keep-alive job with throttle, special characters in paths escaped, invalid label and empty arguments rejected naming the field, nothing written on Linux, reinstall booting out before bootstrap, uninstall reporting absent when nothing is installed, and an import scan finding only Node built-ins
  - _Requirements: 4.1, 4.4, 4.5, 4.6_
  - _Boundary: LaunchdPlist_

- [ ] 2. Core logic and laptop building blocks
- [ ] 2.1 (P) Distance, place containment, and local time
  - Compute great-circle distance between two points and resolve a point to the nearest named place whose radius contains it, or none
  - Produce local time (ISO with offset, short weekday and time display, zone, and which source supplied it) following the place, fix, configured default, server order
  - Use no network and no external dataset
  - Done when unit tests confirm known city-pair distances within 0.5 percent, containment and nearest-place tie handling, and the four timezone sources in order
  - _Requirements: 6.5, 7.1, 7.3, 7.5_
  - _Boundary: Geo, LocalTime_

- [ ] 2.2 (P) OwnTracks and generic report payload parsing
  - Parse OwnTracks messages: keep latitude, longitude, accuracy, fix time and device id; classify non-location types, encrypted messages, empty bodies, unknown devices (when a phone id is configured) and too-old fixes as ignored; reject missing or out-of-range fields, zero-zero coordinates and fixes more than 5 minutes ahead with the field name
  - Resolve the OwnTracks device id from header, query parameter, topic, then tracker id
  - Parse generic reports for phone or laptop roles with optional accuracy, fix time (defaulting to receive time), timezone, source label and client id, applying the same validation and too-old rule
  - Done when unit tests cover each ignored kind, each rejected field, device id precedence, field minimisation (battery, SSID, regions dropped), and report defaults
  - _Requirements: 1.3, 1.4, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 5.3_
  - _Boundary: PayloadParser_

- [ ] 2.3 (P) Location tool runner for the laptop
  - Locate the location tool from an explicit path, PATH, or the two Homebrew locations, and report every path searched when absent
  - Run it once without a shell using only coordinate and accuracy format specifiers, with a 30 second kill timeout, and parse latitude, longitude and accuracy (negative accuracy treated as unknown)
  - Map permission denied, no fix, timeout, unparsable output and other failures to distinct errors with one actionable hint each
  - Done when unit tests with an injected process runner prove the exact argument list, each error mapping, and successful parsing
  - _Requirements: 3.1, 3.2, 3.4_
  - _Boundary: CoreLocationRunner_

- [ ] 2.4 LaunchAgent definition and install lifecycle
  - Describe the presence reporter as a job for the shared launchd helper (task 1.4) instead of writing plist text directly
  - Build the per-user agent definition: reporter command with the absolute location tool path, project working directory, calendar entries for every interval step in the hour, run at load, GUI session only, background process type, log file paths, and no environment values or secrets
  - Install: refuse on non-macOS; require reporter settings; run one foreground location lookup and stop with System Settings guidance when permission is denied; then install or replace through the shared helper and report installed or replaced
  - Uninstall and status: delegate to the shared helper's uninstall and status for the presence label, reporting removed or absent
  - Done when unit tests with injected file system, process launcher and locator show 12 calendar entries for a 5 minute interval, no environment block and no token text in the definition, nothing written on denial or on Linux, reinstall performing boot out before bootstrap, and no plist text built outside the shared helper
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - Not parallel with 2.3: it relies on the location runner's result contract for the foreground permission check
  - _Boundary: LaunchAgentManager_
  - _Depends: 1.4, 2.3_

- [ ] 3. Presence snapshot, views, and query handler
- [ ] 3.1 Snapshot computation
  - Mark each role stale by its own limit, list unknown reasons in the fixed order, apply the accuracy cap, and decide together when distance is within the threshold plus combined accuracy (missing accuracy counted as 100 m)
  - Report distance in whole metres whenever both fixes exist, each device's place, the user place (phone if fresh, else laptop if fresh), local time, stale roles and the thresholds used
  - Read the current fixes from storage at a caller-supplied time without writing anything
  - Done when unit tests cover together, apart, each unknown reason, the accuracy cap, stale distance, place fallback, the empty archive answer, and 1000 stored fixes computed in under 50 ms
  - _Requirements: 6.1, 6.2, 6.3, 6.5, 7.2, 8.4, 8.5, 10.1, 10.2, 10.3_

- [ ] 3.2 Coarse and precise views with the LLM precision gate
  - Produce the coarse view (no coordinates, accuracy, receive time, source or timezone per device; distance rounded to the nearest 50 m) and the precise view
  - Gate LLM-bound output on the operator's precision setting, returning coarse plus a note when precise is requested without opt-in
  - Produce the one-line summary (together state, place, local time) that never contains coordinates
  - Done when unit tests show coarse output free of coordinate fields, precise output only with opt-in, the downgrade note, and summary text for together, apart and unknown
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 3.3 Shared presence query handler
  - Answer a presence request for either the LLM surface (precision gate applies) or the operator surface (explicit precise flag suffices), using the shared archive handle
  - Return a configuration error object with the problem list instead of throwing
  - Done when unit tests show the LLM and operator surfaces differ only in precision handling and an invalid setting yields the error object
  - _Requirements: 8.1, 8.4, 9.3, 9.5_

- [ ] 4. Ingestion integration
- [ ] 4.1 Presence ingress module and routes
  - Register a presence module (id presence, 16 KiB body limit) in the ingress module list, resolving presence settings at mount time from the ingress context environment, never the process environment (D4), so invalid settings abort ingress startup with the problem list
  - Handle OwnTracks posts: record valid fixes as phone fixes and reply with an empty JSON array for recorded, duplicate and ignored messages; reply 400 naming the field for invalid locations
  - Handle generic reports: reply recorded, duplicate or too old, or 400 naming the field
  - Log role, source, device id and fix time only, never coordinates
  - Done when supertest runs against the ingress app show Basic auth with any username and the token password recording a fix, a wrong password rejected by the ingress, a transition message acknowledged with nothing stored, 400 replies naming the invalid field on both endpoints, the report endpoint's recorded, duplicate and too-old replies, no payload coordinates in captured logs, an invalid setting supplied only through the context environment aborting mount, and the ingress isolation test (transitive import closure) passing with the module registered and finding no process environment read in that closure
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 5.6_
  - _Depends: 1.3, 2.2_

- [ ] 4.2 (P) Laptop reporter
  - Read the server URL and token from the environment or the project environment file, refuse plain HTTP to non-loopback hosts, obtain a fix, and post a laptop report with accuracy, current system timezone, agent source label and host name, with a 15 second request timeout
  - Map configuration, insecure URL, location, unreachable and rejected outcomes to messages that never contain the token, sending nothing when no fix was obtained
  - Done when unit tests with injected locator and fetch show the exact request body and headers, refusal for a non-loopback HTTP URL, nothing posted on location failure, and token-free error text for unreachable and 4xx responses
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 5.6_
  - _Boundary: LaptopReporter_
  - _Depends: 2.3_

- [ ] 5. Query surfaces
- [ ] 5.1 get_presence tool on MCP and ask
  - Add the get_presence definition with an optional coarse or precise precision argument to the shared tool list and dispatch it to the shared query handler on the LLM surface
  - Update the ask parity test (tool count 9, get_presence dispatch equals the direct handler) and add a get_presence call to the MCP smoke script
  - Done when the ask parity test passes with the new case, the MCP smoke script lists and calls get_presence successfully, and existing tool tests are unchanged
  - _Requirements: 8.1, 9.1, 9.3_

- [ ] 5.2 khipu presence command family
  - Route the presence subcommand from the khipu command router with help text
  - Status: human-readable together state with reasons, distance, place, local time, each device's age and staleness, and agent installed state on macOS; JSON option printing the same view the tool returns; precise flag for operator output
  - Report, install-agent and uninstall-agent subcommands delegating to the reporter and agent manager with their exit codes
  - Forget: confirmation on a terminal, refusal without confirmation flag when not a terminal, deleted count printed
  - Done when CLI tests show status JSON equal to the shared handler output, the agent installed line on a simulated macOS host, status exiting 1 on an invalid setting, install-agent and uninstall-agent exit codes matching the agent manager outcome, router tests resolving the presence subcommand to its script, forget refusing on a non-terminal without the flag, and report exiting 2 on missing settings
  - _Requirements: 4.2, 4.3, 4.5, 5.5, 8.2, 8.4, 9.5_
  - _Depends: 2.4, 4.2, cloud-deployment 1.1_

- [ ] 5.3 (P) Web presence endpoint
  - Add an authenticated JSON presence endpoint to the web routes using the operator surface, accepting an optional precision parameter and rejecting other values
  - Done when web tests show the endpoint returns the same view as the shared handler, coarse by default, precise on request, and 400 for an invalid precision
  - _Requirements: 8.3, 9.5_
  - _Boundary: WebPresenceRoute_

- [ ] 6. Documentation and end-to-end validation
- [ ] 6.1 Presence guide and environment template
  - Write the presence guide: how it works, privacy (stored fields, retention, coarse LLM default, forget), OwnTracks HTTP-mode setup with the /v1/presence/owntracks path, Basic auth with the presence token as password, device id and significant monitoring mode, how to confirm a phone fix arrived (status command shows a fresh phone age), laptop agent install and permission grant, how to check the agent's last report (status laptop age and the agent log), agent uninstall, the generic report format with a curl and a Home Assistant example, settings table, troubleshooting
  - Add the presence settings block with defaults to the environment template and a link from the deployment guide
  - Done when the guide covers each listed section, every presence setting from the design table appears in the environment template with its default, the deployment guide links to the presence guide, and cloud-deployment's environment-template consistency test still passes
  - _Requirements: 11.1, 11.2, 11.3, 11.4_

- [ ] 6.2 End-to-end presence flow
  - Through the ingress app, post an OwnTracks phone fix and a laptop report 50 m apart inside a configured place; verify get_presence through the tool dispatcher reports together at that place without coordinates and the web endpoint returns the same view
  - Advance the clock past the laptop staleness limit and verify together becomes unknown with the laptop stale reason; verify stored row count is unchanged by all queries
  - Confirm the full test suite passes
  - Done when the end-to-end test passes and the full suite is green
  - _Requirements: 8.1, 8.3, 8.5, 9.1, 10.1, 6.2_
  - _Depends: 4.1, 5.1, 5.3_
