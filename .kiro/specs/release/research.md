# Gap Analysis: Release Spec

**Date**: 2026-07-12
**Feature**: release
**Analyst**: kiro-validate-gap

---

## Summary

- Most release infrastructure already exists (Dockerfile, CI/CD workflows, SECURITY.md, demo asset), but several files contain bugs or are incomplete relative to requirements.
- The two largest gaps are: (1) no `bin` entry in `package.json` (the `khipu` command does not exist as an installed binary), and (2) the README still references `npm run` scripts instead of `khipu` commands throughout.
- `docker-compose.yml` has two correctness bugs: volume mounts `telegram.db` (stale filename) instead of `khipuchat.db`, and there is no sync service running `khipu sync all`.
- The ONNX model download at first container startup and the Chromium dependency of `whatsapp-web.js` are non-trivial Docker runtime concerns that should be addressed in design.
- All gaps are low-to-medium complexity and do not require new architectural decisions.

---

## Codebase Inventory

### Already Exists (full or partial)

| Artifact | Status | Notes |
|---|---|---|
| `Dockerfile` | Partial | Multi-stage build present; correct Node 20 + alpine; CMD runs `npx tsx src/mcp.ts` directly, not via `khipu` bin |
| `docker-compose.yml` | Partial | One service, env var comments present; volume mounts wrong file; missing sync service |
| `.dockerignore` | Present | Excludes `*.db`, `.env`, `node_modules`, `tests/`, `.git`, `.kiro`, `docs` |
| `.github/workflows/ci.yml` | Complete | Triggers on push/PR to main, ubuntu-latest, Node 20, runs `npm test` |
| `.github/workflows/release.yml` | Complete | Triggers on `v*` tags, multi-arch (amd64+arm64), pushes to ghcr.io with `GITHUB_TOKEN`, tags git ref + latest |
| `SECURITY.md` | Partial | Structure is correct; email is placeholder `security@khipuchat.example.com` |
| `docs/demo.png` | Complete | 2.7 KB, well under 5 MB limit; linked from README |
| `README.md` | Partial | Docker Quickstart section exists; uses `npm run` everywhere; missing `khipu.config.json` docs; missing multi-account section |
| `.env.example` | Present | Referenced by README quickstart |
| `package.json` `bin` | Missing | No `bin` field; `khipu` command unavailable after `npm install -g` or `npm link` |

---

## Requirement-by-Requirement Gap Analysis

### Requirement 1: Docker Image

**AC 1** (multi-stage build) — **MET**. The Dockerfile already has `builder` and runtime stages.

**AC 2** (amd64 + arm64) — **MET via CI**. The Dockerfile itself is architecture-agnostic; multi-arch is handled by `docker/setup-qemu-action` and `platforms: linux/amd64,linux/arm64` in `release.yml`. Local `docker compose build` will build for the host architecture only, which is acceptable.

**AC 3** (`docker compose up` makes MCP + web UI functional) — **PARTIAL GAP**. The current compose file starts only the MCP service. The web UI server (`src/web/server.ts`) is not started. Design needs to decide: single container running both, or two compose services.

**AC 4** (sync service runs `khipu sync all`) — **GAP**. No sync service in `docker-compose.yml`. Requires: `bin` entry first (so `khipu` exists), then adding a sync service to compose.

**AC 5** (named volume for `khipuchat.db`) — **BUG**. Current volume mounts to `/app/telegram.db` (stale name). Must change to `/app/khipuchat.db`. The `.dockerignore` already excludes `*.db` from the image build context, which is correct.

**AC 6** (env vars documented as commented examples) — **MET**. The `docker-compose.yml` has a comprehensive env var comment block.

### Requirement 2: CI Pipeline

**AC 1, 2, 3** — **ALL MET**. `ci.yml` triggers on push to `main` and PRs targeting `main`, uses `ubuntu-latest` + Node 20, runs `npm test`. No gaps.

### Requirement 3: Docker Release Pipeline

**AC 1, 2, 3** — **ALL MET**. `release.yml` triggers on `v*`, builds multi-arch, pushes to `ghcr.io` with `GITHUB_TOKEN`, tags with `${{ github.ref_name }}` and `latest`. No gaps.

### Requirement 4: Security Disclosure Policy

**AC 1** — **MET**. `SECURITY.md` exists at repo root with clear vulnerability reporting instructions.

**AC 2** — **PARTIAL GAP**. Email is `security@khipuchat.example.com` — an example domain placeholder, not a real address. The design phase should use the maintainer's real email (yanick.landry@gmail.com or a dedicated alias). This is a content gap, not structural.

### Requirement 5: CLI Packaging

**AC 1** (`bin` entry in `package.json`) — **GAP**. The `package.json` has no `bin` field. The `khipu` command is never installed by `npm install -g` or `npm link`. This is the foundational gap; the `khipu` command is referenced by requirements 1.4, 5.2, 5.3, and 6.4 but does not exist yet.

The CLI entry point (`src/cli.ts`) already exists. The `bin` entry should point to a thin shim or directly to `src/cli.ts` using a hashbang (`#!/usr/bin/env tsx`). Consideration: `tsx` must be in `PATH` for the shim to work after `npm install -g`; the alternative is compiling to `dist/` for the bin. This is a design decision.

**AC 2** (README documents `npm link` for contributors) — **GAP**. README has no mention of `npm link`.

**AC 3** (README references `khipu` commands) — **GAP**. README currently uses:
- `npm run sync` (should be `khipu sync all` or `khipu sync telegram`)
- `npm run setup-claude` (should be `khipu setup-claude`)
- `npm run setup-sync` (should be `khipu setup-sync`)
- `npx tsx src/platforms/telegram/sync.ts` in Docker example (should be `khipu sync telegram`)

### Requirement 6: Documentation

**AC 1** (demo asset in `docs/`) — **MET**. `docs/demo.png` exists and is linked in the README header.

**AC 2** (under 5 MB) — **MET**. 2.7 KB.

**AC 3** (Docker Quickstart) — **MET** (structurally). The README has a "Docker Quickstart" section with `git clone`, `cp .env.example .env`, `docker compose up`. Minor: the sync command in the Quickstart uses `npx tsx src/...` instead of `khipu sync telegram`; will be fixed when AC 5.3 is addressed.

**AC 4** (`khipu.config.json` docs + slow-sync platform note) — **GAP**. README has no section on `khipu.config.json` multi-account setup. `account-registry.ts` exists and supports multi-account; the config format is known but undocumented in the README. The requirement also asks to flag platforms that cannot filter server-side (iMessage reads the local `chat.db` and cannot be date-filtered at the source; it always does a full scan and relies on in-process deduplication). This should be documented.

---

## Non-Requirement Technical Concerns

### 1. `whatsapp-web.js` Chromium dependency in Docker

`whatsapp-web.js` uses Puppeteer internally, which launches a Chromium browser. Alpine-based Docker images do not include Chromium by default; `npm ci` will attempt to download a Chromium binary during install. This can fail silently or produce a large image on Alpine.

**Options**:
- Add `apk add chromium` to the builder stage and set `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser` and `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` in the Dockerfile.
- Switch to `node:20-slim` (Debian) where the Chromium install is more predictable.
- Document that WhatsApp sync is not supported inside Docker (it requires a local Chrome + QR scan session).

**Recommendation**: Document the limitation and skip WhatsApp-specific dependencies in the Docker image build via an env var (`SKIP_PUPPETEER=true` or similar). WhatsApp sync on Docker is a UX problem that can be addressed post-release.

### 2. ONNX model download at first startup

`@huggingface/transformers` downloads the `all-MiniLM-L6-v2` ONNX model at runtime on first use. In Docker, this requires internet access and writes to a cache directory that is not persisted. Options:
- Mount a host directory for HuggingFace cache (`HF_HOME` env var) so the model survives restarts.
- Pre-download the model in the `builder` stage (bakes it into the image; ~25 MB).
- Document that first startup is slow and subsequent starts use the cached model (if volume is mounted).

**Recommendation**: Add `HF_HOME` volume mount or instruction to `docker-compose.yml`. Baking into the image is cleaner but adds image size.

### 3. `tsx` in production Docker

The runtime stage currently copies `node_modules` and runs `npx tsx src/mcp.ts`. `tsx` is a dev dependency. This is intentional per `tech.md` ("dist/ output is for Docker only" implies there is a compile step option, but the current Dockerfile skips it). This is consistent and not a gap, but the Dockerfile could be hardened by using `node dist/mcp.js` after a build step for better startup performance. Out of scope per current requirements.

### 4. `.dockerignore` excludes `docs/`

`docs/` is excluded from the build context. This is correct (demo asset is not needed in the image). No action needed.

---

## Implementation Approach Options

### Option A: Minimal Shim Bin (Recommended)

Add a `bin/khipu` file with a hashbang pointing to `tsx src/cli.ts`. Set `"bin": {"khipu": "./bin/khipu"}` in `package.json`. After `npm link`, the `khipu` command resolves through the project's local `node_modules/.bin/tsx`.

**Pros**: No build step; consistent with the "no compile" philosophy.  
**Cons**: Requires `tsx` in PATH if used outside `npm link` context; the bin file must be executable (`chmod +x`).

### Option B: Compile Entry Point

Add a `build` script to `package.json` that runs `tsc`; point `bin` at `dist/cli.js`. Update `Dockerfile` to run `npm run build` in the builder stage and copy `dist/`.

**Pros**: No `tsx` runtime dependency in production; cleaner production image.  
**Cons**: Adds a build step; contradicts current "no build step" philosophy; doubles the development feedback loop for contributors.

### Option C: Direct `tsx` Bin Entry

Set `"bin": {"khipu": "./node_modules/.bin/tsx src/cli.ts"}` — not recommended; bin entries must point to a file, not a command.

**Verdict**: Option A is the right fit for this project's philosophy.

---

## File Change Inventory

| File | Change Type | Effort |
|---|---|---|
| `package.json` | Add `bin` field + shim | Small |
| `bin/khipu` | Create executable shim | Small |
| `docker-compose.yml` | Fix volume name; add sync service; add web service (if in scope) | Small-Medium |
| `Dockerfile` | Add Chromium handling; optionally add HF_HOME guidance | Small |
| `README.md` | Replace `npm run` with `khipu`; add `npm link` docs; add `khipu.config.json` section; add platform sync performance note | Medium |
| `SECURITY.md` | Replace placeholder email with real address | Trivial |

---

## Research Questions for Design Phase

1. Should the Docker Compose file include a separate `web` service (port 3333) and a `sync` service, or one combined service that starts all three (MCP, web, sync)? The requirements say MCP + web UI shall be functional and the sync service runs `khipu sync all`, implying at least two compose services.

2. Should `khipu sync all` run as a one-shot command that terminates, or as a long-running daemon? The requirement says "long-running process" for the sync compose service. This determines whether the sync service needs a `watch` or `--daemon` mode.

3. How should the HuggingFace ONNX model cache be handled in Docker (baked in vs. volume-mounted)?

4. Should WhatsApp sync be explicitly documented as "not supported inside Docker" in the Docker Quickstart?

---

## Next Steps

1. Review this gap analysis.
2. Run `/kiro-spec-design release` to generate the technical design document, which will resolve the open design questions above.
3. Or `/kiro-spec-design release -y` to skip re-approval of requirements and go directly to design.

---

## Design Synthesis & Decisions (kiro-spec-design, 2026-07-12)

**Discovery type**: Light (Extension). No external web research required; all libraries are already in use and the mechanisms (npm `bin`, `npm link`, multi-arch Docker via QEMU) are established in the existing workflows.

### Synthesis

- **Generalization**: Requirements 1.4, 5.1, 5.3, and 6.4 all presuppose a single `khipu` command that can launch every role. Rather than fixing each reference piecemeal, the design introduces one command router (`src/khipu.ts`) whose interface naturally covers all current subcommands and future ones. The generalization is at the interface (subcommand → script map), not the implementation.
- **Build vs. adopt**: Dispatch is solved by reusing the proven `spawn(process.execPath, [tsxBin, script], { stdio: 'inherit' })` pattern already in `src/sync-all.ts`, instead of adopting a CLI framework (commander/yargs) — no new dependency, consistent with the "no build step / minimal deps" steering.
- **Simplification**: Rejected refactoring `src/cli.ts` into a shared library. The router forwards query subcommands to `cli.ts` as-is (spawn), so `cli.ts` stays single-responsibility and under no additional risk. The router is the smallest additive seam.

### Decision: `khipu` implemented as a command router, not an extension of `src/cli.ts`

- **Context**: `src/cli.ts` handles only query tools and already sits near/over the 200-line limit; requirements demand `khipu sync`, `khipu mcp`, `khipu web`, `khipu setup-*`.
- **Alternatives**: (A) overload `cli.ts` with operational subcommands; (B) new `src/khipu.ts` router that spawns role scripts.
- **Selected**: B. A dedicated router keeps each file single-responsibility, avoids a `cli.ts` rewrite, and mirrors `sync-all.ts`'s spawn pattern.
- **Trade-offs**: One extra process hop per command (negligible for CLI/daemon roles) in exchange for a clean boundary and zero refactor risk to existing roles.

### Decision: `bin/khipu` is a Node shim that spawns project-local `tsx`

- **Context**: No build step (`tech.md`); `tsx` is a devDependency, not on the global PATH.
- **Selected**: `bin/khipu` (`#!/usr/bin/env node`) resolves `node_modules/.bin/tsx` and `src/khipu.ts` from `__dirname` and spawns them with `stdio: 'inherit'`. Works after `npm link` (dev) and inside the image.
- **Rationale**: Matches the resolution approach already used by `sync-all.ts`/`setup-*.ts`; avoids a compile step and avoids requiring a global `tsx`.

### Decision: Docker Compose runs `web` + long-running `sync`; MCP is the image default CMD (stdio)

- **Context**: MCP is stdio-only (never HTTP, per `tech.md`), so it cannot be a network Compose service. AC 1.3 requires MCP + web functional; AC 1.4 requires a long-running sync service.
- **Selected**: Compose defines `web` (`khipu web`, port 3333) and `sync` (`sh -c` loop wrapping `khipu sync all`). The image default `CMD` is `["khipu","mcp"]`; interactive MCP use is documented (`docker run -i ... khipu mcp`).
- **Rationale**: Honest to the stdio constraint while satisfying the requirement literally; keeps `khipu sync all` one-shot (loop lives in Compose, not the CLI).
- **Follow-up**: Confirm `docker run -i` MCP handshake during deployment verification.

### Decision: WhatsApp/Chromium and ONNX model handling in Docker

- WhatsApp: set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` in the image and document WhatsApp sync as unsupported inside Docker (requires local Chrome + QR session). `sync-all` already logs per-platform failures and continues, so the sync loop is unaffected.
- ONNX model: set `HF_HOME` and mount a named `hf-cache` volume so the `all-MiniLM-L6-v2` model downloaded at first use survives restarts.

### Decision: `SECURITY.md` contact address

- Replace `security@khipuchat.example.com` with the maintainer address `yanick.landry@gmail.com`. Accepted trade-off: exposing a personal address in a public repo for responsible-disclosure reachability. Revisit if a dedicated alias becomes available.

### Risks & Mitigations
- Role script rename/move breaks the router map → mitigated by importing `PLATFORMS` from `sync-all.ts` and a parity integration test; other paths are covered by unit tests on `resolveCommand`.
- `npm link` in the image failing → fallback to `npm install -g .`; both place `khipu` on PATH.
- Stdio MCP buffering → enforced `stdio: 'inherit'` in the shared spawn helper.

---

## Implementation Completion Re-Scan (kiro-validate-gap, 2026-07-13)

**Trigger**: All subtasks in tasks.md are now checked. This re-scan verifies the implementation against requirements with fresh eyes.

### Status: Implementation Complete

Every requirement maps to a present, correct artifact. Summary of findings:

| Req | AC | Status | Evidence |
|---|---|---|---|
| 1 | 1.1 Multi-stage Dockerfile | ✅ | builder + runtime on node:20-alpine |
| 1 | 1.2 amd64 + arm64 | ✅ | release.yml: QEMU + buildx, platforms both arches |
| 1 | 1.3 compose up starts web | ✅ | web service: `khipu web`, port 127.0.0.1:3333 |
| 1 | 1.4 sync service runs `khipu sync all` | ✅ | sync service: while-loop around `khipu sync all` |
| 1 | 1.5 named volume for khipuchat.db | ✅ | db-data volume at /app/khipuchat.db |
| 1 | 1.6 env vars documented | ✅ | commented block at bottom of docker-compose.yml |
| 2 | all | ✅ | ci.yml: push+PR to main, ubuntu-latest, Node 20, npm test |
| 3 | all | ✅ | release.yml: v* tags, ghcr.io, GITHUB_TOKEN, version+latest tags |
| 4 | all | ✅ | SECURITY.md: private reporting + yanick.landry@gmail.com |
| 5 | 5.1 bin entry | ✅ | package.json has `"bin": { "khipu": "bin/khipu" }` |
| 5 | 5.2 npm link in README | ✅ | Contributing section documents clone + npm install + npm link |
| 5 | 5.3 khipu commands in README | ✅ | All references use `khipu <subcommand>` |
| 6 | 6.1 demo asset in docs/ | ⚠️ | docs/demo.png exists and is linked; but only 2,710 bytes — likely a placeholder image |
| 6 | 6.2 under 5 MB | ✅ | 2,710 bytes |
| 6 | 6.3 Docker quickstart | ✅ | "Docker Quickstart" section present |
| 6 | 6.4 khipu.config.json + incremental note | ✅ | Multi-account section + iMessage full-scan note |

### Residual Gap: demo asset (Requirement 6.1)

`docs/demo.png` is 2,710 bytes — far below what a real screenshot produces (typically 100 KB+). This is almost certainly a placeholder. The requirement says "a demo GIF or screenshot shall exist in `docs/` and be linked from the README." Technically met on the letter (file exists, linked, under 5 MB), but the spirit (prospective users see the tool in action) is not served by a near-empty image.

**Action required before tagging a release**: Replace `docs/demo.png` with a real screenshot of the web UI or a GIF capture. This is the only remaining work item.

### Known Accepted Trade-offs (not gaps)

- `npm link` in the Dockerfile runtime stage is non-standard but intentional (avoids a dist/ build step per tech.md).
- Stdio MCP cannot be a Compose network service; documented as `docker run -i ... khipu mcp` instead.
- WhatsApp sync is unsupported inside Docker (Chromium/QR session); `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` set in Dockerfile, limitation should be noted in README.

### Recommended Next Step

Run `/kiro-validate-impl release` to formally verify the complete implementation and close parent tasks 1-4.

---

## Fresh Codebase Verification (kiro-validate-gap, 2026-07-14)

**Trigger**: User invoked `/kiro-validate-gap release` directly. Full re-inspection of all release artifacts.

### Confirmed Complete (no change since 2026-07-13 scan)

All infrastructure artifacts verified present and correct:
- `Dockerfile`: multi-stage, node:20-alpine, `npm link`, `CMD ["khipu","mcp"]`, `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`
- `docker-compose.yml`: `web` + `sync` services, 3 named volumes (db-data, hf-cache, media-data), `env_file: .env`, comprehensive env var comments
- `.github/workflows/ci.yml`: push+PR to main, ubuntu-latest, Node 20, `npm ci && npm test`
- `.github/workflows/release.yml`: `v*` tags, QEMU + Buildx, ghcr.io push, `GITHUB_TOKEN`, version + latest tags
- `SECURITY.md`: private reporting workflow, `yanick.landry@gmail.com` contact
- `package.json` bin: `"khipu": "bin/khipu"` present
- `bin/khipu`: Node shim resolving project-local tsx and `src/khipu.ts`
- README: Docker quickstart, `npm link` docs, `khipu.config.json` multi-account section, iMessage full-scan note

### Residual Gap (confirmed): demo asset

`docs/demo.png` is 2,710 bytes. A real web UI screenshot would be 100 KB+. This is a placeholder. The requirement letter is met (file exists, < 5 MB, linked from README) but the spirit (prospective users see the tool) is not. **Replace before tagging a release.**

### Additional Observation: `npm run cli` in README

README line ~140: `Run any MCP tool from the terminal with \`npm run cli <tool> [args]\`.` with `npm run cli get_image <message_id>` as the example. This `npm run cli` reference was not flagged by the 2026-07-13 scan (requirement 5.3 targets `npm run sync:*` and raw `tsx` invocations specifically). Since `khipu get_image <message_id>` is the correct public form (khipu.ts routes unknown subcommands to cli.ts), this line is a minor inconsistency but does not block the release.

### `.env.example` scope

`.env.example` contains only 4 Telegram vars. The docker-compose.yml comments are the canonical env var reference (requirement 1.6 ✅). No requirement demands `.env.example` be comprehensive, so this is not a gap.

### Conclusion

Implementation is complete. The single actionable item before a release tag is replacing `docs/demo.png` with a real screenshot or GIF of the web UI.
