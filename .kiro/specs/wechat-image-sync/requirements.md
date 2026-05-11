# Requirements Document

## Problem
WeChat users are unable to view image content in their conversation history when syncing with Khipu chat platform. The current WeChat adapter only supports text message synchronization, missing a critical subset of user data.

## Current State
- Existing WeChat platform adapter handles text messages (Type=1) and maps them to 'text' type
- All other message types including images are mapped to 'other' type
- No image detection or processing logic exists in the sync pipeline
- Image content is present in WeChat databases but not exposed through Khipu

## Desired Outcome
- Users can view image messages from their WeChat conversations within Khipu
- Image content is properly identified, extracted, and mapped to generic 'image' type
- Both legacy 3.x and modern 4.x WeChat database schemas are supported
- Existing functionality for text and other message types remains intact

## Approach
Extend the existing WeChat adapter's `mapMessage()` function to detect image-type messages based on WeChat-specific message type codes and extract relevant metadata for downstream systems. The implementation will:
1. Add image message type detection logic for both 3.x and 4.x schemas
2. Extract file paths from message content fields for external media handling
3. Map detected images to generic 'image' message type in the database schema
4. Maintain compatibility with existing text and non-image message processing

## Scope
- **In**: 
  - Image message detection in WeChat 3.x and 4.x schemas
  - File path extraction from image messages  
  - Generic 'image' type mapping for message database schema
  - Integration with existing incremental sync capabilities
- **Out**:
  - Actual image file downloading or storage (handled by separate media services)
  - Video or other media type support beyond images
  - Database schema modifications

## Boundary Candidates
- Message type detection logic in `mapMessage()` function
- WeChat database schema version detection and handling
- Incremental sync integration points for new message types

## Out of Boundary
- Image file download or storage implementation
- Media processing or enhancement features
- Cross-platform media synchronization beyond WeChat
- Database schema modifications

## Upstream / Downstream
- **Upstream**: WeChat database connection and encryption handling (existing)
- **Downstream**: Media services that will handle actual image downloading/storing

## Existing Spec Touchpoints
- Extends: WeChat platform adapter spec
- Adjacent: Message processing pipeline, incremental sync implementation

## Constraints
- Must support both WeChat 3.x and 4.x database schemas
- No changes to existing database schema or structure
- Must preserve all existing functionality for text and other messages
- Performance considerations for large databases