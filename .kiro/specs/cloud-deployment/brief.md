# Brief: cloud-deployment

## Problem
The user wants khipuchat always running so important messages (e.g. a new transaction in Slack `#08-expedition`) are seen within minutes, even when the laptop is closed. Today khipuchat runs on the Mac, and the shipped Docker setup does not actually work unattended.

## Current State
- `Dockerfile` uses `node:20-alpine`, but `package.json#engines` requires Node `>=24 <25` (native `better-sqlite3-multiple-ciphers` ABI lock).
- `docker-compose.yml` mounts the `db-data` named volume at `/app/khipuchat.db`, which makes that path a directory, not a file. Code opens `./khipuchat.db` relative to cwd in some entrypoints (`watch.ts`, platform `sync.ts`) and `__dirname/..` in others (cli, mcp, ask).
- The compose `sync` service wraps `khipu sync all` (an endless daemon) in a `while/sleep` loop that never iterates.
- `LOCAL_ONLY_PLATFORMS` (iMessage, WhatsApp, Zalo) are hardcoded as "configured" and fail every cycle on Linux.
- No authenticated HTTP ingress exists (web UI binds 127.0.0.1 with basic auth; MCP is stdio only).
- Roadmap constraint "self-hosted only, no cloud" is rewritten for Phase 5 (see roadmap.md).

## Desired Outcome
`docker compose up -d` on a Linux VPS runs the watch daemon and web UI unattended with a persistent encrypted DB, only syncs platforms that can work on Linux, and exposes one authenticated HTTPS ingress that later specs (presence-context, notifier callbacks) mount routes on.

## Approach
Fix the container (Node 24 base, single `KHIPU_DB_PATH` env resolved by one shared helper, volume mounted as a directory), replace the hardcoded local-only list with a capability check per platform (`requires: 'macos' | 'local-session' | 'network'`), run `khipu sync all` directly as the service command, add an `ingress` Express app (separate port from web UI) with bearer-token auth meant to sit behind a reverse proxy or tunnel (Caddy / Cloudflare Tunnel / Tailscale). Document VPS setup, secrets (`.env` vs docker secrets), SQLCipher key handling, and DB backups.

## Scope
- **In**: Dockerfile + compose fixes, `KHIPU_DB_PATH` unification, platform capability gating, ingress server skeleton with auth + health endpoint, deployment doc, CI Node 24 alignment if touching the same files.
- **Out**: Provisioning/IaC for a specific cloud vendor, macOS-only sources on the server, multi-user tenancy, Kubernetes.

## Boundary Candidates
- Container/runtime config (Dockerfile, compose, DB path helper)
- Platform capability gating (watch.ts + types.ts)
- Ingress server (auth, routing registry other specs plug into)

## Out of Boundary
- Location routes (presence-context), notification callbacks (notifier), Slack auth (slack-all-workspaces).

## Upstream / Downstream
- **Upstream**: release spec (Docker artifacts), sync-watcher, security-hardening (auth patterns, SQLCipher).
- **Downstream**: slack-all-workspaces, presence-context, notifier, action-runner.

## Existing Spec Touchpoints
- **Extends**: release (Docker/compose), security-hardening (auth, binding rules), sync-watcher (gating).
- **Adjacent**: web-ui (keep web UI localhost/basic-auth; ingress is a separate surface).

## Constraints
- Node 24 exact; tsx runtime; files under 200 lines; TypeScript strict, no `any`.
- No Beeper dependency (khipuchat replaces Beeper). Signal on the server uses the signal-cli backend.
- Ingress must never expose MCP or raw query tools; MCP stays stdio.
- Slack session tokens used from a datacenter IP may trigger Slack "unusual access" checks: document, and let slack-all-workspaces handle detection.
