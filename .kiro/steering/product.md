# Product Overview

KhipuChat is a self-hosted multi-platform message archive. It syncs conversations from Telegram, iMessage, Discord, Slack, WhatsApp, Signal, and email into a local SQLite database, then lets you browse them in a web UI or query them with Claude via MCP.

## Core Capabilities

- **Platform sync**: Pull message history from multiple platforms into one local database using per-platform adapters
- **MCP server**: Expose the archive to Claude for natural-language queries — chat lookup, message listing, full-text search, semantic search
- **CLI**: Scriptable access to the same query and sync capabilities as MCP; useful for debugging and automation
- **Web UI**: Browser-based interface for browsing chats, reading threads, and searching messages
- **Semantic search**: ONNX-powered local embeddings (all-MiniLM-L6-v2) + sqlite-vec for similarity search without any external API

## Target Use Cases

- "Find my conversation with X and summarize it" — queried through Claude using MCP
- Browsing archived messages across platforms in a single UI
- Scripted automation: filter messages by date range, platform, sender from the terminal
- Incremental sync + background daemon so the archive stays current automatically

## Value Proposition

Everything stays local. No cloud service, no data leaving the machine. Claude queries the archive through MCP; the archive itself is a plain SQLite file the user owns.

## Usage Surfaces (priority order)

1. **MCP (primary)**: LLM queries — reference implementation for all filtering and search capabilities
2. **CLI (secondary)**: Debugging and scripted automation — must match MCP filter parity
3. **Web (secondary)**: Manual browsing and visual inspection

Whatever the archive can answer through one surface should be answerable through the others (agent-native parity).
