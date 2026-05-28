# Brief: wechat-image-sync

## Problem
Users want to sync image messages from WeChat to KhipuChat for better message history and cross-platform access. Currently, image messages are not properly handled in the sync process.

## Current State
The WeChat sync implementation partially detects image messages (types 4, 43, 49) but doesn't properly handle all WeChat image-related message types or extract metadata from image messages.

## Desired Outcome
All image messages should be properly detected and synced as 'image' type messages, with relevant metadata for downstream processing.

## Approach
Enhance the existing image detection logic in the WeChat sync implementation to identify all relevant image-related message types and ensure proper handling of image content.

## Scope
- **In**: 
  - Expand image message type detection to include all relevant WeChat message types
  - Improve metadata extraction for image messages
  - Ensure consistent handling of image messages across legacy and V4 schemas

- **Out**: 
  - Not responsible for image storage or download functionality
  - Not responsible for image processing or transformation

## Boundary Candidates
- Message type detection logic in sync.ts
- Metadata extraction from message content
- Cross-schema compatibility for image messages

## Out of Boundary
- Image storage and persistence
- Image compression or format conversion
- Image download or retrieval mechanisms

## Upstream / Downstream
- **Upstream**: WeChat database access, message parsing
- **Downstream**: Message display, media handling, cross-platform sync

## Existing Spec Touchpoints
- Extends: wechat-sync-core (existing spec)
- Adjacent: message-handling-system

## Constraints
- Must maintain compatibility with existing WeChat message types
- Should not impact performance of non-image messages
- Follow existing code patterns in the wechat adapter