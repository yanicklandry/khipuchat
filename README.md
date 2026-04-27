# KhipuChat

Self-hosted Telegram sync daemon + MCP server. Gives Claude Desktop full access to your Telegram message history.

## Prerequisites

- Node.js 20+
- A Telegram account
- [Telegram API credentials](https://my.telegram.org/apps) (API ID + API Hash)

## Installation

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```
API_ID=your_api_id
API_HASH=your_api_hash
PHONE_NUMBER=+1234567890
SESSION_STRING=        # leave empty — filled automatically on first run
```

## Setup (one time)

### 1. Authenticate and backfill

```bash
npm run sync
```

This will:
1. Prompt for your phone number and OTP
2. Save the session to `.env` (you won't be asked again)
3. Download all message history from your DMs and groups
4. Stay running and listen for new messages in real time

Keep this terminal open, or switch to pm2 (see below).

### 2. Configure Claude Desktop

In a separate terminal:

```bash
npm run setup-claude
```

This verifies the server starts correctly, then writes the config entry automatically.

**Then restart Claude Desktop:** Claude → Quit Claude, then reopen it.

> Claude Desktop spawns the MCP server itself — you never need to run `npm run mcp` manually.

### 3. Test it

Ask Claude:

> "Use KhipuChat to find my chat with Tony Lin and show me the last 20 messages"

## Keeping sync running (recommended)

Use pm2 so the sync daemon survives reboots and restarts automatically on crash:

```bash
npm install -g pm2
pm2 start "npm run sync" --name KhipuChat
pm2 save
pm2 startup   # auto-start on login — follow the printed command
```

```bash
pm2 status
pm2 logs KhipuChat
```

## Daily workflow

Nothing to do — just make sure `npm run sync` (or pm2) is running. Claude Desktop handles the rest.

If you run `npm run setup-claude` again (e.g. after a Node upgrade), restart Claude Desktop afterwards.

## Using with Claude

- *"Use KhipuChat to find my chat with Tony Lin and show me the last 20 messages"*
- *"Search my Telegram messages for 'flight booking'"*
- *"Give me a summary of my conversation with Tony Lin"*

## Available MCP tools

| Tool | Description |
|---|---|
| `find_chat_by_name(name)` | Find chats by name or @username |
| `list_messages(chat_id, limit?, before_timestamp?)` | List text messages (max 200) |
| `search_messages(query, chat_id?)` | Full-text search across all messages |
| `get_chat_summary(chat_id)` | Stats + last 5 texts for a chat |

## Database

Messages are stored in `./telegram.db` (SQLite). Inspect with:

```bash
sqlite3 telegram.db "SELECT name, message_count, datetime(last_synced_at, 'unixepoch', 'localtime') FROM chats ORDER BY message_count DESC"
```
