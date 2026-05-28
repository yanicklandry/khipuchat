# Technical Design: WeChat Image Sync

## Overview
This document outlines the technical design for enhancing image message handling in the WeChat sync functionality. The goal is to properly detect, process, and sync all image-related messages from WeChat databases, including both legacy and V4 schemas.

## Requirements Mapping
- Requirement 1 (Enhanced Image Detection): Expand message type detection to include all specified image types
- Requirement 2 (Rich Metadata): Extract file paths/URLs and metadata for image messages
- Requirement 3 (Cross-Schema Compatibility): Ensure consistent handling across legacy and V4 schemas
- Requirement 4 (Performance & Compatibility): Maintain existing functionality without performance impact
- Requirement 5 (Platform Integration): Follow existing code patterns in the wechat adapter

## Architecture Design
### Component: `mapMessage` function in `src/platforms/wechat/sync.ts`

The core enhancement will be made to the existing `mapMessage` function which processes WeChat message rows into standardized message objects.

### Key Changes
1. **Enhanced Image Type Detection**: 
   - Update image detection logic to include all specified types:
     - Type 4 (legacy schema)
     - Type 43 (WeChat schema)  
     - Type 49 (WeChat schema)
     - local_type 4 (V4 schema)

2. **Metadata Extraction for Images**:
   - For image messages, extract file paths/URLs from message content when available
   - Preserve original message identifiers for tracking purposes

3. **Cross-Schema Consistency**:
   - Apply the same enhanced detection logic to both legacy and V4 schemas
   - Maintain existing behavior for non-image messages

## Implementation Details

### Current Code Analysis
The current implementation in `src/platforms/wechat/sync.ts` already contains some image message detection logic at lines 155-159:

```typescript
const isImageMessage = 
  msgType === 43 || // Image type in WeChat
  msgType === 49 || // Media type in WeChat  
  (isV4 && row.local_type === 4) || // Image type in v4 schema
  (!isV4 && row.Type === 4); // Image type in legacy schema
```

However, this logic needs refinement to match the exact requirements and properly handle metadata extraction.

### Proposed Implementation

#### File: `src/platforms/wechat/sync.ts`
- **Location**: Within the existing `mapMessage` function (around line 129)
- **Key Changes**:
  - Update image type detection to exactly match requirement criteria
  - Add logic for extracting image metadata when available
  - Ensure consistent handling across all schema versions

#### Message Type Mapping
The enhanced implementation will ensure that:
- Legacy schema Type 4 messages are correctly identified as images
- WeChat schema Type 43 and Type 49 messages are correctly identified as images  
- V4 schema local_type 4 messages are correctly identified as images
- All other message types maintain their current behavior

## File Structure Plan
1. **Primary Implementation**: `src/platforms/wechat/sync.ts` - Modify the `mapMessage` function to enhance image detection and metadata extraction
2. **Test Coverage**: Add unit tests for the enhanced image message handling logic in `src/platforms/wechat/__tests__/sync.test.ts`

## Data Flow
1. WeChat message rows are read from databases (legacy or V4 schemas)
2. Each row is passed to the `mapMessage` function
3. The function detects if it's an image message based on Type/local_type values
4. For image messages, metadata extraction occurs when available
5. Standardized message object is returned with appropriate type and metadata

## Testing Strategy
- Unit tests for existing image detection logic in `sync.test.ts`
- Test cases covering all supported image types (4, 43, 49, local_type 4)
- Integration tests to ensure compatibility with both legacy and V4 schemas
- Performance tests to verify no regression in message processing speed

## Backward Compatibility
- All existing functionality will be preserved
- No breaking changes to the API or data structures
- Existing message handling behavior for non-images remains unchanged

## Risks & Mitigations
1. **Performance Impact**: 
   - Risk: Enhanced image detection may add processing overhead
   - Mitigation: Profile implementation and optimize if needed

2. **Metadata Extraction Issues**:
   - Risk: Incorrect or missing metadata extraction
   - Mitigation: Implement fallback behavior and comprehensive test coverage

3. **Schema Compatibility**:
   - Risk: Missing edge cases in schema handling
   - Mitigation: Comprehensive testing across different WeChat versions