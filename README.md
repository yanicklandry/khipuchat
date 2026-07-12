# KhipuChat

Self-hosted multi-platform message archive + MCP server. Sync Telegram, iMessage, Discord, Slack, WhatsApp, WeChat, and email into a local SQLite database, then browse them in a web UI or query them with Claude.

![KhipuChat web UI](docs/demo.png)

## Docker Quickstart

```bash
git clone https://github.com/your-username/khipuchat.git
cd khipuchat
cp .env.example .env
# Edit .env and add your API tokens (TELEGRAM_API_ID, TELEGRAM_API_HASH, etc.)
docker compose up
```

The web UI will be available at http://127.0.0.1:3333.

To run a sync (backfill messages) inside the container:

```bash
docker compose run --rm sync khipu sync telegram
```

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
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_PHONE_NUMBER=+1234567890
TELEGRAM_SESSION_STRING=        # leave empty - filled automatically on first run
```

## Setup (one time)

### 1. Authenticate and backfill

```bash
khipu sync all
```

This will:
1. Prompt for your phone number and OTP
2. Save the session to `.env` (you won't be asked again)
3. Download all message history from your DMs and groups
4. Stay running and listen for new messages in real time

This is a one-time step. After auth completes, keep the process running or use `khipu setup-sync` (see below).

### 2. Configure Claude Desktop

In a separate terminal:

```bash
khipu setup-claude
```

This verifies the server starts correctly, then writes the config entry automatically.

**Then restart Claude Desktop:** Claude => Quit Claude, then reopen it.

> Claude Desktop spawns the MCP server itself - you never need to run `khipu mcp` manually.

### 3. Test it

Ask Claude:

> "Use KhipuChat to find my chat with Tony Lin and show me the last 20 messages"

### 4. Install the sync daemon (macOS)

```bash
khipu setup-sync
```

This writes a launchd plist to `~/Library/LaunchAgents/`, starts the daemon immediately, and configures it to start automatically at login. Run it again any time you upgrade Node - it regenerates the plist with the current binary path.

```bash
# Check it's running
launchctl list | grep khipuchat

# Watch logs
tail -f ~/Library/Logs/khipuchat-sync.log
```

## Daily workflow

Nothing to do - the sync daemon runs in the background and starts at login. Claude Desktop handles the rest.

If you run `khipu setup-claude` or `khipu setup-sync` again (e.g. after a Node upgrade), restart Claude Desktop afterwards.

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
| `get_image(message_id)` | Retrieve a stored image as base64 content, with file path and OCR text if available |

### `get_image` response shape

| Field | Type | Description |
|---|---|---|
| `message_id` | `number` | The message ID queried |
| `type` | `"image"` | Always `"image"` |
| `file_available` | `boolean` | `true` if the image file was read from disk; `false` if it is missing or not recorded |
| `file_path` | `string \| null` | Absolute path where the image is stored (or was expected) |
| `content_base64` | `string` | Base64-encoded image bytes (only present when `file_available: true`) |
| `ocr_text` | `string \| null` | OCR-extracted text from the image, if available |
| `ocr_available` | `boolean` | `true` when `ocr_text` is non-null |
| `error` | `string` | Human-readable reason why the file is unavailable (only present when `file_available: false`) |

## CLI tools

Run any MCP tool from the terminal with `npm run cli <tool> [args]`.

```bash
npm run cli get_image <message_id>
```

Prints:
- `file_path`: where the image is stored on disk
- `file_available`: `true` or `false`
- `ocr_text`: OCR-extracted text, or `(none)` if not available
- `content_base64`: shown as a byte-count summary (the full blob is not printed)

When `file_available` is `false`, the `error` field and any retained `ocr_text` are printed instead.

On a non-image message ID, or when the message is not found, the CLI exits non-zero with an error message. On a missing or non-numeric argument, usage is printed and the CLI exits non-zero.

## Multi-account configuration

By default, KhipuChat reads credentials from environment variables. For multiple accounts on the same platform, create a `khipu.config.json` file in the project root:

```json
{
  "accounts": {
    "telegram": [
      { "account": "personal", "apiId": "...", "apiHash": "...", "session": "..." }
    ],
    "slack": [
      { "account": "work", "userToken": "SLACK_USER_TOKEN_WORK" },
      { "account": "personal", "userToken": "SLACK_USER_TOKEN_PERSONAL" }
    ]
  }
}
```

When `khipu.config.json` is absent, the single-account env-var resolution is used as a fallback.

**Platform notes:**

- WeChat is limited to one account.
- iMessage reads the local `chat.db` and always performs a full scan (cannot filter server-side). All other platforms sync incrementally using `sync_state` tracking.

## Contributing

### Local development setup

```bash
git clone https://github.com/your-username/khipuchat.git
cd khipuchat
npm install
npm link
# khipu is now available on PATH
khipu setup-claude
```

After `npm link`, the `khipu` binary resolves directly from your local clone, so changes you make take effect immediately without reinstalling.

## Database

Messages are stored in `./khipuchat.db` (SQLite). Inspect with:

```bash
sqlite3 khipuchat.db "SELECT name, message_count, datetime(last_synced_at, 'unixepoch', 'localtime') FROM chats ORDER BY message_count DESC"
```
