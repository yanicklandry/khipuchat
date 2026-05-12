# Brief: semantic-search

## Problem
KhipuChat users archive hundreds of thousands of messages across platforms, but retrieval
is limited to exact keyword search. When a user needs to rediscover contacts or
conversations by meaning — "find people I knew in Shanghai around 2019", "who did I talk
to about finding an apartment?" — keyword search fails because the exact words may not
appear, and loading all messages into an LLM context window is prohibitively expensive.

## Current State
- `searchMessages(query, chatId?, platform?)` does SQLite FTS5 full-text search (keyword only)
- MCP tools: `list_chats`, `find_chat_by_name`, `list_messages`, `search_messages`, `get_chat_summary`
- No time-range filter on chat/contact listing
- No semantic similarity search
- DB: ~960K messages, 2,044 chats (Telegram); more platforms incoming

## Desired Outcome
- A one-time (then incremental) embedding pipeline indexes all messages/chats locally
- New MCP tools let Claude find contacts and conversations by semantic meaning without
  loading all messages into context
- Two query modes: (1) contact discovery — "who did I know in Shanghai ca. 2019?" returns
  a ranked list of contacts with metadata; (2) message search — "find conversations about
  career decisions" returns ranked message snippets
- All computation stays on-device; no external API calls for embeddings

## Approach
**Local ONNX embeddings + sqlite-vec vector store**

- Embedding model: `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` v4
  (384-dim float32, ~90MB download, Apache-2.0, M4-native ONNX binaries)
- Vector store: `sqlite-vec` (Apache-2.0, `darwin-arm64` prebuilts, loads into
  existing `better-sqlite3` DB via `db.loadExtension()`)
- Two embedding granularities:
  - **Chat-level** (~3 MB for 2K chats): name + last 5 message snippets → one vector per chat
  - **Message-level** (~1.5 GB for 1M messages): individual message text → one vector per message
- Incremental: new messages embedded during or after each platform sync
- CLI: `npm run index:embeddings` for initial full indexing

## Scope
- **In**:
  - `src/embeddings.ts` — model loading, embed(), batch pipeline, incremental sync
  - `src/db.ts` additions — sqlite-vec extension load, vector upsert/query functions
  - New MCP tools: `semantic_find_contacts`, `semantic_search_messages`
  - `npm run index:embeddings` CLI entry point
  - Tests for embedding pipeline and MCP tools
- **Out**:
  - Web UI integration (that's the web-ui spec's domain)
  - Sending or drafting messages
  - Cross-platform deduplication
  - Automatic re-embedding when messages are edited (not supported by source platforms)

## Boundary Candidates
- **Embedding layer** (`src/embeddings.ts`): model lifecycle, batching, vector output — no DB knowledge
- **DB vector layer** (`src/db.ts` additions): sqlite-vec schema, upsert, cosine-similarity query — no model knowledge
- **MCP tool layer** (`src/mcp.ts` additions): translate natural-language queries into embedding calls + DB queries

## Out of Boundary
- Web UI search bar (web-ui spec owns that UI surface)
- Platform-specific metadata parsing (each platform spec owns that)
- Message generation or reply drafting

## Upstream / Downstream
- **Upstream**: `platform-abstraction` (stable schema: `messages.body`, `chats.name`, `messages.timestamp`)
- **Downstream**: `web-ui` spec can wire up semantic search to the browser UI in a later phase

## Existing Spec Touchpoints
- **Extends**: `src/db.ts` (adds sqlite-vec load + vector tables), `src/mcp.ts` (adds 2 new tools)
- **Adjacent**: `web-ui` (shares DB read path; don't touch Express routes)

## Constraints
- Self-hosted only — model weights downloaded once to `~/.cache/huggingface/`, no runtime API calls
- All DB operations remain synchronous (better-sqlite3 pattern); embedding inference is async
  (wrap in a thin async shell, batch before writing)
- Keep each source file under 200 lines (project rule) — split embeddings.ts if needed
- `sqlite-vec` loaded via `db.loadExtension()` before any vector queries
- Initial index: ~3–8 min for 1M messages on M4 (acceptable one-time cost)
- Disk budget: chat-level ~3 MB, message-level ~1.5 GB — both fit within user's 11 GB free space
- Pin `@huggingface/transformers` to v4.x and `onnxruntime-node` to >=1.24.1 (CVE fix)
