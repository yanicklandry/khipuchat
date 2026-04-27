# KhipuChat — Roadmap

Personal multi-platform message archive with MCP server and web UI.
Goal: sync all your conversations locally, query them with Claude, search them in a browser.

## Principles
- Each phase is independently useful — nothing breaks existing features
- Every phase requires passing tests before the next one starts
- Keep it simple: no frameworks, no unnecessary dependencies
- Self-hosted only — your messages never leave your machine

---

## ✅ Phase 1 — Telegram sync + MCP (complete)

**What it does:** Syncs all Telegram DMs and groups to SQLite. Exposes them to Claude via MCP.

**Scripts:** `npm run sync` · `npm run setup-claude`

**MCP tools:** `find_chat_by_name` · `list_messages` · `search_messages` · `get_chat_summary`

---

## 🔲 Phase 2 — iMessage integration

**Goal:** Read your Mac's local iMessage history (no auth, no API — just read the file).

**Approach:** Parse `~/Library/Messages/chat.db` (SQLite) directly, map to existing schema.

**New script:** `npm run sync:imessage` — one-shot import, no daemon needed (iMessage syncs itself).

**Tests:** schema mapping, deduplication, chat name resolution from address book.

**Why first:** Zero-dependency, zero-auth, immediately useful on Mac.

---

## 🔲 Phase 3 — Web UI

**Goal:** Simple local search interface. No framework, no build step.

**Stack:** Express + plain HTML/CSS served from `src/web.ts`. Single page.

**Features:**
- Search box (calls `search_messages` logic)
- Chat list sidebar
- Message thread view for selected chat
- Platform badge (telegram / imessage) on each message

**New script:** `npm run web` → starts on `http://localhost:3333`

**Tests:** Express route handlers with supertest, seeded in-memory DB.

---

## 🔲 Phase 4 — Discord integration

**Goal:** Sync DMs and server channels you're a member of.

**Approach:** Discord bot token with `dm_channel:read` + `message_content` intent.

**New env vars:** `DISCORD_TOKEN`

**New script:** `npm run sync:discord`

**Tests:** mocked Discord REST client, pagination, deduplication.

**Why Discord:** Clean official API, full history access, popular for portfolio demo.

---

## 🔲 Phase 5 — Email (IMAP)

**Goal:** Pull email threads into the same search index.

**Approach:** `imapflow` npm package. Fetch sent + received, store as messages with `type='text'`.

**New env vars:** `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASS`

**New script:** `npm run sync:email`

**Tests:** mocked IMAP client, thread grouping, deduplication by Message-ID header.

---

## 🔲 Phase 6 — Slack integration

**Goal:** Sync your Slack DMs and channels.

**Approach:** Personal Slack app with `im:history` + `mpim:history` OAuth scopes, user token.

**New env vars:** `SLACK_USER_TOKEN`

**New script:** `npm run sync:slack`

**Tests:** mocked Slack Web API responses, pagination cursor handling.

---

## 🔲 Phase 7 — WhatsApp integration

**Goal:** Sync WhatsApp DMs.

**Approach:** `whatsapp-web.js` (unofficial, uses WhatsApp Web). Scan QR code once, session saved.

**New env vars:** `WHATSAPP_SESSION` (auto-written after QR scan)

**New script:** `npm run sync:whatsapp`

**Risk:** Unofficial API — may break on WhatsApp updates.

**Tests:** mocked client, message mapping.

---

## 🔲 Phase 8 — Security hardening

**Goal:** Safe to run on a shared machine or eventually expose behind auth.

**Changes:**
- Encrypt SQLite with SQLCipher (`better-sqlite3-multiple-ciphers`)
- Password-protect the web UI (`express-basic-auth`)
- MCP bearer token (env var `MCP_SECRET`, checked in `mcp.ts`)
- Bind web server to `127.0.0.1` only

**Tests:** verify DB file is not readable as plain text, auth middleware rejects missing tokens.

---

## 🔲 Phase 9 — Release

**Goal:** Anyone can run this with one command.

**Changes:**
- `Dockerfile` + `docker-compose.yml`
- GitHub Actions: run tests on push, publish Docker image on tag
- `SECURITY.md` (responsible disclosure — project handles private messages)
- Demo GIF in README

---

## Out of scope (separate projects)
- Sending messages on any platform
- Instagram / Facebook (Beeper handles these; unofficial APIs are fragile)
- Mobile app
- Cloud sync / multi-device
