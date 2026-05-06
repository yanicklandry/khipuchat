# Brief: release

## Problem
KhipuChat requires manual setup (clone, npm install, configure .env). Non-technical users can't run it, and there's no CI to catch regressions.

## Current State
All features implemented. No Docker, no CI, no demo, no responsible disclosure policy.

## Desired Outcome
Anyone can run KhipuChat with `docker compose up`. Tests run automatically on every push. A Docker image is published on every git tag. A demo GIF in README shows the tool in action.

## Approach
- **Docker**: Multi-stage Dockerfile (build → runtime). `docker-compose.yml` with volumes for `telegram.db` and `.env`.
- **CI**: GitHub Actions workflow — `npm test` on push/PR to main, Docker build+push on tag using ghcr.io.
- **SECURITY.md**: Responsible disclosure policy (this project handles private messages).
- **Demo GIF**: Recorded with asciinema or screen capture, committed to `docs/` and linked in README.

## Scope
- **In**: `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `SECURITY.md`, demo GIF in `docs/`, README updates for Docker usage
- **Out**: Kubernetes/Helm, paid registry, auto-update mechanism, cloud hosting

## Boundary Candidates
- Docker image build — Dockerfile + compose, no code changes
- CI pipeline — GitHub Actions YAML only
- Documentation — SECURITY.md, README section, demo GIF

## Out of Boundary
- New features — all features locked before release spec
- Security changes — security-hardening spec owns those

## Upstream / Downstream
- **Upstream**: all other specs (release packages the complete product)
- **Downstream**: end users, public repo

## Existing Spec Touchpoints
- **Extends**: README.md (add Docker quickstart section)
- **Adjacent**: package.json (verify all scripts work inside Docker)

## Constraints
- Docker image must work on linux/amd64 and linux/arm64 (Apple Silicon users)
- GitHub Actions must use ghcr.io (free for public repos)
- Demo GIF must be under 5MB
- SECURITY.md must include a contact email for responsible disclosure
