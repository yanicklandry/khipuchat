# Requirements Document

## Project Description (Input)
Signal image messages need the same download, OCR, and search treatment that Telegram images receive. The `signal-platform` adapter syncs text/chat data via Beeper Desktop; images referenced in those messages must now be fetched (via Beeper MCP or a local filesystem fallback), stored using the shared local media helper from `telegram-image-sync`, OCR'd with the same pipeline, and made searchable. The `get_image` MCP tool built in `telegram-image-sync` must work for Signal images without modification if the storage convention is followed. Attachment fetching from Beeper is an open gap that must be resolved (or worked around) as part of this spec. Failures must be best-effort: a failed image fetch or OCR must not break the overall sync run.

## Introduction

Signal Image Sync extends the Signal platform adapter to download, store, OCR-extract, and index image attachments from Signal messages. It reuses the shared media infrastructure established by the Telegram image sync so the `get_image` MCP tool works for Signal images without modification.

## Boundary Context

- **In scope:** Detection of image messages in Signal chat history; fetching image attachment data (via Beeper Desktop or a local filesystem fallback); storing images using the shared media path convention; extracting text via OCR; persisting results with the message record; making images retrievable through the existing `get_image` MCP tool; making OCR text discoverable via full-text search and semantic search.
- **Out of scope:** Non-image Signal attachments (video, audio, file, voice); schema changes to the messages table; changes to the `get_image` MCP tool or image retrieval handler; changes to the full-text search or semantic search pipelines.
- **Adjacent expectations:** Depends on the `signal-platform` adapter having already inserted message records with their external IDs before image sync runs. Depends on Beeper Desktop being accessible at runtime for attachment fetching. Does not own the Beeper Desktop connection, Signal account credentials, or shared media infrastructure (`media-storage`, `ocr`).

## Requirements

### Requirement 1: Image Message Detection

**Objective:** As a KhipuChat operator, I want Signal image messages to be identified during sync, so that only image attachments are processed for download and OCR.

#### Acceptance Criteria

1. When Signal messages are synced (backfill or incremental), the Signal Image Sync shall identify messages whose type indicates an image attachment.
2. The Signal Image Sync shall skip messages that do not carry an image type, leaving their media fields unchanged.
3. When a Signal image message already has a stored file location recorded, the Signal Image Sync shall skip re-downloading it.

---

### Requirement 2: Image Attachment Fetching

**Objective:** As a KhipuChat operator, I want image attachment data to be retrieved from Signal messages, so that images can be stored locally for later retrieval and OCR.

#### Acceptance Criteria

1. When a Signal image message is identified, the Signal Image Sync shall attempt to fetch the attachment binary data via Beeper Desktop.
2. If fetching via Beeper Desktop fails or is unavailable, the Signal Image Sync shall attempt to read the image from a local filesystem fallback location.
3. If both fetch strategies fail for a message, the Signal Image Sync shall record the failure and continue processing remaining image messages without aborting the sync run.
4. The Signal Image Sync shall not require modification to the existing Beeper Desktop connection or Signal account credential configuration.

---

### Requirement 3: Image Storage

**Objective:** As a KhipuChat operator, I want fetched Signal images to be stored on disk using a consistent path convention, so that the existing `get_image` MCP tool can retrieve them without modification.

#### Acceptance Criteria

1. When an image attachment is successfully fetched, the Signal Image Sync shall store it on disk using the same path convention used by other platforms.
2. The Signal Image Sync shall record the stored file location with the corresponding message record so it can be retrieved later.
3. If the target file already exists on disk, the Signal Image Sync shall not re-download or overwrite it.

---

### Requirement 4: OCR Text Extraction

**Objective:** As a KhipuChat operator, I want text visible in Signal images to be extracted via OCR, so that image content becomes searchable through the archive.

#### Acceptance Criteria

1. When an image file has been stored, the Signal Image Sync shall run OCR to extract any visible text from it.
2. When OCR succeeds, the Signal Image Sync shall persist the extracted text alongside the message record.
3. If OCR fails for any image, the Signal Image Sync shall leave that message's OCR text empty and continue processing.
4. When a message already has OCR text stored, the Signal Image Sync shall skip OCR for that message.

---

### Requirement 5: Searchability via Existing Surfaces

**Objective:** As a KhipuChat user, I want OCR text from Signal images to be searchable through the same interfaces as message text, so that image content is discoverable alongside regular messages.

#### Acceptance Criteria

1. When Signal image OCR text is stored, the Signal Image Sync shall ensure the message is included in full-text search results when queried by that OCR text.
2. When Signal image OCR text is stored, the Signal Image Sync shall ensure the image is retrievable via the `get_image` MCP tool using the message ID.
3. The Signal Image Sync shall not require changes to the `get_image` MCP tool, the full-text search index, or the semantic search index to achieve searchability.

---

### Requirement 6: Sync Resilience

**Objective:** As a KhipuChat operator, I want image sync failures to be non-fatal, so that a failed image download does not interrupt the overall Signal sync or cause message data loss.

#### Acceptance Criteria

1. If image fetching fails for any individual message, the Signal Image Sync shall log the failure and continue processing remaining messages in the same sync run.
2. If OCR fails for any individual message, the Signal Image Sync shall log the failure and continue processing remaining messages.
3. The Signal Image Sync shall not roll back or discard already-synced text message data when an image operation fails.
4. When a Signal sync run completes, the Signal Image Sync shall report the number of images successfully stored and the number that could not be fetched.
