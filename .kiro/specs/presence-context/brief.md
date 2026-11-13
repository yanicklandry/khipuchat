# Brief: presence-context

## Problem
Whether a message deserves an interruption, and where to send it, depends on where the user is. If the phone and laptop are together, the user is likely at their desk and a laptop alert is enough; if apart, they are away and the phone must buzz. The triage assistant also benefits from knowing the place (home, office, travelling, which city).

## Current State
No location code exists in khipuchat. No HTTP ingress exists yet (cloud-deployment adds it).

## Desired Outcome
khipuchat continuously knows the last location of the phone and the laptop, with freshness. A `get_presence` query returns `{ together: boolean | unknown, distance_m, place, phone: {lat, lon, accuracy, at}, laptop: {...}, stale: [...] }`, available to triage-agent, notifier, and the MCP / CLI / ask surfaces (agent-native parity).

## Approach
- **Phone**: OwnTracks app (iOS/Android) in HTTP mode, significant-change monitoring, posting JSON to an authenticated ingress route `POST /presence/owntracks` (cloud-deployment ingress). Home Assistant companion app or Overland as documented alternatives using a generic `POST /presence/report` schema.
- **Laptop**: a launchd *user agent* (needs a GUI session for the Location privilege) running CoreLocationCLI on an interval and on wake, posting to `POST /presence/report`. Installed by `khipu presence install-agent`.
- **Server**: `device_locations` table (device, lat, lon, accuracy, at, source), keep last N per device. Co-location = both fresh (configurable staleness, e.g. 30 min) and distance under threshold (e.g. 200 m, accuracy-adjusted). Named places (home, office) defined in config with radius; optional offline reverse geocoding is out of scope for v1.
- Expose `get_presence` through `tool-registry.ts` + CLI `khipu presence`.

## Scope
- **In**: ingress routes + payload validation, laptop agent + installer, table + retention, co-location/place computation, `get_presence` across surfaces, docs for OwnTracks setup.
- **Out**: Apple Find My cache decryption (encrypted since macOS 14.4, fragile), location history UI/maps, geofence-triggered actions, third-party geocoding APIs.

## Boundary Candidates
- Ingestion (routes + laptop agent)
- Presence model (storage + co-location/place logic, pure functions)
- Query surface (`get_presence` tool, CLI)

## Out of Boundary
- Routing decisions (notifier), importance decisions (triage-agent).

## Upstream / Downstream
- **Upstream**: cloud-deployment (ingress + auth), tool-registry (ollama-mcp).
- **Downstream**: triage-agent (context), notifier (routing).

## Existing Spec Touchpoints
- **Extends**: tool-registry / MCP tool list (new read-only tool), security-hardening (auth for ingress).
- **Adjacent**: setup-wizard (OwnTracks + agent setup docs).

## Constraints
- Location is sensitive: store minimal history, configurable retention, never sent to the LLM at finer precision than needed (place name + together flag by default, raw coordinates opt-in).
- macOS Location permission: CLI binaries often do not prompt; CoreLocationCLI must be authorized once interactively; daemon (non-GUI) launchd jobs cannot hold the permission.
- TS strict, files under 200 lines.
