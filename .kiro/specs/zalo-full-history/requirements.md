# Requirements Document

## Introduction

The `zalo-sync` adapter captures Zalo direct messages live, plus a shallow recent window delivered on connect. Zalo has removed the server-side 1:1 history endpoint, so any Zalo history that predates the live link is a permanent blind spot in the archive.

The official Zalo PC desktop app, once installed and logged in, already holds the user's synced DM history and shows it decrypted in its own UI. This feature adds a one-shot, operator-run import command (working name `khipu import zalo-history`). It reads that already-decrypted history from the user's own running Zalo PC session on the same Mac and ingests it into the archive under platform `zalo`, using the same conversation and message identities as `zalo-sync`. Imported history then appears on every existing query surface with no special-casing.

**Two first-class constraints:**
- **Unverified on macOS.** The only prior art is Windows-only. Every import therefore begins with an automatic, read-only readiness check (Requirement 1) that acts as a go/no-go gate. The first run against a real macOS Zalo PC install is the go/no-go test for the whole feature. If the check fails on a real macOS Zalo PC install, the importer is not built further, and the spec is revisited or closed.
- **Bounded fidelity.** The import only recovers what has already synced to the specific Zalo PC install being read. It is not a guaranteed complete mirror, and the command must say so (Requirement 6).

## Boundary Context

- **In scope**: A one-shot import command for macOS that attaches to the user's own logged-in Zalo PC app (restarting it if needed); an automatic read-only readiness check before any write; enumerating DM conversations and paginating each conversation's history back to the oldest message available locally; mapping onto the shared conversation/message model with `zalo-sync`'s identities; idempotent ingestion through the existing archive ingestion functions; account scoping; progress and summary reporting; tests that never launch a real Zalo PC.
- **Out of scope**: Group-chat and Official Account history; importing only selected conversations or only messages after a date (v1 always imports all DM history); a separate dry-run-only mode; throttling reads to keep Zalo PC responsive; sending or modifying any Zalo data; Windows and Linux; automating Zalo PC's built-in per-conversation "Export Data" UI (kept as a documented manual fallback only); downloading image or attachment content, or running OCR on it; any network call to Zalo's servers beyond what the Zalo PC app itself does; any guarantee that Zalo PC's internal data shape survives future app updates; continuous or scheduled import (this is not a sync daemon backend).
- **Adjacent expectations**: Relies on `zalo-sync`'s conventions: platform `zalo`, conversation identity = Zalo thread id, message identity = Zalo message id. It also relies on the existing archive schema, ingestion functions, and account registry, all unchanged. It does not modify `zalo-sync`'s live adapter, the sync daemon, the database schema, or any query surface (MCP, CLI query, web).

## Requirements

### Requirement 1: Automatic read-only readiness check (go/no-go gate)

**Objective:** As the KhipuChat maintainer, I want every import to first prove that the local Zalo PC history can be read on this Mac, so that the unverified macOS path is confirmed or ruled out empirically before anything is written.

#### Acceptance Criteria
1. When the import command starts, the Zalo History Importer shall attach to the local Zalo PC app and verify that its message history is readable before writing anything to the archive.
2. When the check succeeds, the Zalo History Importer shall report, before importing, the detected Zalo PC version, the number of DM conversations found, and the timestamp of the oldest readable message for at least one sample conversation.
3. If any check step fails (app not found, attach refused, history not readable, data shape not recognised), the Zalo History Importer shall report which step failed, write nothing to the archive, and exit with a non-zero status.
4. The Zalo History Importer shall not modify the Zalo PC app's own data or settings at any point.

### Requirement 2: Attaching to the Zalo PC app

**Objective:** As a Zalo user on macOS, I want the importer to connect to my own logged-in Zalo PC app with clear instructions, so that I can run the import without manual debugging setup.

#### Acceptance Criteria
1. When the import command starts and Zalo PC is installed but not running, the Zalo History Importer shall launch Zalo PC in a mode that permits the local read and then attach to it.
2. If Zalo PC is already running in a mode that does not permit the local read, the Zalo History Importer shall quit Zalo PC, relaunch it in a mode that permits the read, and attach, without prompting the operator, and shall print a line saying it restarted Zalo PC.
3. If Zalo PC is not installed at a known or operator-provided location, the Zalo History Importer shall report where it looked and how to supply the location, and exit with a non-zero status.
4. If Zalo PC is running but not logged in, the Zalo History Importer shall instruct the operator to log in to Zalo PC and re-run the command, and exit with a non-zero status.
5. The Zalo History Importer shall only accept connections to Zalo PC on the local machine (loopback), never over the network.
6. When the import finishes or fails, the Zalo History Importer shall detach cleanly and leave Zalo PC running and usable.

### Requirement 3: DM history extraction

**Objective:** As a Zalo user, I want every DM conversation's locally synced history read back to its oldest available message, so that my pre-link Zalo past ends up in the archive.

#### Acceptance Criteria
1. When attached, the Zalo History Importer shall enumerate the 1:1 DM conversations known to Zalo PC.
2. When a conversation is a group or Official Account conversation, the Zalo History Importer shall skip it and not import its messages.
3. When reading a DM conversation, the Zalo History Importer shall page backward through its history until no older message is available locally.
4. When a message carries non-text content (image, sticker, file, call, or similar), the Zalo History Importer shall import it with a non-text type and the textual caption if any, and shall not fail the conversation.

### Requirement 4: Mapping and identity continuity with zalo-sync

**Objective:** As the KhipuChat maintainer, I want imported history mapped with the same identities `zalo-sync` uses, so that imported and live-captured data merge into one conversation without duplicates.

#### Acceptance Criteria
1. When mapping a DM conversation, the Zalo History Importer shall produce a conversation record whose external id is the Zalo thread id, with the contact's display name, a private conversation type, and platform `zalo`, matching `zalo-sync`.
2. When mapping a message, the Zalo History Importer shall produce a message record whose external id is the Zalo message id, with its text, a Unix-second timestamp, a sent/received flag, and platform `zalo`, matching `zalo-sync`.
3. When a message was authored by the logged-in user, the Zalo History Importer shall record it as sent with no sender id or name; otherwise it shall record it as received with the sender's Zalo id and display name.
4. The mapping from Zalo PC history records to archive records shall be pure (no input/output, no live session) so that it can be unit-tested without Zalo PC.

### Requirement 5: Idempotent ingestion and account scoping

**Objective:** As an operator, I want to re-run the import safely and target a specific Zalo account, so that overlap with live sync or a previous import never corrupts the archive.

#### Acceptance Criteria
1. When a message already exists in the archive (from `zalo-sync` or an earlier import), the Zalo History Importer shall not create a duplicate entry for it.
2. When the import is run twice in a row with no new Zalo PC history, the second run shall add zero messages.
3. Where the operator passes an account name, the Zalo History Importer shall attribute imported conversations to that Zalo account; otherwise it shall use the default Zalo account.
4. If the Zalo PC logged-in user does not match the Zalo account selected for the import (when that account's identity is known), the Zalo History Importer shall report the mismatch and stop before writing any message.
5. If the import is interrupted part-way, the Zalo History Importer shall leave every already-written conversation and message intact and consistent, so that a re-run completes the remainder.
6. The import shall not change `zalo-sync`'s recorded incremental-sync position, so that the live adapter's next run behaves exactly as before.

### Requirement 6: Progress, summary, and honest fidelity disclosure

**Objective:** As an operator, I want clear progress and an honest summary, so that I know what was recovered and do not mistake the result for a complete mirror.

#### Acceptance Criteria
1. While importing, the Zalo History Importer shall report per-conversation progress (conversation name and messages read so far).
2. When the import finishes, the Zalo History Importer shall report the number of conversations processed, messages added, messages already present, and conversations skipped or failed.
3. When the import starts, the Zalo History Importer shall state that it recovers only history already synced to this Zalo PC install, and that it depends on undocumented Zalo PC internals that may change on app updates.
4. If the Zalo PC data shape is not recognised (for example after a Zalo PC update), the Zalo History Importer shall stop with a message saying the importer needs updating for this Zalo PC version, instead of importing partial or garbled data.
5. Project documentation shall describe the command, its prerequisites (Zalo PC installed and logged in, macOS), its bounded fidelity, and the manual "Export Data" fallback.

### Requirement 7: Resilience and failure isolation

**Objective:** As an operator, I want a failure in one conversation to be contained, so that one bad thread does not abort the whole import.

#### Acceptance Criteria
1. If reading or ingesting a single conversation fails, the Zalo History Importer shall log the failure with the conversation name and continue with the remaining conversations.
2. If processing a single message fails, the Zalo History Importer shall log it and continue with the next message.
3. If the connection to Zalo PC is lost mid-import, the Zalo History Importer shall stop, report how far it got, and exit with a non-zero status.
4. When one or more conversations failed, the Zalo History Importer shall exit with a non-zero status after printing the summary.

### Requirement 8: Privacy and query-surface parity

**Objective:** As a privacy-conscious user, I want imported history to stay local and behave exactly like live-synced Zalo data, so that the import fits KhipuChat's local-only model.

#### Acceptance Criteria
1. The Zalo History Importer shall read only from the Zalo PC app on the same machine and shall send no history, credentials, or session data to any other destination.
2. The Zalo History Importer shall not persist any Zalo PC session secret to disk.
3. When imported Zalo messages exist in the archive, MCP, CLI, web, full-text search, and (once indexed) semantic search shall return them exactly as they return live-synced Zalo messages, including when filtered by platform `zalo`.
4. The feature shall achieve query-surface parity without modifying MCP, CLI query, or web query logic.
5. The Zalo History Importer's automated tests shall run without launching or requiring a real Zalo PC app.
