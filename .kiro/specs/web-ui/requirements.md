# Requirements Document

## Introduction

The Web UI provides a local browser interface for browsing and searching synced messages without involving an AI assistant. It is a plain HTML/CSS single-page application served by a local HTTP server at `localhost:3333`. All message data comes from the existing archive database; no new data logic is introduced.

## Boundary Context

- **In scope**: HTTP server (`npm run web`), JSON API routes for chats/search/messages, static HTML/CSS UI (search box, chat sidebar, thread view), platform badge on chats and messages, localhost-only binding, no-build-step constraint.
- **Out of scope**: Authentication and access control (security-hardening spec), sending messages, media rendering (images, audio, video), mobile layout, real-time push/live updates, any new database schema changes.
- **Adjacent expectations**: The existing message archive database and its query functions are consumed read-only. The MCP server (`src/mcp.ts`) must not be modified; web routes reuse its handler logic but do not alter it.

## Requirements

### Requirement 1: HTTP Server and Start Command

**Objective:** As a user, I want a single command to start the local web server so I can access my messages in any browser without any setup.

#### Acceptance Criteria

1. When `npm run web` is run, the Web UI server shall start and bind to `127.0.0.1:3333`.
2. The Web UI server shall only accept connections from `127.0.0.1`; connections attempted from other network addresses shall be refused at the bind level.
3. When a browser requests `GET /`, the Web UI server shall respond with a complete HTML page that renders the full three-zone UI (search box, chat list sidebar, message thread view).
4. If port 3333 is already occupied when the server starts, the Web UI server shall exit with a clear error message identifying the port conflict.
5. The Web UI server shall respond to all API requests within 2 seconds when the database is already initialised and loaded.

---

### Requirement 2: Chat List

**Objective:** As a user, I want to see all my synced chats in a sidebar so I can select one to read.

#### Acceptance Criteria

1. When the page loads, the Web UI shall display all synced chats in the sidebar, sorted by most recent message activity.
2. Each chat entry in the sidebar shall show the chat name, platform badge, and message count.
3. When a user clicks a chat entry, the Web UI shall load and display that chat's messages in the thread view.
4. The Web UI shall expose `GET /api/chats` returning a JSON array of chat records usable by the sidebar.

---

### Requirement 3: Message Search

**Objective:** As a user, I want to search across all messages from all platforms so I can find specific conversations quickly.

#### Acceptance Criteria

1. When the user submits a non-empty search query, the Web UI shall display matching messages from across all platforms.
2. Each search result shall show the chat name, sender name, message text, timestamp, and platform badge.
3. When a user clicks a search result, the Web UI shall load the thread for that result's chat in the thread view.
4. If the search query is empty, the Web UI shall not submit a search and shall not display an error to the user.
5. The Web UI shall expose `GET /api/search?q=<query>` returning a JSON array of matching message records.

---

### Requirement 4: Message Thread View

**Objective:** As a user, I want to read a full message thread when I select a chat so I can review the conversation history.

#### Acceptance Criteria

1. When a chat is selected or a search result is clicked, the Web UI shall display that chat's messages in the thread view in chronological order.
2. Each message shall display the sender name, text content, and timestamp.
3. Messages sent by the local user shall be visually distinguished from received messages (e.g., different alignment or colour).
4. If a message has no text content (e.g., a media-only message), the Web UI shall display a placeholder label in its place rather than an empty bubble.
5. The Web UI shall expose `GET /api/messages/:chatId` returning a JSON array of message records for the requested chat.

---

### Requirement 5: Platform Badge

**Objective:** As a user, I want each chat and message to show its platform so I can tell message sources apart at a glance.

#### Acceptance Criteria

1. Each chat entry in the sidebar shall include a visible platform badge showing the platform name (e.g., "telegram", "imessage", "wechat").
2. Each message in the thread view shall include a visible platform badge.
3. The platform badge shall display the platform identifier value stored in the database without any additional lookup or mapping.

---

### Requirement 6: Self-Contained UI and No-Build Constraint

**Objective:** As a user, I want the UI to load instantly without any build step or external network calls so the tool works offline and requires no toolchain beyond Node.

#### Acceptance Criteria

1. The Web UI shall load and function fully in a browser without making any network requests to external hosts (no CDN resources, no external fonts, no third-party scripts).
2. The Web UI shall work without any compilation or build step — running `npm run web` directly serves a functional UI.
3. The Web UI shall be implemented using plain HTML, CSS, and vanilla JavaScript only; no frontend framework or bundler shall be required.
