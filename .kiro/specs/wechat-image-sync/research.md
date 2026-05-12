# Research Log

## Summary

This research identifies key implementation details for WeChat image synchronization. The current WeChat adapter handles text messages but lacks image support, requiring extension of the message mapping logic to detect and process image-type messages.

## Key Findings

1. **Current Message Handling**: The existing adapter only maps text messages (type 1 with rawText) and treats all other types as 'other'. For image processing, we need to extend this detection logic.

2. **Schema Analysis**: WeChat uses two database schemas:
   - Legacy (3.x): Uses Chat_XXXX tables with msgSvrID, MesSvrID, CreateTime, Message, strContent, Des, isSend, Type, MsgType fields
   - Modern (4.x): Uses MD5(user_name) tables with server_id, create_time, message_content, WCDB_CT_message_content, real_sender_id, local_type fields

3. **Image Data Storage**: Images are stored as separate files in WeChat's media directory structure. The database contains file paths to these external assets rather than binary data directly.

## Research Log

### 1. Implementation Patterns

**Current Implementation Limitations:**
- Only text messages (type=1 with non-null rawText) are mapped to 'text' type
- All other messages default to 'other' type in `mapMessage()` function
- No specific logic for detecting image or media content types in either schema

**Required Enhancements:**
- Add detection logic for image message types based on WeChat's internal message classification
- Implement extraction of file paths from message_content fields for image handling
- Map detected images to generic 'image' type in the message schema
- Preserve existing functionality for all non-image messages

### 2. Technical Approach

**Schema Detection:**
- Use existing `buildSchemaInfo()` function to determine which schema is present (3.x vs 4.x)
- Apply appropriate column mapping based on detected schema version

**Message Type Identification:**
- For WeChat 3.x: Look for specific field patterns indicating image messages
- For WeChat 4.x: Check local_type or similar fields that indicate media content
- Analyze message_content field to determine if it contains image metadata

### 3. Integration Points

**Database Layer:**
- Minimal changes needed since all required fields are already available in the database
- No schema modifications required

**Message Processing Pipeline:**
- Extend `mapMessage()` function to handle image detection and mapping
- Maintain compatibility with existing incremental sync logic
- Ensure proper handling of both legacy and modern schemas

### 4. Design Considerations

**Data Flow:**
- Image messages will be detected during message processing
- File paths will be extracted from database fields for downstream systems
- No actual file downloading or storage is part of this implementation

**Compatibility:**
- All existing functionality preserved for text and non-image messages
- Incremental sync capabilities maintained
- Both WeChat 3.x and 4.x schemas supported

## External Dependencies

No external dependencies identified. The implementation will use only existing codebase patterns and available database fields.

## Risks and Mitigation

**Risk**: Incorrect message type detection could lead to data loss or incorrect categorization
**Mitigation**: Implement comprehensive testing with sample data from both schema versions

**Risk**: Performance impact on large databases
**Mitigation**: Leverage existing incremental sync patterns that process messages in batches