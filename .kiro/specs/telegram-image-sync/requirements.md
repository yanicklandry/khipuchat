# Requirements Document

## Project Description (Input)
Telegram photo messages are detected but never downloaded or stored, making image content invisible to search, semantic search, and MCP tools. The existing media columns (`media_file_path`, `media_url`, `media_width`, `media_height`) and GramJS `client.downloadMedia()` are already in place. The goal is to download Telegram images to local storage, OCR them with `tesseract.js`, feed the extracted text into FTS and the semantic embedding pipeline, and expose a new `get_image` MCP tool. The storage helper, OCR module, and MCP tool are designed platform-agnostically so Signal, WeChat, and other platforms can reuse them.

## Introduction

Telegram photo messages are currently detected during sync but never downloaded or stored. This leaves all image content invisible to full-text search, semantic search, and MCP tools. This feature adds local media download for Telegram image messages, an OCR pipeline to extract text from downloaded images, integration of OCR text into the existing search and semantic embedding indexes, and a new `get_image` MCP tool for retrieving image files and their extracted text. The storage helper, OCR pipeline, and `get_image` tool are designed platform-agnostically so that Signal, WeChat, and other future platform specs can reuse them.

## Boundary Context

- **In scope**: Download and local storage of Telegram photo messages across backfill, incremental sync, and live listener; a platform-agnostic media storage convention; a platform-agnostic OCR pipeline; integration of OCR text into full-text search and semantic embedding indexes; a `get_image` MCP tool; an `ocr_text` schema migration; git and Docker configuration for the media directory.
- **Out of scope**: Image sync for any other platform (Signal, iMessage, WhatsApp, WeChat download phase, Discord, Slack, email); video, voice note, and sticker handling; image editing, compression, or format conversion; CLI and Web UI surfaces for `get_image` (may follow separately per agent-native parity).
- **Adjacent expectations**: The existing `media_file_path`, `media_url`, `media_width`, and `media_height` columns (added by wechat-image-sync) are reused without schema conflict. The full-text search and embedding indexes currently consume only message `text`; this feature extends them to also consume `ocr_text`. Signal and WeChat download-phase specs are downstream consumers of the shared storage helper, OCR module, and `get_image` tool built here and do not own those components.

## Requirements

### Requirement 1: Telegram Image Download

**Objective:** As a KhipuChat operator, I want Telegram photo messages downloaded and saved locally during sync, so that image content is persistently stored and available for OCR and retrieval.

#### Acceptance Criteria

1. When a Telegram message is classified as an image during backfill sync, the Sync Service shall download the photo and save it to local storage.
2. When a Telegram message is classified as an image during incremental sync, the Sync Service shall download the photo and save it to local storage.
3. When a Telegram image message is received by the live listener, the Sync Service shall download the photo and save it to local storage.
4. While a Telegram image message already has a recorded local file path, the Sync Service shall skip downloading that image on subsequent sync runs.
5. If a Telegram image download fails, the Sync Service shall log the error, leave `media_file_path` unset for that message, and continue processing remaining messages without interrupting the sync run.
6. When a Telegram image is successfully downloaded, the Sync Service shall record the local file path in `media_file_path` and populate `media_width` and `media_height` where those attributes are available from the photo data.

### Requirement 2: Platform-Agnostic Media Storage

**Objective:** As a KhipuChat operator, I want downloaded media files stored using a consistent, platform-agnostic path convention, so that the same convention can be reused by Signal, WeChat, and other future platform image specs.

#### Acceptance Criteria

1. The Sync Service shall store each downloaded image at a path derived from the platform name, the chat identifier, and the message external ID.
2. The Sync Service shall create any required parent directories before writing a media file, if they do not already exist.
3. The local media directory shall be excluded from version control so that downloaded images are not committed to the repository.
4. The local media directory shall be configured as a persistent volume in the Docker environment so that downloaded images survive container restarts.

### Requirement 3: OCR Text Extraction

**Objective:** As a KhipuChat operator, I want text extracted from downloaded images via OCR, so that image content becomes searchable alongside text messages.

#### Acceptance Criteria

1. When a Telegram image has been downloaded to local storage, the Sync Service shall attempt OCR on the image and store the extracted text in the `ocr_text` field of the corresponding message.
2. If OCR extraction fails for any image, the Sync Service shall leave `ocr_text` null for that message and continue syncing without interrupting the sync run.
3. The `messages` schema shall include a nullable `ocr_text` column, added via a migration that leaves all existing rows and their data unaffected.
4. While a message already has a non-null `ocr_text` value, the Sync Service shall not re-run OCR on that message's image.
5. The OCR module shall operate without Telegram-specific coupling so that other platform adapters can invoke it for their own image messages.

### Requirement 4: Full-Text Search Integration

**Objective:** As a KhipuChat user, I want OCR text from image messages included in full-text search, so that I can find messages by text visible in their photos.

#### Acceptance Criteria

1. When OCR text is stored for an image message, the Search Service shall index that OCR text in the full-text search index so it is discoverable via `search_messages`.
2. When a user queries `search_messages` with a term that matches OCR text in an image message, the Search Service shall return that message in results.
3. The Search Service shall index OCR text for image messages regardless of whether the message also contains a `text` field, so that image-only messages are not excluded from search results.

### Requirement 5: Semantic Search Integration

**Objective:** As a Claude agent or KhipuChat user, I want OCR text from image messages included in semantic search, so that image messages are discoverable through natural-language queries.

#### Acceptance Criteria

1. When OCR text is first available for an image message, the Embedding Service shall generate a semantic embedding for that message and store it for semantic search.
2. When a user issues a `semantic_search_messages` query whose intent matches OCR content in an image message, the Embedding Service shall return that image message in results.
3. When a message has both a `text` field and an `ocr_text` field, the Embedding Service shall produce an embedding that reflects both, so neither source of content is excluded from semantic search.
4. While a message already has a stored embedding that incorporates its OCR text, the Embedding Service shall not regenerate the embedding on subsequent sync runs.

### Requirement 6: get_image MCP Tool

**Objective:** As a Claude agent or MCP client, I want to retrieve the content and OCR text of a stored image message, so that I can inspect or analyze the image without direct filesystem access.

#### Acceptance Criteria

1. The KhipuChat MCP Server shall expose a `get_image` tool that accepts a message ID and returns the image file path, base64-encoded image content, and `ocr_text` for the specified message.
2. When `get_image` is called for a message that has a stored local image file, the MCP Server shall return the base64-encoded content of that image.
3. If `get_image` is called for a message that has no stored local image file, the MCP Server shall return an error indicating the image is not available.
4. When `get_image` is called for a message with a null `ocr_text`, the MCP Server shall still return the image content and include an indication that OCR text is not available.
5. The `get_image` tool shall be documented in the project README alongside the other MCP tools.

### Requirement 7: Operational Reliability

**Objective:** As a KhipuChat operator, I want image download and OCR to be best-effort and non-disruptive, so that Telegram sync continues to work correctly even when media or OCR operations encounter errors.

#### Acceptance Criteria

1. The Sync Service shall not send image download requests at a rate that causes Telegram API rate-limit errors or disrupts normal text message sync.
2. If any individual image download or OCR operation fails during a sync run, the Sync Service shall continue processing remaining messages in that same run.
3. The Sync Service shall not modify existing message `text` content, existing embeddings, or other message fields as a side effect of the image download or OCR pipeline.
4. When the `ocr_text` migration runs on an existing populated database, the migration shall complete without data loss and leave all existing rows unchanged.
