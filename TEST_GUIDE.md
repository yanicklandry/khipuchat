# KhipuChat Manual Test Guide

Generated 2026-07-16 from a full-project status review.

**What the automated suite already covers:** 868/868 unit + integration + e2e tests pass
under Node 24. You do **not** need to manually re-verify pure logic (routing, query handlers,
registry parsing, DB migrations, FTS, embedding math with the mock model).

**What this guide covers:** the paths the automated suite *cannot* verify: real external-account
auth, live syncs, the web UI in a browser, real embeddings, image OCR, and the MCP server inside
Claude Desktop. Every step is copy-paste scriptable where possible.

Repo: `git@github.com:yanicklandry/khipuchat.git`
DB: `./khipuchat.db` (already present) — Web UI: `http://127.0.0.1:3333` — Media: `./media/`

---

## 0. Environment preflight (run first)

The native module `better-sqlite3-multiple-ciphers` is ABI-locked to Node 24. Using any other
Node (the machine default is Node 26) causes `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` errors.

```bash
cd ~/Developer/2026/khipuchat

# 1. Use the pinned Node (.nvmrc = 24)
nvm use            # must print "Now using node v24.x"
node -v            # expect v24.x — NOT v26

# 2. Install + ensure the native module matches this Node ABI
npm install
npm rebuild better-sqlite3-multiple-ciphers

# 3. Sanity: DB opens under this Node
node -e "const D=require('better-sqlite3-multiple-ciphers'); new D(':memory:'); console.log('sqlite OK')"
```

Expected final line: `sqlite OK`. If you see a `NODE_MODULE_VERSION` error, you are on the wrong
Node: re-run `nvm use` and `npm rebuild`.

---

## 1. Automated baseline (confirm green before manual work)

```bash
# Full test suite — expect "Tests  868 passed (868)"
npm test

# Type check — expect a clean pass (exit 0, no output).
npm run typecheck ; echo "tsc exit: $?"
```

Both previously-queued build issues are now resolved (PR #5, 2026-07-30):
- `tsconfig-typecheck-fix` — `tsc --noEmit` passes; a `typecheck` npm script exists. tsconfig
  dropped `rootDir`/`outDir` (no tsc emit build; everything runs via `tsx`) and added `noEmit`.
- `node-engines-pin` — `package.json` pins `"engines": { "node": ">=24 <25" }`, and `.npmrc`
  sets `engine-strict=true` so `npm install` hard-fails on the wrong Node.

---

## 2. Web UI (browser + scriptable API checks)

Start the server:

```bash
npm run web
# => "KhipuChat web UI running at http://127.0.0.1:3333"
```

### 2a. Scriptable API smoke test (new terminal, server left running)

```bash
BASE=http://127.0.0.1:3333

# Home page renders HTML
curl -s -o /dev/null -w "GET /            => %{http_code}\n" $BASE/

# Chats list (JSON array)
curl -s "$BASE/api/chats" | head -c 400; echo

# Keyword search (FTS) — expect a JSON array
curl -s "$BASE/api/search?q=hello" | head -c 400; echo

# Messages for a chat — grab a real chatId from /api/chats first:
CHAT=$(curl -s "$BASE/api/chats" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a[0]?.id ?? '')})")
echo "using chatId=$CHAT"
curl -s "$BASE/api/messages/$CHAT?limit=5" | head -c 500; echo

# Pagination param validation (expect 400 + {"error":...})
curl -s -w " [%{http_code}]\n" "$BASE/api/messages/$CHAT?limit=999"
curl -s -w " [%{http_code}]\n" "$BASE/api/messages/$CHAT?before=-1"

# Semantic search — returns {"error":"Embedding index not built..."} until section 3 is done
curl -s "$BASE/api/semantic-search?q=weekend+plans&limit=5" | head -c 400; echo
```

Expected: `/` = 200, `/api/chats` = JSON array, bad `limit`/`before` = `[400]`.

### 2b. Browser checklist (open http://127.0.0.1:3333)

- [ ] Chat list loads in the left panel, sorted by most recent activity.
- [ ] Clicking a chat loads its messages in the right panel.
- [ ] Placeholder "Select a chat to view messages" shows before selecting.
- [ ] **Infinite scroll:** scroll to the top of a long thread => older messages prepend without the
      viewport jumping (this is the `ui-scroll.ts` reverse-insertion behavior).
- [ ] Keyword search box returns results; empty query clears results.
- [ ] **Semantic search toggle:** flip it on, search a *concept* (not exact words); after section 3
      is done you should get meaning-matched results.
- [ ] If multiple accounts exist, the account selector filters chats (`?account=<name>`).

Stop with Ctrl-C when done.

---

## 3. Semantic search + embeddings (real model, not the mock)

The suite uses a mock embedder (`KHIPUCHAT_EMBED_MOCK`). Real quality must be checked by hand.

```bash
# Build the real embedding index (downloads the HF model on first run — can take minutes)
npm run index:embeddings
# => ends with "Done. Indexed ..."

# Re-run: should skip already-indexed rows
npm run index:embeddings
# => reports skipped/already-indexed totals

# Query by meaning via CLI
npm run cli -- semantic-search "plans for the weekend" --limit 5
npm run cli -- semantic-contacts "old friend from Shanghai around 2019" --limit 5
```

- [ ] Results are topically relevant even when they share no exact keywords with the query.
- [ ] `/api/semantic-search?q=...` in the web UI now returns results instead of the "not built" error.

---

## 4. Image support + OCR

Images sync into `./media/` and get OCR text via tesseract.

```bash
# After an image-bearing sync (section 6), confirm files landed
ls -la media/ | head
BASE=http://127.0.0.1:3333

# Find an image message id, then fetch it through MCP get_image (section 8) or check the DB:
node -e "const D=require('better-sqlite3-multiple-ciphers');const db=new D('./khipuchat.db');console.log(db.prepare(\"select id, type, media_path, ocr_text from messages where media_path is not null limit 5\").all())"
```

- [ ] Image messages have a non-null `media_path` pointing to a file that exists in `media/`.
- [ ] `ocr_text` is populated for images that contain legible text.
- [ ] In the web UI, image messages render (not shown as empty/broken).

---

## 5. CLI router smoke test (scriptable)

```bash
KH="node bin/khipu"   # or: alias kh once installed globally

$KH --help                       # usage banner
$KH sync                         # sync status table for all platforms
$KH search "test" --limit 3      # keyword search
$KH list chats --limit 5
$KH list messages --limit 5
$KH search --help                # per-subcommand help
$KH bogus                        # => "Unknown command: bogus" + usage, exit 1
$KH sync notaplatform            # => "Unknown platform: notaplatform"
```

- [ ] Known commands run; unknown command/platform print a helpful error and exit non-zero.

---

## 6. Live per-platform sync (real credentials)

Configure credentials, then sync each platform you use. Single-account mode reads env vars from
`.env`; multi-account mode reads `khipu.config.json` (array of `{name, ...fields}` per platform).
Verify each sync wrote rows: `node bin/khipu sync` shows per-platform status.

### Telegram (native, GramJS)
- Get API credentials: **https://my.telegram.org/apps** (API ID + API Hash).
- `.env`: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER`.
- First run prompts for phone + OTP, then prints a session string => save as `TELEGRAM_SESSION_STRING`.
```bash
node bin/khipu sync telegram
```
- [ ] OTP login succeeds; messages appear in `/api/chats`.

### Email (IMAP)
- `.env`: `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASS` (use an app password for Gmail:
  **https://myaccount.google.com/apppasswords**, host `imap.gmail.com`).
```bash
node bin/khipu sync email
```

### Discord (user token)
- `DISCORD_TOKEN` in `.env`. Hits `https://discord.com/api/v10`.
```bash
node bin/khipu sync discord
```

### Slack (user token)
- `SLACK_USER_TOKEN` (an `xoxp-...` user token). Hits `https://slack.com/api`.
  Create/manage at **https://api.slack.com/apps**.
```bash
node bin/khipu sync slack
```

### WhatsApp (whatsapp-web.js, QR)
- First run prints a QR code in the terminal: scan it in WhatsApp => Linked devices.
- Session persists via `WHATSAPP_SESSION`.
```bash
node bin/khipu sync whatsapp
```

### iMessage (macOS only, no token)
- Grant **Full Disk Access** to your terminal: System Settings => Privacy & Security =>
  Full Disk Access. Reads `~/Library/Messages/chat.db` directly.
```bash
node bin/khipu sync imessage
```
- [ ] Without Full Disk Access it prints a clear "grant Full Disk Access" error (verify the guard).

### Signal (via Beeper Desktop)
- Requires Beeper Desktop running with Signal connected. `BEEPER_ACCESS_TOKEN` in `.env`.
```bash
node bin/khipu sync signal
```

**Incremental vs backfill (`incremental-sync` spec):**
```bash
node bin/khipu sync telegram            # first run = backfill
node bin/khipu sync telegram            # second run = incremental (only new msgs)
node bin/khipu sync telegram --force    # full re-read + embeddings rebuild
```
- [ ] Second run is fast and only pulls new messages; `--force` re-reads everything.

---

## 7. Sync daemon (`sync-watcher` spec)

```bash
node bin/khipu sync all --once     # one pass across all configured platforms, then exit
node bin/khipu sync all            # continuous daemon
```

- [ ] `--once` completes and exits 0.
- [ ] Continuous mode polls on an interval; **Ctrl-C shuts down gracefully** (no orphaned handles,
      no half-written DB) — this is the graceful-shutdown task.

---

## 8. MCP server in Claude Desktop

```bash
# Register KhipuChat in Claude Desktop's config
node bin/khipu setup-claude
# Writes ~/Library/Application Support/Claude/claude_desktop_config.json (mcpServers.khipuchat)
```

Restart Claude Desktop, then in a conversation confirm these tools respond:
- [ ] `list_chats` — lists synced chats.
- [ ] `find_chat_by_name` — finds a chat by name/username.
- [ ] `list_messages` — messages for a chat (and archive-wide when `chat_id` omitted).
- [ ] `search_messages` — full-text search.
- [ ] `get_chat_summary` — summary + recent texts for a `chat_id`.
- [ ] `semantic_search_messages` / `semantic_find_contacts` — require section 3's index first.
- [ ] `get_image` — returns base64 image + `ocr_text` for an image message id.

Quick raw check without Claude Desktop (stdio server starts and lists tools):
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/khipu mcp | head -c 800; echo
```

---

## 9. Security hardening spot-checks (`security-hardening` spec)

- [ ] **Web binds localhost only:** `npm run web` logs `127.0.0.1:3333`. Confirm it is NOT reachable
      from another machine on the LAN (bind host is hard-coded to `127.0.0.1`).
- [ ] **Web basic auth:** set `WEB_USER` / `WEB_PASS`, restart `npm run web`, confirm the browser
      prompts for credentials and rejects wrong ones.
- [ ] **DB encryption:** set `DB_KEY`, run a sync, then confirm the DB is unreadable without the key:
```bash
# With DB_KEY set, a plain (keyless) open of an encrypted DB should fail:
DB_KEY= node -e "const D=require('better-sqlite3-multiple-ciphers');const db=new D('./khipuchat.db');try{db.prepare('select count(*) from messages').get();console.log('OPENED WITHOUT KEY (unexpected if encrypted)')}catch(e){console.log('rejected without key: OK')}"
```
- [ ] **MCP secret:** if `MCP_SECRET` is configured, unauthenticated MCP calls are rejected.

---

## Sign-off checklist

- [ ] Section 0 preflight passes (Node 24, `sqlite OK`).
- [ ] Section 1: `npm test` = 868 passed.
- [ ] Web UI: chats, messages, infinite scroll, keyword + semantic search all work in a browser.
- [ ] Embedding index built; semantic results are relevant.
- [ ] Each platform you use syncs with real credentials; incremental + `--force` behave correctly.
- [ ] Image OCR populated; images render.
- [ ] Sync daemon runs and shuts down cleanly.
- [ ] MCP tools respond inside Claude Desktop.
- [ ] Security: localhost bind, basic auth, DB encryption verified.
