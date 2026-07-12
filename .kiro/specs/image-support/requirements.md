# Requirements Document

## Introduction

KhipuChat currently archives text messages across platforms but drops image messages almost entirely. Image content — screenshots, photos, and documents shared as images — is invisible to search, semantic search, and MCP tools. This feature makes image messages first-class: images are downloaded to local storage, OCR'd, and made searchable through the same `search_messages` and `semantic_search_messages` tools as text messages, plus a new `get_image` retrieval tool.

Wave 1 delivers working image sync for Telegram, shared infrastructure (media storage, OCR, retrieval) reusable by all platforms, and search integration for image-derived text. Signal and all other platforms are explicitly out of scope for this wave's implementation.

**Who has the problem**: KhipuChat operators who rely on message archives for search and retrieval of image-bearing conversations, primarily on Telegram (wave 1).

**Current gap**: Telegram's adapter detects photo messages but never downloads them. No OCR exists. No MCP tool returns image content or a local file path. The `messages` table has media columns (`media_file_path`, `media_url`, `media_width`, `media_height`) but they are unused for actual local storage.

## Boundary Context

- **In scope**: Shared local media storage convention; `ocr_text` indexing (full-text and semantic); `get_image` MCP and CLI tool; Telegram image sync (backfill, incremental, live listener); idempotent re-sync behavior; schema migration for pre-existing databases; Docker and git exclusion of the media directory.
- **Out of scope**: Full Signal, iMessage, WhatsApp, Discord, Slack, or email image sync implementation; video, voice note, or sticker handling; image editing, compression, or format conversion; any changes to Beeper Desktop's own configuration or behavior.
- **Adjacent expectations**: This feature assumes the `multi-account` spec lands concurrently or prior — images must be stored in a way that avoids cross-account path collisions. This feature feeds `ocr_text` into the embedding pipeline established by `semantic-search`; no changes to the embedding pipeline itself are in scope. Signal ingestion research findings are expected to be documented in this feature's design artifact; implementation is deferred to a follow-on spec.

## Requirements

### 1. Local Media Storage Convention

**Objective:** As a KhipuChat operator, I want downloaded images stored in a predictable, stable local path, so that I can locate, back up, or inspect image files independently of the database.

#### Acceptance Criteria

1. When an image is downloaded from any platform, KhipuChat shall store the file at a path derived from the platform name, chat identifier, and message identifier, within a configurable media root directory.
2. When a `MEDIA_DIR` environment variable is set, KhipuChat shall use that path as the media storage root; when unset, KhipuChat shall use a default subdirectory within the application data directory.
3. When an image message is synced and the message record already has a non-null `media_file_path` pointing to an existing file on disk, KhipuChat shall skip the download entirely.
4. The KhipuChat media directory shall be excluded from git tracking and Docker build context, and shall be declared as a persistent volume in the Docker Compose configuration.
5. When KhipuChat opens an existing database that predates this feature, KhipuChat shall migrate the schema to support OCR text storage without data loss.

### 2. OCR Text Extraction

**Objective:** As a KhipuChat operator, I want text visible in images extracted automatically on download, so that image content is discoverable through search without manual transcription.

#### Acceptance Criteria

1. When an image file is stored locally, KhipuChat shall attempt to extract visible text and, if successful, write the result to the `ocr_text` field of the corresponding message record.
2. If OCR fails for any reason on a given message, KhipuChat shall log the failure and continue processing remaining messages without aborting the sync run.
3. When `ocr_text` is written to a message record, KhipuChat shall include it in the full-text search index alongside existing message text.
4. When `ocr_text` is written to a message record, KhipuChat shall generate a semantic embedding from the combined message text and OCR text (or from `ocr_text` alone when `text` is null) and store it in the semantic similarity index.
5. While image width and height metadata are available from the platform without an additional network request, KhipuChat shall populate `media_width` and `media_height` on the message record.

### 3. Image Retrieval Tool

**Objective:** As a KhipuChat operator querying through Claude (MCP) or the CLI, I want to retrieve the content and extracted text of an archived image, so that I can view images and reason about their content.

#### Acceptance Criteria

1. The KhipuChat MCP server shall expose a `get_image` tool that accepts a message ID and returns the image's local file path, base64-encoded file content, and `ocr_text`.
2. When `get_image` is called for a message whose local file does not exist on disk, KhipuChat shall return an informative error identifying the message ID and stating the file is unavailable.
3. When `get_image` is called for a message that has `ocr_text` but no accessible local file, KhipuChat shall include `ocr_text` in the response alongside the unavailability indication.
4. When `get_image` is called for a message that is not of type `'image'`, KhipuChat shall return an error indicating the message type is not supported by this tool.
5. The `get_image` capability shall be accessible through the CLI query surface in addition to MCP, so that operators can retrieve image content and OCR text from scripts.
6. The `get_image` tool, its parameters, and its response fields shall be documented in the project README.

### 4. Image Search Integration

**Objective:** As a KhipuChat operator, I want image messages identified by their OCR-extracted text to appear in search results, so that I can find conversations containing images with specific visible content.

#### Acceptance Criteria

1. When `search_messages` is called with a query that matches a message's `ocr_text`, KhipuChat shall include that image message in the results.
2. When `semantic_search_messages` is called, KhipuChat shall rank image messages whose OCR-derived embeddings match the query among the results, with no filtering that excludes image messages by default.
3. When a search result corresponds to a message of type `'image'`, KhipuChat shall include the message type in the result so callers can distinguish image messages from text messages.
4. When `search_messages` is called with a `type: 'image'` filter, KhipuChat shall return only messages of that type.

### 5. Telegram Image Sync

**Objective:** As a KhipuChat operator with a Telegram account configured, I want image messages downloaded and indexed during every sync mode, so that my Telegram image archive is complete and searchable from the first sync.

#### Acceptance Criteria

1. When Telegram full backfill encounters a message whose type is `'image'`, KhipuChat shall download the photo and store it using the shared media storage convention.
2. When Telegram incremental sync encounters a new message whose type is `'image'`, KhipuChat shall download and store the photo using the shared media storage convention.
3. When the Telegram live listener receives a new event containing a photo, KhipuChat shall download and store the photo using the shared media storage convention.
4. When a Telegram image download fails for an individual message, KhipuChat shall log the error and continue processing the remaining messages in the batch without aborting the sync run.
5. When Telegram image sync is run for a configured account and other accounts are also configured on the same platform, KhipuChat shall store each account's images in paths that do not collide with files from other accounts.
