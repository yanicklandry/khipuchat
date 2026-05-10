# Brief: wechat-image-sync

## Problem
WeChat messages containing images are not properly handled by the existing WeChat platform adapter. Users cannot sync image content from WeChat, which limits the functionality of KhipuChat when used with WeChat conversations.

## Current State
The WeChat platform adapter in `src/platforms/wechat/sync.ts` only processes text-based messages and treats all non-text content as 'other' type. Image messages are not identified or extracted properly from the WeChat database structure.

## Desired Outcome
WeChat image messages should be properly detected, mapped to the generic message schema, and stored with appropriate metadata including file paths for actual image retrieval.

## Approach
Enhance the existing WeChat platform adapter to:
1. Detect image-type messages in WeChat's database schema
2. Extract image metadata and file paths from message content
3. Map image messages to the generic message schema with 'image' type
4. Store image information in the database for proper retrieval

## Scope
- **In**: Image message detection, metadata extraction, file path handling, integration with existing message schema
- **Out**: Actual image file downloading and storage (handled by file system), complex image processing, external service integrations

## Boundary Candidates
- Image type detection within WeChat's message structure
- File path resolution for WeChat media assets
- Schema mapping between WeChat-specific fields and generic message format

## Out of Boundary
- Downloading or storing actual image files (rely on file system)
- Image processing or transformation
- Integration with cloud storage services
- Complex image metadata handling beyond basic file references

## Upstream / Downstream
- **Upstream**: WeChat database structure, existing message schema in db.ts
- **Downstream**: Web UI for displaying images, search functionality for image content

## Existing Spec Touchpoints
- Extends: wechat-sync (existing WeChat support)
- Adjacent: platform-abstraction (generic message handling)

## Constraints
- Must maintain compatibility with existing WeChat sync process
- Cannot modify database schema beyond what's already available
- Must follow existing code patterns in the project