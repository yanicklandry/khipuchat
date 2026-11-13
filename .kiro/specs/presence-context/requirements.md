# Requirements Document

## Project Description (Input)
Whether a message deserves an interruption, and where to send it, depends on where the user is. The user (a single operator running khipuchat on a cloud server they control) currently has no location awareness in khipuchat: no location code and no location ingestion exist. khipuchat should continuously know the last location of the user's phone and laptop, with freshness, and answer a presence query (together / apart / unknown, distance, named place, local time, per-device last fix, stale devices) for the triage assistant, the notifier, and the MCP / CLI / ask surfaces. The phone reports through the OwnTracks app in HTTP mode to the authenticated ingress; the laptop reports through a macOS per-user background agent wrapping CoreLocationCLI. Location is sensitive: minimal history, configurable retention, and coarse precision (place name + together flag) toward any LLM by default. See `brief.md` for the full discovery context.

## Introduction
presence-context gives khipuchat a small, privacy-preserving model of where the user's two devices are. It ingests phone fixes from OwnTracks and generic location reports, runs a laptop reporter on macOS, keeps a short retention-bounded history, computes whether the devices are together and which named place the user is at, and exposes the result as a read-only presence query. Routing and importance decisions stay with the notifier and triage-agent specs; this spec only answers "where, together or apart, and how fresh".

## Boundary Context
- **In scope**: phone and laptop location ingestion over the existing authenticated ingress (paths under `/v1/presence/`), the macOS laptop reporter and its background-agent installer, storage and retention of device fixes, co-location and named-place computation, local time, the presence query on MCP, ask, CLI and web, coarse-by-default precision toward LLMs, and setup documentation for OwnTracks, the laptop agent, and the generic report format.
- **Out of scope**: Apple Find My cache decryption, location history UI or maps, geofence-triggered actions, reverse geocoding or any third-party geocoding service, OwnTracks encrypted payloads, Overland's native batch format, more than one phone and one laptop, notification routing decisions, importance decisions, laptop-side action execution.
- **Adjacent expectations**: the ingress (cloud-deployment) authenticates every request, including OwnTracks Basic-auth passwords, before any presence handling runs, and supplies the shared archive. triage-agent and notifier consume the presence snapshot and summary; they own what to do with it. action-runner may later reuse the laptop agent channel; that is not provided here, but the shared background-job helper (Requirement 4.6) is provided for action-runner's laptop agent and for the existing sync background job to reuse. message-events owns the schema registry through which the presence table is created at archive initialisation.

## Requirements

### Requirement 1: Phone location ingestion from OwnTracks
**Objective:** As the user, I want my phone's OwnTracks app to report its location to my khipuchat server, so that khipuchat knows where my phone is without any third-party service.

#### Acceptance Criteria
1. When an authenticated OwnTracks client posts a location message to the presence OwnTracks endpoint, the Presence Service shall record a phone fix with latitude, longitude, accuracy, fix time, receive time, source, and the reporting device identifier, and respond with success and an empty JSON array.
2. The Presence Service shall accept OwnTracks clients that authenticate with HTTP Basic credentials whose password is a valid ingress token, relying on the ingress to perform that check.
3. When an authenticated OwnTracks client posts a message whose type is not a location (for example transition, waypoint, last-will, status, card, encrypted) or an empty body, the Presence Service shall acknowledge with success and an empty JSON array, record nothing, and log the message type.
4. If a posted location message lacks latitude, longitude, or fix time, has a latitude outside -90..90 or a longitude outside -180..180, has both coordinates equal to 0, or has a fix time more than 5 minutes in the future, then the Presence Service shall respond with a client error naming the offending field and record nothing.
5. When the same device posts a fix with the same fix time and source again, the Presence Service shall acknowledge success without creating a second stored fix.
6. The Presence Service shall identify the reporting device from the client's device header, device query parameter, topic, or tracker identifier, in that order of preference.
7. Where a phone device identifier is configured, if an OwnTracks location arrives from a different device identifier, then the Presence Service shall acknowledge with success and an empty JSON array, record nothing, and log a warning naming the device identifier.

### Requirement 2: Generic location report
**Objective:** As the user, I want a documented generic report format, so that the laptop reporter and alternative phone clients can send locations without OwnTracks.

#### Acceptance Criteria
1. When an authenticated client posts a generic report naming the device role (phone or laptop), latitude, longitude, and optionally accuracy, fix time, timezone, and source label, the Presence Service shall record a fix for that role and respond with success indicating whether the fix was recorded.
2. If a generic report omits the fix time, then the Presence Service shall use the receive time as the fix time.
3. If a generic report names an unknown role, has out-of-range or zero-zero coordinates, a negative accuracy, an invalid timezone name, or a fix time more than 5 minutes in the future, then the Presence Service shall respond with a client error naming the offending field and record nothing.
4. If a fix time in a report is older than the retention age limit, then the Presence Service shall respond with success, record nothing, and state that the fix was too old.
5. When a generic report repeats a device, source, and fix time already stored, the Presence Service shall respond with success and indicate that nothing new was recorded.

### Requirement 3: Laptop location reporter
**Objective:** As the user, I want my Mac to report its own location to khipuchat, so that khipuchat can tell whether my phone and laptop are together.

#### Acceptance Criteria
1. When the operator or the background agent runs the laptop report command on macOS, the Laptop Reporter shall obtain one current location fix with its horizontal accuracy and post it as a laptop report including the Mac's current system timezone.
2. If the location tool is missing, location permission is denied, no fix is obtained within 30 seconds, or the tool output cannot be understood, then the Laptop Reporter shall exit with a non-zero status, print an actionable message for that case, and send nothing.
3. If the server is unreachable or rejects the report, then the Laptop Reporter shall exit with a non-zero status and print the failure without revealing the token.
4. The Laptop Reporter shall request only coordinates and accuracy from the location tool and shall never request address or place-name resolution.
5. The Laptop Reporter shall read the server address and token from the environment or the project's environment file, and if the server address uses plain HTTP to a non-loopback host, then it shall refuse to send.

### Requirement 4: Laptop background agent installation
**Objective:** As the user, I want a one-command install of the laptop reporter as a background job, so that the laptop reports regularly without my attention.

#### Acceptance Criteria
1. When the operator runs the install-agent command on macOS, the Agent Installer shall install a per-user background job in the user's login session that runs the laptop report every 5 minutes by default (configurable) and once after the Mac wakes from sleep.
2. When the install-agent command runs, the Agent Installer shall first run one location lookup in the foreground so macOS can ask the user for location permission, and if permission is denied, then it shall explain where to grant it in System Settings and not install the job.
3. If the install-agent command runs on an operating system other than macOS, then the Agent Installer shall refuse with an explanatory message and change nothing.
4. The Agent Installer shall not write the ingress token or any other secret into the background job definition.
5. When the install-agent command runs while a job is already installed, the Agent Installer shall replace and restart it; when the operator runs the uninstall-agent command, the Agent Installer shall stop and remove the job and report the outcome.
6. The Agent Installer shall build the background job definition and perform its install, replace, and uninstall steps through one shared, feature-neutral background-job helper that other khipuchat features can reuse for their own per-user jobs, and that helper shall escape every value so that paths containing special characters still produce a valid job definition.

### Requirement 5: Location storage and retention
**Objective:** As the user, I want only a minimal, short location history kept, so that a compromised or shared archive reveals as little as possible about my movements.

#### Acceptance Criteria
1. The Presence Service shall keep, per device role, at most the configured number of most recent fixes (default 50) and no fix older than the configured age (default 7 days).
2. When a new fix is recorded, the Presence Service shall remove fixes beyond the retention limits for that device in the same operation.
3. The Presence Service shall store only role, latitude, longitude, accuracy, fix time, receive time, source, reporting device identifier, and timezone, and shall discard all other payload fields (for example battery, network, SSID, altitude, speed).
4. The Presence Service shall treat the fix with the latest fix time as a device's current fix, regardless of the order in which fixes arrived.
5. When the operator runs the forget command and confirms, the Presence Service shall delete every stored fix and report how many were deleted.
6. The Presence Service shall never write coordinates to logs; ingestion logs shall name only the role, source, device identifier, and fix time.

### Requirement 6: Co-location
**Objective:** As a downstream consumer (notifier, triage assistant), I want a reliable together / apart / unknown answer, so that routing never assumes the user is at the laptop on stale or imprecise data.

#### Acceptance Criteria
1. While both devices have a fresh fix and the combined accuracy is within the configured maximum, the Presence Service shall report together as true when the distance between the fixes is at most the together threshold plus the combined accuracy, and false otherwise.
2. If either device has no fix, or its current fix is older than that device's staleness limit, then the Presence Service shall report together as unknown with reasons naming each missing or stale device.
3. If the combined accuracy of both fresh fixes exceeds the configured maximum, then the Presence Service shall report together as unknown with an accuracy reason.
4. The Presence Service shall use these defaults, each configurable: together threshold 200 m, phone staleness 180 minutes, laptop staleness 30 minutes, maximum combined accuracy 1000 m; a fix without accuracy shall count as 100 m.
5. Whenever both devices have a fix, fresh or stale, the Presence Service shall report the distance between them in whole metres.
6. If a presence setting has an invalid value, then the Presence Service shall report a configuration error naming the setting instead of computing presence.

### Requirement 7: Named place and local time
**Objective:** As the triage assistant, I want to know which named place the user is at and the user's local time, so that importance and urgency judgments match the user's situation.

#### Acceptance Criteria
1. Where named places are configured (name, centre, radius, optional timezone), the Presence Service shall resolve each device's current fix to the nearest place whose radius contains it, or to no place.
2. The Presence Service shall report the user's place as the phone's place when the phone fix is fresh, otherwise the laptop's place when the laptop fix is fresh, otherwise no place.
3. The Presence Service shall report the user's local time using, in order, the timezone of the user's place, the timezone of the most recent fresh fix that carries one, the configured default timezone, and the server timezone, and shall state which source was used.
4. If a configured place entry is malformed (missing or invalid name, coordinates, radius, or timezone, or a duplicate name), then the Presence Service shall report a configuration error naming the entry.
5. The Presence Service shall not call any external geocoding or timezone service.

### Requirement 8: Presence query across surfaces
**Objective:** As the user and as an LLM client, I want the same presence answer on MCP, ask, CLI, and web, so that every surface sees the same truth (agent-native parity).

#### Acceptance Criteria
1. The Presence Service shall provide a get_presence tool on the MCP and ask surfaces whose result equals the direct presence query for the same stored data, time, and precision.
2. When the operator runs the presence status command, the CLI shall print the together state with reasons, distance, place, local time, and each device's age and staleness, and with a JSON option shall print the same structure the tool returns.
3. When an authenticated web client requests the presence endpoint, the Web UI shall return the same structure the tool returns.
4. If no fixes are stored at all, then every surface shall return a normal answer with together unknown and both devices reported missing, not an error.
5. The presence query shall not modify stored location data.

### Requirement 9: Location precision toward LLMs
**Objective:** As the user, I want LLMs to receive only coarse location by default, so that my exact coordinates never leave the server unless I opt in.

#### Acceptance Criteria
1. The get_presence tool shall by default return the together state and reasons, the distance rounded to the nearest 50 m, place names, local time, and each device's age and staleness, and shall omit coordinates and accuracy.
2. Where precise LLM precision is enabled by the operator, the get_presence tool shall also return each device's coordinates and accuracy.
3. If a get_presence call requests precise output while precise LLM precision is not enabled, then the tool shall return the coarse result and state that precise output is disabled.
4. The Presence Service shall provide downstream LLM consumers a one-line presence summary (together state, place, local time) that follows the same precision setting.
5. The CLI and web surfaces shall return coarse output by default and precise output only when the operator explicitly asks for it.

### Requirement 10: Presence contract for downstream features
**Objective:** As the triage-agent and notifier developers, I want a stable presence snapshot contract, so that context building and routing can be built in parallel with this spec.

#### Acceptance Criteria
1. The Presence Service shall provide downstream features a presence snapshot containing the together state with reasons, distance, user place, local time, each device's current fix with age and staleness, the stale devices, and the thresholds used, computed at a caller-supplied time.
2. The Presence Service shall compute a snapshot from stored data only, without network access, within 50 ms for retention-bounded data.
3. The Presence Service shall not decide notification channel, urgency, or importance; it reports presence only.

### Requirement 11: Setup guidance
**Objective:** As the operator, I want clear setup instructions, so that I can connect my phone and laptop without reading source code.

#### Acceptance Criteria
1. The presence guide shall explain OwnTracks HTTP-mode setup: the endpoint path under the ingress, Basic authentication with the ingress token as password, device naming, the recommended monitoring mode, and how to confirm a fix arrived.
2. The presence guide shall explain laptop agent installation, the one-time location permission grant, how to check the agent's last report, and uninstallation.
3. The presence guide shall document the generic report format with an example for an alternative phone client, every presence setting with its default, and the privacy behavior (retention, coarse LLM precision, forget command).
4. The environment template shall list every presence setting with its default.
