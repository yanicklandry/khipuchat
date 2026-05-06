# Design Document — release

## Overview

Release packaging via standard Docker + GitHub Actions tooling. The Dockerfile is a two-stage build (Node 20 Alpine builder → Node 20 Alpine runtime). Docker Compose wires volumes and env vars. Two GitHub Actions workflows: CI (test on push/PR) and Release (build+push multi-arch image on tag). No code changes to the application itself.

### Non-Goals
- Kubernetes, paid registries, auto-update.

## Boundary Commitments

### This Spec Owns
- `Dockerfile`, `docker-compose.yml`.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`.
- `SECURITY.md`.
- `docs/demo.gif` (or `.png` screenshot).
- README Docker quickstart section.

### Out of Boundary
- Application source code changes.
- `package.json` script changes (already handled by other specs).

### Revalidation Triggers
- Node version bumps; new env vars added by other specs (docker-compose.yml needs updating).

## File Structure Plan

```
Dockerfile
docker-compose.yml
SECURITY.md
docs/
└── demo.gif          # or demo.png; under 5 MB
.github/
└── workflows/
    ├── ci.yml
    └── release.yml
README.md             # modified: add Docker quickstart section
```

## Component Designs

### Dockerfile (multi-stage)

```dockerfile
# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Stage 2: runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json .
COPY --from=builder /app/tsconfig.json .
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/mcp.ts"]
```

- `better-sqlite3-multiple-ciphers` requires native build; `npm ci` in builder handles this on Alpine with `node-gyp` pre-installed.
- `.dockerignore` excludes `*.db`, `.env`, `node_modules`, `tests/`.

### docker-compose.yml

```yaml
services:
  khipuchat:
    build: .
    volumes:
      - db-data:/app/telegram.db
    env_file: .env
    ports:
      - "127.0.0.1:3333:3333"
volumes:
  db-data:
```

### ci.yml

```yaml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm test
```

### release.yml

```yaml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: { packages: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3        # arm64 emulation
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}:latest
```

## Requirements Traceability

| Requirement | File |
|-------------|------|
| 1.1–1.5 | Dockerfile, docker-compose.yml |
| 2.1–2.3 | .github/workflows/ci.yml |
| 3.1–3.3 | .github/workflows/release.yml |
| 4.1, 4.2 | SECURITY.md |
| 5.1–5.3 | docs/demo.gif, README.md |
