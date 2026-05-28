# Requirements Document

## Introduction
KhipuChat users archive hundreds of thousands of messages across multiple platforms. Existing retrieval is limited to keyword (FTS) search, which fails for meaning-based queries — "who did I know in Shanghai around 2019?" or "find conversations about career decisions." This feature adds semantic search: a local embedding index that enables Claude to discover relevant contacts and messages by meaning, without loading all messages into context and without sending any data to external services.

## Boundary Context
- **In scope**: Embedding indexing pipeline (initial + incremental), two new MCP tools (`semantic_find_contacts`, `semantic_search_messages`), CLI command for initial indexing
- **Out of scope**: Web UI integration (web-ui spec owns that surface), changes to existing keyword/FTS search, message sending or drafting, cross-platform deduplication
- **Adjacent expectations**: Relies on `messages` and `chats` tables remaining stable (platform-abstraction spec owns the schema). The web-ui spec may later surface these MCP tools in a browser UI — this spec does not own that surface.

## Requirements

### Requirement 1: Initial Embedding Indexing
**Objective:** As a KhipuChat operator, I want to run a one-time command that embeds all existing messages and chats locally, so that semantic search is available over the full archive.

#### Acceptance Criteria
1. When the operator runs `npm run index:embeddings`, the system shall embed all messages currently in the database and store their vector representations on local disk.
2. When the operator runs `npm run index:embeddings`, the system shall embed all chats using each chat's name and a sample of recent message text, and store those vector representations on local disk.
3. When `npm run index:embeddings` completes, the system shall report the total number of messages and chats successfully indexed.
4. If `npm run index:embeddings` is run on a database that already has embeddings, the system shall only embed records added or modified since the last indexing run (incremental update), skipping already-indexed records.
5. The system shall not transmit any message text, metadata, or identifiers to external network services at any point during the indexing process.
6. While indexing is in progress, the system shall log periodic progress at least every 1,000 messages so the operator can monitor the run.

### Requirement 2: Incremental Embedding on Sync
**Objective:** As a KhipuChat operator, I want newly synced messages to be embedded automatically after each platform sync, so that semantic search stays current without requiring a full re-index.

#### Acceptance Criteria
1. When a platform sync run inserts new messages, the system shall embed those messages and store their vector representations before the sync run exits.
2. When a platform sync run inserts messages for a chat, the system shall update the chat-level embedding to reflect the updated content.
3. If embedding fails for an individual message during a sync run, the system shall log the failure and continue processing remaining messages without aborting the sync.

### Requirement 3: Semantic Contact Discovery MCP Tool
**Objective:** As a Claude user, I want to query "find contacts from around 2019 in Shanghai" and receive a ranked list of matching contacts, so that I can rediscover people to reach out to without loading all messages into context.

#### Acceptance Criteria
1. When Claude invokes `semantic_find_contacts` with a natural-language query string, the system shall return a ranked list of matching chats ordered by semantic relevance to the query.
2. When `semantic_find_contacts` returns results, each result shall include: chat name, platform, last message date, total message count, and a short text snippet from a recent message in that chat.
3. When `semantic_find_contacts` is invoked with an optional `limit` parameter, the system shall return at most that many results; if omitted the default shall be 10 and the maximum shall be 50.
4. When `semantic_find_contacts` is invoked with an optional `before` date parameter, the system shall restrict results to chats whose last message predates that date.
5. When `semantic_find_contacts` is invoked with an optional `after` date parameter, the system shall restrict results to chats whose last message falls after that date.
6. When `semantic_find_contacts` is invoked with an optional `platform` parameter, the system shall restrict results to chats on that platform.
7. If the embedding index has not been built when `semantic_find_contacts` is invoked, the system shall return a descriptive error message instructing the operator to run `npm run index:embeddings`.
8. If no chats meet the minimum similarity threshold for the query, the system shall return an empty list rather than low-relevance results.

### Requirement 4: Semantic Message Search MCP Tool
**Objective:** As a Claude user, I want to search for messages by meaning rather than exact keyword, so that I can find relevant conversations even when I do not recall the specific words used.

#### Acceptance Criteria
1. When Claude invokes `semantic_search_messages` with a natural-language query string, the system shall return a ranked list of message snippets ordered by semantic relevance to the query.
2. When `semantic_search_messages` returns results, each result shall include: chat name, sender name, message text, timestamp, and platform.
3. When `semantic_search_messages` is invoked with an optional `chat_id` parameter, the system shall restrict results to messages in that chat.
4. When `semantic_search_messages` is invoked with an optional `platform` parameter, the system shall restrict results to messages on that platform.
5. When `semantic_search_messages` is invoked with an optional `limit` parameter, the system shall return at most that many results; if omitted the default shall be 20 and the maximum shall be 100.
6. When `semantic_search_messages` is invoked with an optional `before_timestamp` parameter, the system shall restrict results to messages whose timestamp precedes that value.
7. When `semantic_search_messages` is invoked with an optional `after_timestamp` parameter, the system shall restrict results to messages whose timestamp follows that value.
8. If the embedding index has not been built when `semantic_search_messages` is invoked, the system shall return a descriptive error message instructing the operator to run `npm run index:embeddings`.

### Requirement 5: Performance and Resource Constraints
**Objective:** As a KhipuChat operator, I want semantic search to be usable on a personal laptop without degrading normal system performance or consuming excessive disk space.

#### Acceptance Criteria
1. When `semantic_find_contacts` or `semantic_search_messages` is invoked on an indexed database of up to 1 million messages, the system shall return results within 2 seconds.
2. The system shall store all embedding index data on local disk consuming no more than 2 GB per 1 million indexed messages.
3. While `npm run index:embeddings` is running, the system shall not prevent the MCP server or platform sync processes from operating concurrently.
4. The system shall download the embedding model at most once, caching it in a local directory, and shall not re-download the model on subsequent runs when the cache is present and valid.
5. If the local model cache is absent or corrupt, the system shall automatically re-download the model and log that the download occurred.
