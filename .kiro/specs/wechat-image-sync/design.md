# Design Document

## Overview 

This feature delivers WeChat image synchronization capabilities to the Khipu chat platform. It extends the existing WeChat adapter to detect, process, and map image-type messages from WeChat databases to the generic message schema.

**Purpose**: Enable users to view and interact with image content in their WeChat conversation history within the Khipu platform.

**Users**: Users of the Khipu chat platform who sync with WeChat accounts containing image content.

**Impact**: Expands the range of supported message types beyond text-only, enabling full media support for WeChat conversations.

### Goals
- Detect image messages in both WeChat 3.x and 4.x database schemas
- Extract file paths or metadata from image messages for downstream systems
- Map detected images to generic 'image' type in the message schema
- Maintain compatibility with existing text and non-image message handling

### Non-Goals
- Download or store actual image files (handled by separate media services)
- Support video or other media types beyond images
- Modify WeChat database schemas or structure
- Implement advanced image processing features

## Boundary Commitments

### This Spec Owns
- Message type detection logic for image content in WeChat databases
- File path extraction from image messages
- Mapping of WeChat-specific image message types to generic 'image' schema
- Integration with existing incremental sync capabilities

### Out of Boundary
- Actual image file downloading or storage
- Media processing or enhancement features
- Database schema modifications
- Cross-platform media synchronization beyond WeChat

### Allowed Dependencies
- Existing WeChat database connectivity and encryption handling
- Current message processing pipeline in the sync adapter
- Incremental sync capabilities for existing chat processing

### Revalidation Triggers
- Changes to WeChat database schemas (3.x vs 4.x)
- Updates to message type mappings or field definitions
- Modifications to incremental sync implementation

## Architecture

### Existing Architecture Analysis

The current WeChat platform adapter follows a well-defined architecture pattern:
- Database abstraction layer for schema detection and connection management
- Message processing pipeline with type mapping functions
- Incremental sync implementation with time-based filtering
- Support for both legacy 3.x and modern 4.x database schemas

### Architecture Pattern & Boundary Map

**Selected Pattern**: Adapter Pattern with Database Schema Detection
**Domain Boundaries**: WeChat-specific message handling within the broader platform adapter architecture
**Existing Patterns Preserved**: Incremental sync, schema detection, message mapping

### Technology Stack

| Layer | Choice / Version | Role in Feature | Notes |
|-------|------------------|-----------------|-------|
| Backend / Services | TypeScript/Node.js | Platform adapter logic | Uses existing codebase patterns |
| Data / Storage | SQLite (WeChat databases) | Message persistence | No schema changes required |
| Messaging / Events | None | N/A | Feature handles internal state |

## File Structure Plan

### Directory Structure
```
src/
└── platforms/
    └── wechat/
        ├── sync.ts          # Main sync logic and message mapping
        └── contacts.ts      # Contact handling (unchanged)
```

### Modified Files
- `src/platforms/wechat/sync.ts` — Enhanced mapMessage function to handle image detection and mapping

## Components and Interfaces

### Platform Adapter Domain

#### WeChatMessageMapper
| Field | Detail |
|-------|--------|
| Intent | Maps WeChat database messages to generic message schema |
| Requirements | 1.1, 1.2, 1.3, 1.4 |
| Owner / Reviewers | WeChat platform team |

**Responsibilities & Constraints**
- Primary responsibility: Convert WeChat-specific message data to generic schema
- Domain boundary: Only handles WeChat database schema conversion
- Data ownership: Message content, type mapping, metadata

**Dependencies**
- Inbound: WeChat database connection (P0)
- Outbound: Generic message schema (P0)
- External: WeChat database encryption handling (P1)

**Contracts**: Service [x] / API [ ] / Event [ ] / Batch [ ] / State [ ]

##### Service Interface
```typescript
interface WeChatMessageMapperService {
  mapMessage(msg: WeChatMessage, schemaInfo: SchemaInfo): Message;
}
```

**Implementation Notes**
- Integration: Extends existing message mapping pipeline  
- Validation: Ensures proper field mapping for image messages
- Risks: Potential false positives in type detection

## Data Models

### Domain Model
- Message entity with type field (text, image, other)
- WeChat database schema abstraction
- Contact information for chat context

### Logical Data Model

**Structure Definition**:
- Entities: Message, Chat, Contact
- Attributes: external_id, chat_id, timestamp, is_sender, type, content
- Natural keys: server_id, msgSvrID, local_type
- Referential integrity: Chat reference in Message

### Data Contracts & Integration

**API Data Transfer**
- Request/Response schemas for message processing  
- Validation rules for field mapping
- Serialization format: JSON objects

## Error Handling

### Error Strategy
- Graceful handling of unsupported message types
- Logging of detection failures for debugging
- Preserving existing error recovery mechanisms

### Error Categories and Responses
**System Errors** (5xx): Database connectivity issues → retry logic with exponential backoff
**Business Logic Errors** (422): Invalid field formats → log warning and skip message

## Testing Strategy

### Default sections (adapt names/sections to fit the domain)
- Unit Tests: 3–5 items from core functions/modules (e.g., type detection, field mapping)
- Integration Tests: 3–5 cross-component flows (e.g., sync integration, incremental processing)