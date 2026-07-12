# Implementation Plan

- [ ] 1. Implement khipu command router
- [x] 1.1 Implement `src/khipu.ts` command router
  - Implement `resolveCommand(argv: readonly string[]): CommandResolution` as a pure function with no I/O: map operational subcommands (`mcp`, `web`, `setup-claude`, `setup-sync`, `index`) to their role scripts; map `sync all` / `sync` (no arg) to `src/sync-all.ts`; map `sync <platform>` to `src/platforms/<platform>/sync.ts` for known platforms; forward all query subcommands (`search`, `semantic-search`, `semantic-contacts`, `list-chats`, `find-chat`, `messages`, `summary`) to `src/cli.ts` with argv unchanged; return `kind: 'error'` for unknown subcommands or unknown platforms; return `kind: 'help'` for empty argv.
  - Import `PLATFORMS` from `src/sync-all.ts` as the single source of truth for platform names; do not hardcode a separate list in this file.
  - Implement `main(argv)`: call `resolveCommand`, then spawn the resolved script via `node_modules/.bin/tsx` with `{ stdio: 'inherit' }`; propagate the child exit code as the function return value.
  - Resolve all script paths and the tsx binary from `__dirname` so the router works after `npm link` and inside the Docker image.
  - Keep the file under 200 lines; use `kebab-case` for the filename (`src/khipu.ts`).
  - `resolveCommand(['mcp'])` returns `{ kind: 'run' }` pointing at the correct script; `resolveCommand([])` returns `{ kind: 'help', exitCode: 0 }`; `resolveCommand(['sync', 'bogus'])` returns `{ kind: 'error', exitCode: 1 }`.
  - _Requirements: 1.3, 1.4, 5.1, 5.3_

- [x] 1.2 Create `bin/khipu` shim and register it in `package.json`
  - Write `bin/khipu` as an executable Node.js script (`#!/usr/bin/env node`) that resolves `node_modules/.bin/tsx` and `src/khipu.ts` relative to `__dirname`, spawns them with `{ stdio: 'inherit' }`, and exits with the child's exit status; mirror the resolution pattern from `src/sync-all.ts`.
  - Mark `bin/khipu` executable (`chmod +x`).
  - Add `"bin": { "khipu": "bin/khipu" }` to `package.json` (existing scripts entries remain unchanged).
  - After `npm link`, running `khipu` in the terminal prints usage and exits 0; running `khipu mcp` starts the MCP server over stdio.
  - _Requirements: 5.1_

- [ ] 2. Write khipu router tests
- [x] 2.1 Unit tests for `resolveCommand`
  - Test each operational subcommand (`mcp`, `web`, `setup-claude`, `setup-sync`, `index`) resolves to the correct script path with `kind: 'run'`.
  - Test `resolveCommand(['sync', 'all'])` and `resolveCommand(['sync'])` both resolve to `src/sync-all.ts`.
  - Test `resolveCommand(['sync', '<known-platform>'])` (e.g. `telegram`) resolves to the correct platform sync script.
  - Test `resolveCommand(['sync', 'bogus'])` returns `kind: 'error'` with `exitCode: 1`.
  - Test an unknown top-level subcommand returns `kind: 'error'` with `exitCode: 1`.
  - Test `resolveCommand([])` returns `kind: 'help'` with `exitCode: 0`.
  - Test a query subcommand (e.g. `search`) resolves to `src/cli.ts` with full argv forwarded unchanged.
  - `npm test` passes with all cases green and no regressions in existing tests.
  - _Requirements: 5.1, 5.3_
  - _Depends: 1.1_

- [x] 2.2 Integration tests for platform parity and exit-code propagation
  - Assert the router's known-platform set equals `PLATFORMS` exported from `src/sync-all.ts` (guards against router and sync diverging as platforms are added).
  - Assert `main()` propagates a non-zero child exit code: use a fast, side-effect-free target script that exits with a known non-zero code and verify the propagated value matches.
  - `npm test` passes with both integration tests green.
  - _Requirements: 5.1_
  - _Depends: 1.1, 1.2_

- [ ] 3. Update packaging, policy, and documentation
- [x] 3.1 (P) Update `Dockerfile` to install and use the `khipu` command
  - Retain the existing multi-stage build structure (`builder` stage + runtime stage on `node:20-alpine`).
  - Add `ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` before `npm ci` in the builder stage to prevent Chromium download failure on Alpine.
  - Add `ENV HF_HOME=/app/.cache/huggingface` in the runtime stage so the ONNX model download is cached to a predictable path.
  - Run `RUN npm link` in the runtime stage (after copying `node_modules` and `bin/`) so `khipu` is available on `PATH`.
  - Change `CMD` from `npx tsx src/mcp.ts` (or equivalent) to `["khipu", "mcp"]` so the image defaults to the stdio MCP server role.
  - `docker build .` completes without error; `docker run --rm <image> khipu --help` (or `khipu` with no args) prints usage and exits 0.
  - _Requirements: 1.1, 1.3_
  - _Boundary: Dockerfile_
  - _Depends: 1.2_

- [x] 3.2 (P) Update `docker-compose.yml` to start web and sync services with persisted storage
  - Add a `web` service: `command: khipu web`; publish `127.0.0.1:3333:3333`; mount `db-data` at `/app/khipuchat.db` and `hf-cache` at the `HF_HOME` path.
  - Add a `sync` service: `command: sh -c "while true; do khipu sync all; sleep ${SYNC_INTERVAL:-3600}; done"`; mount the same `db-data` and `hf-cache` volumes. This makes the sync service long-running as required.
  - Fix the `db-data` volume mount target from `/app/telegram.db` to `/app/khipuchat.db`; declare both `db-data` and `hf-cache` in the top-level `volumes:` block.
  - Retain (or restore) the commented env-var block documenting all required variables (`DISCORD_TOKEN`, `SLACK_USER_TOKEN`, `DB_KEY`, `WEB_USER`, `WEB_PASS`, `MCP_SECRET`, `SYNC_INTERVAL`).
  - Add a comment documenting the stdio-MCP interactive usage for Claude Desktop: `docker run -i --rm -v khipuchat_db-data:/app/khipuchat.db <image> khipu mcp`.
  - `docker compose config` parses without errors; the config shows two services (`web`, `sync`) sharing the `db-data` volume.
  - _Requirements: 1.3, 1.4, 1.5, 1.6_
  - _Boundary: docker-compose.yml_
  - _Depends: 1.2_

- [x] 3.3 (P) Replace placeholder email in `SECURITY.md`
  - Replace the placeholder disclosure email (e.g. `security@khipuchat.example.com`) with `yanick.landry@gmail.com`.
  - `SECURITY.md` exists at the repo root; it includes private vulnerability reporting instructions and the updated contact email.
  - _Requirements: 4.1, 4.2_
  - _Boundary: SECURITY.md_

- [x] 3.4 (P) Update `README.md` to reference `khipu` commands and add missing sections
  - Replace all `npm run sync*`, `npx tsx src/...`, and `npm run setup-*` references in the README with the corresponding `khipu <subcommand>` equivalents (e.g. `khipu sync all`, `khipu sync telegram`, `khipu setup-claude`).
  - Add an `npm link` contributor workflow section: `git clone` → `npm install` → `npm link` → `khipu` is now on PATH.
  - Add a `khipu.config.json` multi-account section documenting the config file format; include the incremental-sync note stating that iMessage reads the local `chat.db` and always performs a full scan (cannot filter server-side), while other platforms filter incrementally.
  - Update or add a Docker quickstart section with the minimum steps: `git clone`, `cp .env.example .env`, edit tokens, `docker compose up`.
  - Verify `docs/demo.png` (or `docs/demo.gif`) is linked from the README and the file is present and under 5 MB.
  - README renders without broken image links or dead references in a local Markdown preview; all `khipu` commands in the README match commands the router actually resolves.
  - _Requirements: 5.2, 5.3, 6.1, 6.2, 6.3, 6.4_
  - _Boundary: README.md_

- [ ] 4. Verify existing CI and release workflows meet requirements
- [x] 4.1 Audit `.github/workflows/ci.yml` and `.github/workflows/release.yml`
  - Read `ci.yml` and confirm: trigger covers `push` and `pull_request` to `main`; job runs on `ubuntu-latest`; uses Node 20; runs `npm ci` then `npm test`; a test failure will mark the check failed.
  - Read `release.yml` and confirm: trigger is `push: tags: ['v*']`; uses QEMU and Buildx for multi-arch; authenticates to `ghcr.io` using `GITHUB_TOKEN` only (no manually created secrets); builds and pushes `linux/amd64,linux/arm64`; tags the image with the git tag version and `latest`.
  - If either workflow is missing a required element, apply the minimum correction needed to satisfy the requirements.
  - After audit, both workflow files fully satisfy requirements 2.1–2.3 and 3.1–3.3; no manual secrets are required beyond `GITHUB_TOKEN`.
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3_
  - _Boundary: .github/workflows/_
