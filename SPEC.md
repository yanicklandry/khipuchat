# telegram-bridge — Project Spec

## Goal
A self-hosted Telegram sync daemon + local MCP server that gives Claude Desktop
full access to Telegram message history. Replaces Beeper's Telegram integration.

## Validation target
After build, Claude Desktop must be able to call `find_chat_by_name("Tony Lin")`
and `list_messages(chat_id)` and get the full real text conversation history
(excluding media-only/reel messages) with Tony Lin (@tonylin1115, Melbourne).

## Stack
- Runtime: Node.js 20+ with TypeScript
- Telegram API: gramjs (GramJS) — pure JS MTProto, no native deps
- Database: SQLite via better-sqlite3
- MCP server: @modelcontextprotocol/sdk
- Test runner: Vitest
- Config: .env file

## Architecture

### src/config.ts
- Load .env vars: API_ID, API_HASH, PHONE_NUMBER, SESSION_STRING
- SESSION_STRING starts empty, is written back to .env after first auth
- Export typed config object

### src/db.ts
Schema — two tables:

chats:
  id INTEGER PRIMARY KEY        -- Telegram chat ID
  name TEXT NOT NULL            -- display name
  type TEXT NOT NULL            -- 'user' | 'group' | 'channel'
  username TEXT                 -- @handle if available
  last_synced_at INTEGER        -- unix timestamp of last synced message
  message_count INTEGER DEFAULT 0

messages:
  id INTEGER PRIMARY KEY AUTOINCREMENT
  telegram_id TEXT NOT NULL     -- Telegram's own message ID
  chat_id INTEGER NOT NULL      -- FK → chats.id
  sender_id TEXT
  sender_name TEXT
  text TEXT                     -- null for media-only messages
  type TEXT NOT NULL            -- 'text'|'voice'|'video'|'image'|'sticker'|'reaction'|'notice'
  timestamp INTEGER NOT NULL    -- unix epoch
  is_sender INTEGER NOT NULL    -- 0 or 1 (boolean)
  reply_to_telegram_id TEXT     -- nullable

  UNIQUE(telegram_id, chat_id)

Indexes: messages(chat_id, timestamp), messages(chat_id, type)

Exported functions:
  upsertChat(chat), insertMessage(msg), getChats(), 
  getMessages(chatId, limit, beforeTimestamp),
  searchMessages(query, chatId?), getLastSyncedId(chatId)

### src/sync.ts
First-run wizard:
  - If SESSION_STRING is empty: prompt phone number → send code → prompt OTP
    → create StringSession → write SESSION_STRING to .env → print "Auth saved"
  - If SESSION_STRING exists: connect silently

Backfill (run once per chat):
  - Fetch all dialogs (DMs + groups, skip channels/broadcast)
  - For each dialog: paginate through ALL history oldest-first using getMessages
  - Resume from getLastSyncedId(chatId) if already partially synced
  - Store every message via insertMessage
  - Log: "[ChatName] synced X messages (Y total)"
  - Rate limit: 1 second sleep between dialog backfills

Real-time listener (after backfill):
  - client.addEventHandler on NewMessage
  - Insert incoming messages to DB in real time
  - Log: "New message in [ChatName]"

npm run sync → runs wizard if needed, then backfill, then listens

### src/mcp.ts
MCP server on stdio (Claude Desktop compatible).

Tools:

find_chat_by_name(name: string) → { chat_id, name, type, username, message_count }[]
  - Case-insensitive fuzzy match on chats.name and chats.username
  - Returns array sorted by message_count desc

list_messages(chat_id: number, limit?: number, before_timestamp?: number)
→ { id, sender_name, text, type, timestamp, is_sender }[]
  - Default limit 50, max 200
  - Only returns messages where type='text' AND text IS NOT NULL AND text != ''
  - Ordered by timestamp ASC (chronological)
  - before_timestamp for pagination

search_messages(query: string, chat_id?: number)
→ { chat_id, chat_name, sender_name, text, timestamp }[]
  - SQLite FTS or LIKE search on messages.text
  - Optional chat_id filter
  - Limit 100 results

get_chat_summary(chat_id: number)
→ { name, type, username, message_count, first_message_date, last_message_date, last_5_texts: string[] }

npm run mcp → starts MCP server on stdio

### Project structure
telegram-bridge/
├── src/
│   ├── config.ts
│   ├── db.ts
│   ├── sync.ts
│   └── mcp.ts
├── tests/
│   ├── db.test.ts
│   ├── sync.test.ts  (mocked GramJS client)
│   └── mcp.test.ts
├── .env.example
├── .env               (gitignored)
├── CLAUDE.md
├── SPEC.md
├── package.json
└── tsconfig.json

## npm scripts
  sync    → ts-node src/sync.ts
  mcp     → ts-node src/mcp.ts
  test    → vitest run
  test:watch → vitest

## .env.example
API_ID=
API_HASH=
PHONE_NUMBER=
SESSION_STRING=

## Phased build plan

### Phase 1 — Config + DB (no Telegram)
Deliverable: tests/db.test.ts passes
Tests cover: schema creation, upsertChat, insertMessage, getMessages,
searchMessages, UNIQUE constraint on (telegram_id, chat_id)
Validation: npm test → all green

### Phase 2 — Auth wizard
Deliverable: npm run sync triggers interactive auth flow on first run,
writes SESSION_STRING to .env, exits cleanly
Tests cover: config loading, SESSION_STRING write (mocked fs)
Validation: manually run npm run sync, complete auth, confirm .env has SESSION_STRING

### Phase 3 — Backfill + listener
Deliverable: npm run sync (with valid session) backfills all DMs,
Tony Lin's chat appears in SQLite with full text history
Tests cover: backfill loop with mocked GramJS client (50 fake messages),
pagination, rate limiting, resume from last synced ID
Validation: open DB with `sqlite3 telegram.db "SELECT count(*) FROM messages
WHERE chat_id = (SELECT id FROM chats WHERE name LIKE '%Tony%')"` → non-zero

### Phase 4 — MCP server
Deliverable: Claude Desktop can query Tony Lin's history via MCP tools
Tests cover: all 4 MCP tools with seeded test DB
Validation: add to claude_desktop_config.json, open Claude Desktop,
ask "use the telegram-bridge MCP to find Tony Lin and show me our last 20 messages"

## Out of scope
- Sending messages
- WhatsApp / Instagram / Signal
- Downloading media files
- Web UI
- Docker