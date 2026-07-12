# Requirements Document

## Project Description (Input)
Signal is the operator's primary messaging platform and is not archived by KhipuChat at all. Signal Desktop's local SQLite store is encrypted with a key held in the OS keychain, making direct local-DB reverse-engineering meaningfully harder and more fragile than the Telegram/iMessage local-DB approach.

The operator already runs Beeper Desktop, which bridges Signal (and WhatsApp, Telegram, iMessage, etc.) behind one MCP connector, exposing tools including `search_messages`, `list_messages`, `search_chats`, and `send_message`. Signal messages and image attachment references have been successfully retrieved via Beeper's `search_messages`.

The goal is to make Signal a KhipuChat platform: chats and text messages sync into `chats` / `messages` the same way Telegram or iMessage do, queryable via the existing `list_chats`, `find_chat_by_name`, `list_messages`, `search_messages`, `get_chat_summary` MCP tools without those tools needing Signal-specific changes. Ingestion is via Beeper Desktop's own MCP connector rather than reverse-engineering Signal Desktop's encrypted local database.

This requires calling another MCP server's tools from within KhipuChat's own sync code, which is architecturally new for this codebase -- every existing adapter talks to a local DB or a first-party API/library directly, not to another MCP server. The design phase must establish how that connection is made.

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
