# Requirements Document

## Introduction
This document outlines the requirements for enhancing image message handling in the WeChat sync functionality. The goal is to ensure all image-related messages from WeChat are properly detected and synced as image-type messages with appropriate metadata, across all WeChat database schema versions.

## Boundary Context (Optional)
- **In scope**:
  - Image message type detection for all relevant WeChat message types (Type 4, Type 43, Type 49, local_type 4)
  - Metadata extraction from image messages (file paths, URLs, dimensions) when present in message data
  - Consistent image handling across legacy, WeChat, and V4 database schemas
- **Out of scope**:
  - Image file storage, download, or retrieval
  - Image processing, compression, or format conversion
  - Changes to downstream query surfaces (MCP, CLI, Web)
- **Adjacent expectations**:
  - Downstream query surfaces (MCP, CLI, Web) receive enriched image message records without any interface changes on their side
  - WeChat database access and message parsing behavior remain unchanged
  - Non-image message handling is not affected

## Requirements

### Requirement 1: Image Message Type Detection

**Objective:** As a user, I want all image-related WeChat messages to be recognized as image-type messages during sync, so that my complete image message history appears in the archive.

#### Acceptance Criteria
1. When the WeChat Sync encounters a message with Type 4 in the legacy schema, it shall classify it as an image-type message.
2. When the WeChat Sync encounters a message with Type 43, it shall classify it as an image-type message.
3. When the WeChat Sync encounters a message with Type 49, it shall classify it as an image-type message.
4. When the WeChat Sync encounters a message with local_type 4 in the V4 schema, it shall classify it as an image-type message.

### Requirement 2: Image Metadata Extraction

**Objective:** As a user, I want image messages in the archive to include available metadata, so that I can access file paths, URLs, and dimensions when querying image messages through MCP, CLI, or Web.

#### Acceptance Criteria
1. When an image message contains a file path in its message data, the WeChat Sync shall include that file path in the synced message record.
2. When an image message contains a URL in its message data, the WeChat Sync shall include that URL in the synced message record.
3. When an image message contains dimension data in its message data, the WeChat Sync shall include width and height values in the synced message record.
4. If image metadata fields are absent from the message data, the WeChat Sync shall still sync the message as an image-type without failing.

### Requirement 3: Cross-Schema Compatibility

**Objective:** As a user, I want image messages from all WeChat schema versions to be handled consistently, so that my complete image message history is preserved regardless of which WeChat database version is present.

#### Acceptance Criteria
1. When the WeChat Sync processes messages from the legacy schema, it shall detect and classify all image message types defined in Requirement 1 correctly.
2. When the WeChat Sync processes messages from the V4 schema, it shall detect and classify all image message types defined in Requirement 1 correctly.
3. The WeChat Sync shall produce image-type message records with consistent structure regardless of which schema version the source database uses.

### Requirement 4: Backward Compatibility

**Objective:** As a user, I want the enhanced image handling to not affect existing non-image message sync behavior, so that my existing archived messages remain correct and complete.

#### Acceptance Criteria
1. When the WeChat Sync processes non-image messages, it shall continue to classify and represent them identically to pre-enhancement behavior.
2. The WeChat Sync shall continue to process and sync all previously supported non-image message types without modification.
3. If the WeChat Sync encounters an unrecognized message type, it shall treat it as a non-image message rather than failing or skipping it.
