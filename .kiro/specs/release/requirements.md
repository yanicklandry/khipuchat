# Requirements Document

## Introduction

The Release spec packages KhipuChat for easy self-hosted deployment: a multi-arch Docker image, `docker compose up` quickstart, GitHub Actions CI/CD, a security disclosure policy, and a demo GIF in the README.

## Boundary Context

- **In scope**: `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `SECURITY.md`, demo GIF in `docs/`, README Docker section.
- **Out of scope**: Kubernetes/Helm, paid registries, auto-update mechanism, cloud hosting, new feature development.
- **Adjacent expectations**: All other specs must be implemented before the release spec is executed. `package.json` scripts must work inside the Docker container.

## Requirements

### Requirement 1: Docker Image

**Objective:** As a user, I want to run KhipuChat with `docker compose up` without installing Node or configuring the system.

#### Acceptance Criteria

1. The Docker image shall use a multi-stage build: a build stage that compiles/installs dependencies, and a minimal runtime stage.
2. The Docker image shall support both `linux/amd64` and `linux/arm64` platforms (Apple Silicon compatible).
3. When `docker compose up` is run with a correctly configured `.env` file, the MCP server and web UI shall start and be functional.
4. The `docker-compose.yml` shall mount a named volume for `telegram.db` so that data persists across container restarts.
5. The `docker-compose.yml` shall document all required env vars as commented-out examples.

---

### Requirement 2: CI Pipeline

**Objective:** As a contributor, I want tests to run automatically on every push and pull request so regressions are caught before merge.

#### Acceptance Criteria

1. The CI workflow shall run `npm test` on every push to `main` and on every pull request targeting `main`.
2. The CI workflow shall run on `ubuntu-latest` using Node 20.
3. If `npm test` fails, the CI workflow shall mark the check as failed and block merge.

---

### Requirement 3: Docker Release Pipeline

**Objective:** As a maintainer, I want a Docker image published automatically when a git tag is pushed.

#### Acceptance Criteria

1. When a git tag matching `v*` is pushed, the release workflow shall build and push a multi-arch Docker image to `ghcr.io`.
2. The image shall be tagged with both the git tag version and `latest`.
3. The release workflow shall use `GITHUB_TOKEN` for authentication to `ghcr.io` (no manual secrets required).

---

### Requirement 4: Security Disclosure Policy

**Objective:** As a user handling private messages, I want to know how to report security vulnerabilities responsibly.

#### Acceptance Criteria

1. `SECURITY.md` shall exist at the repository root and describe how to report a vulnerability privately.
2. `SECURITY.md` shall include a contact email address for responsible disclosure.

---

### Requirement 5: Demo and Documentation

**Objective:** As a prospective user, I want to see the tool in action before installing it.

#### Acceptance Criteria

1. A demo GIF or screenshot shall exist in `docs/` and be linked from the README.
2. The demo asset shall be under 5 MB.
3. The README shall include a Docker quickstart section with the minimum commands needed to get started.
