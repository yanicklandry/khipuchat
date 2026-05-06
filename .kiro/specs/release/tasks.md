# Implementation Plan

- [ ] 1. Docker image and compose file
- [ ] 1.1 Write Dockerfile and .dockerignore
  - Create multi-stage `Dockerfile`: Node 20 Alpine builder (`npm ci`, copy src) → Node 20 Alpine runtime (copy node_modules + src)
  - Create `.dockerignore` excluding `*.db`, `.env`, `node_modules`, `tests/`, `.git`
  - `docker build .` completes without error on the local machine
  - _Requirements: 1.1, 1.2_

- [ ] 1.2 Write docker-compose.yml
  - `docker-compose.yml` with one service: build from `.`; `env_file: .env`; port `127.0.0.1:3333:3333`; named volume `db-data` mounted at `/app/telegram.db`
  - Include commented-out examples of all env vars (`DISCORD_TOKEN`, `SLACK_USER_TOKEN`, `DB_KEY`, `WEB_USER`, `WEB_PASS`, `MCP_SECRET`, etc.)
  - `docker compose config` validates without errors
  - _Requirements: 1.3, 1.4, 1.5_

- [ ] 2. GitHub Actions workflows (parallel)
- [ ] 2.1 (P) Write CI workflow
  - Create `.github/workflows/ci.yml`: trigger on push and pull_request to `main`; Ubuntu Latest, Node 20; `npm ci && npm test`
  - Workflow YAML is valid (no syntax errors via `yamllint` or GitHub Actions validator)
  - _Requirements: 2.1, 2.2, 2.3_
  - _Boundary: .github/workflows/ci.yml_

- [ ] 2.2 (P) Write release workflow
  - Create `.github/workflows/release.yml`: trigger on `push: tags: ['v*']`; QEMU + Buildx for multi-arch; `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN`; `docker/build-push-action` for `linux/amd64,linux/arm64`; tags `ghcr.io/{repo}:{tag}` and `ghcr.io/{repo}:latest`
  - Workflow YAML is valid
  - _Requirements: 3.1, 3.2, 3.3_
  - _Boundary: .github/workflows/release.yml_

- [ ] 3. Security policy and documentation
- [ ] 3.1 Write SECURITY.md
  - Create `SECURITY.md` with: supported versions table, vulnerability reporting instructions (private disclosure via email), contact email address, expected response timeline
  - File exists at repo root; includes a contact email
  - _Requirements: 4.1, 4.2_

- [ ] 3.2 Create demo asset and update README
  - Record a demo GIF or take a screenshot of the web UI in action; save as `docs/demo.gif` (or `docs/demo.png`); confirm file size ≤ 5 MB
  - Add a "Docker Quickstart" section to `README.md`: `git clone`, `cp .env.example .env`, fill in tokens, `docker compose up`
  - Link the demo asset from the README
  - `docs/demo.gif` (or `.png`) is committed and under 5 MB; README renders the image in GitHub preview
  - _Requirements: 5.1, 5.2, 5.3_
