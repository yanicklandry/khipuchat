# Brief: email-sync

## Problem
Email is the oldest messaging platform but is completely absent from the local archive. Users want sent and received email threads searchable alongside chat messages.

## Current State
No email integration. Platform abstraction supports adding new platforms via PlatformAdapter.

## Desired Outcome
`npm run sync:email` connects to an IMAP mailbox, fetches sent and received messages, stores them as records with `platform='email'`, and is idempotent. Threads are grouped by `Message-ID` / `In-Reply-To` headers into reply chains.

## Approach
`imapflow` npm package — actively maintained, promise-based, handles IMAP IDLE and SEARCH. Fetch INBOX and Sent folders. Map each email to the shared Message schema: `external_id = Message-ID header`, `text = plain-text body`, `sender_name = From display name`, `reply_to_external_id = In-Reply-To`. Store as `type='text'`.

## Scope
- **In**: `src/platforms/email/sync.ts`, IMAP connection via imapflow, INBOX + Sent sync, Message-ID deduplication, `npm run sync:email`, env vars `EMAIL_IMAP_HOST / EMAIL_IMAP_USER / EMAIL_IMAP_PASS`, tests with mocked IMAP client
- **Out**: Sending email, HTML body rendering (store plain text only), attachments, calendar invites, real-time IMAP IDLE listener (one-shot sync only)

## Boundary Candidates
- IMAP connection + folder fetch — injectable for testing
- Email → Message mapping — pure function, easily unit-tested
- Thread grouping — via reply_to_external_id chain (no new DB concept needed)

## Out of Boundary
- DB schema changes — platform-abstraction owns the schema
- HTML-to-text conversion if plain text part is missing — out of scope for v1 (skip those messages)

## Upstream / Downstream
- **Upstream**: platform-abstraction (PlatformAdapter interface, db functions)
- **Downstream**: release (packaged)

## Existing Spec Touchpoints
- **Extends**: src/platforms/types.ts (add 'email' to Platform union)
- **Adjacent**: src/db.ts — call only exported functions

## Constraints
- imapflow is the chosen library (actively maintained, promise-based)
- Credentials in .env only
- One-shot sync (no persistent IMAP IDLE connection)
- Must handle large mailboxes gracefully: paginate in batches of 200 messages
