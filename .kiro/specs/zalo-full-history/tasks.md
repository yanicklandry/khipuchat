# Implementation Plan

> **Gate:** only 1.1 and 1.2 may start before task 1.3 records a GO. Every task from 2.x onward depends on 1.3.

- [ ] 1. Foundation and macOS go/no-go gate
- [x] 1.1 Define the shared importer types and port contracts
  - Declare the following exactly as specified in design.md:
    - the Zalo PC conversation, message row, and page cursor shapes;
    - the import error union with its failing step, including a `uid_store_invalid` variant (step `account`, carrying the file path);
    - the result envelope, the readiness report, the import summary, and the progress reporter.
  - Strict TypeScript, no `any`, no runtime logic beyond type exports.
  - Observable completion: the new types module compiles under the project's strict settings, and every later importer module can import its contracts from it.
  - _Requirements: 1.2, 1.3, 5.4, 6.2, 7.3_

- [x] 1.2 Build the minimal loopback CDP client
  - List debugging targets and read the browser version from the local debugging port, always on `127.0.0.1`.
  - Open a session to a chosen page target, and evaluate an expression that resolves to a JSON string, parsing it into a typed result. Map renderer exceptions to an attach error.
  - Reject any target whose WebSocket URL is not loopback.
  - On socket close, fire the close handler once and fail any in-flight calls as a lost connection.
  - Use Node 24's built-in WebSocket and fetch, injectable for tests. No new npm dependency.
  - Observable completion: `tests/zalo-history-cdp.test.ts`, using a fake WebSocket and fetch, confirms JSON result parsing, exception mapping, non-loopback rejection, and lost-connection behaviour, and `package.json` is unchanged.
  - _Requirements: 2.5, 7.3, 8.1, 8.5_

- [x] 1.3 Run the go/no-go spike against the real Zalo PC on this Mac
  - Prerequisites:
    - The operator is present: Zalo PC 26.11.10 is quit, relaunched with a loopback debugging port, then relaunched normally at the end.
    - The archive already holds zalo-sync messages for at least one DM that is also visible in Zalo PC. If not, run `khipu sync zalo` first.
    - The throwaway probe script lives in the session scratchpad, not in `src/`, and is never committed.
  - Using the CDP client from 1.2, confirm in order:
    - the `index.html` page target exists;
    - the store module and its four read functions resolve;
    - the logged-in user can be read;
    - the conversation list can be read;
    - one DM's history can be paged back to its oldest message.
  - Record the real row and conversation field names, how groups are marked (an `isGroup` flag or a `g` id prefix), and any Official Account marker.
  - Compare one message that already exists in the archive from zalo-sync with the same message read from Zalo PC, to confirm both use the same message id.
  - Observable completion: `.kiro/specs/zalo-full-history/research.md` has a dated "macOS go/no-go result" entry containing:
    - the Zalo version, the DM count, and a sample oldest-message date;
    - the confirmed field names and the group and Official Account markers;
    - the msgId parity verdict;
    - an explicit GO or NO-GO.
  - On NO-GO, or if the message ids differ, stop and return to design before any further task.
  - _Requirements: 1.1, 1.2, 1.4, 3.1, 3.2, 4.2_

- [ ] 2. Core components
- [ ] 2.1 (P) Implement the pure history-to-archive mapping
  - Decide whether a conversation is a DM, skipping groups and any Official Account marker confirmed in 1.3.
  - Collapse multi-device duplicate rows that share a client message id. Keep the unsuffixed copy first, then the latest server time, then the larger id.
  - Produce chat and message records by delegating to zalo-sync's existing mappers, so external ids, platform, chat type, and sender rules match exactly.
  - Then refine the message type (image, sticker, video, other), and keep a caption as the text of non-text messages.
  - Observable completion: `tests/zalo-history-mapping.test.ts` shows:
    - identity fields identical to zalo-sync's mappers for equivalent input;
    - correct type and caption mapping;
    - duplicate collapse keeping the right copy;
    - group rejection.
  - _Requirements: 3.2, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1, 8.3_
  - _Boundary: Mapping_
  - _Depends: 1.3_

- [ ] 2.2 (P) Implement Zalo PC process control for macOS
  - Locate the app: the operator-supplied path first, then `/Applications`, then `~/Applications`. Read its version, and report every path searched when the app is missing.
  - When Zalo PC is running: quit it gracefully, wait for it to exit, and force-stop it only after a timeout.
  - Then launch it hidden and without stealing focus (`open -g -j ... --args`) with a random loopback debugging port, wait for its page target, and report whether a restart happened.
  - On request, relaunch Zalo PC normally, in the background (`open -g`), without the debugging flag.
  - All shell and process calls are injected, so tests never touch the real app.
  - Observable completion: `tests/zalo-history-app-control.test.ts`, with fake exec and spawn, covers:
    - not installed;
    - not running (launch only);
    - running (quit then launch, restarted flag set);
    - quit timeout (force stop);
    - page target never appearing (launch error);
    - normal relaunch.
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 2.6, 8.1, 8.5_
  - _Boundary: AppControl_
  - _Depends: 1.2, 1.3_

- [ ] 2.3 (P) Implement the renderer store reader with shape validation
  - Build read-only renderer expressions, using the names confirmed in 1.3, to:
    - probe the store;
    - read the logged-in user;
    - list conversations;
    - fetch one page of a conversation's messages older than a cursor.
  - Validate every returned conversation and row against the expected field types. A missing function or an invalid row yields an "unrecognised shape" error that names what was missing and gives the Zalo version.
  - Treat an empty user id as not logged in.
  - Never call network, decryption, or session modules.
  - Observable completion: `tests/zalo-history-store-reader.test.ts`, with a fake CDP session, covers:
    - a valid probe;
    - a missing store module;
    - not logged in;
    - a valid page;
    - one malformed row failing the whole page.
  - _Requirements: 1.1, 1.4, 2.4, 3.1, 3.3, 6.4, 8.2, 8.5_
  - _Boundary: StoreReader_
  - _Depends: 1.3_

- [ ] 2.4 (P) Implement the account-to-Zalo-user binding store
  - Keep account-to-Zalo-uid bindings in a local JSON file, `.zalo_uids.json`, and add that file to `.gitignore`.
  - A configured uid takes priority over the file.
  - Report a mismatch when this account is bound to a different uid, or when the uid is already bound to another account. Otherwise report a first run.
  - Write bindings atomically.
  - Treat a missing file as empty. A malformed file returns the `uid_store_invalid` error naming the file.
  - Observable completion: `tests/zalo-history-uid-store.test.ts`, against a temp file, covers:
    - configured-uid priority;
    - first run, then bind;
    - same-account mismatch;
    - cross-account mismatch;
    - a malformed file;
    - an atomic write.
  - Observable completion (continued): `git check-ignore .zalo_uids.json` succeeds.
  - _Requirements: 5.4, 8.2_
  - _Boundary: UidStore_
  - _Depends: 1.3_

- [ ] 2.5 (P) Accept an optional legacy `ZALO_UID` in the account registry
  - Today the legacy (no config file) optional-field map holds one variable per platform. Widen it to a list, so zalo can expose both `ZALO_SESSION` and `ZALO_UID` while whatsapp keeps its single optional field.
  - Observable completion: `tests/account-registry.test.ts` gains cases showing that a legacy `ZALO_UID` env var appears in the default zalo account's fields, and that existing whatsapp and zalo session behaviour is unchanged. All existing registry tests still pass.
  - _Requirements: 5.4_
  - _Boundary: AccountRegistry_
  - _Depends: 1.3_

- [ ] 3. Integration
- [ ] 3.1 Implement the importer readiness phase
  - Run these steps in order:
    1. locate the app;
    2. launch it in debug mode;
    3. attach;
    4. probe the store;
    5. read the logged-in user;
    6. check the account binding;
    7. list the conversations and keep only DMs;
    8. page the most recent DM fully to find its oldest message.
  - Return the readiness report, or the first failing step's error. Write nothing to the archive or the binding file; teardown is owned by 3.2.
  - Observable completion: `tests/zalo-history-importer.test.ts`, with fake ports and an in-memory DB, shows:
    - a full readiness report on success;
    - for each failing step (not installed, attach failure, not logged in, unrecognised shape, account mismatch, invalid uid file), the matching error, with zero rows in `chats` and `messages` and the binding file unchanged.
  - _Requirements: 1.1, 1.2, 1.3, 2.3, 2.4, 5.4, 6.4_
  - _Boundary: Importer_
  - _Depends: 2.1, 2.2, 2.3, 2.4_

- [ ] 3.2 Implement history paging, idempotent ingestion, and teardown
  - Wrap the readiness phase in a single `finally` that always closes the session and relaunches Zalo PC normally. This applies on success, on readiness failures that happen after launch, and on every import error.
  - On a first run, bind the account to the detected Zalo user only after readiness fully succeeds. Print the link line, then start the first transaction.
  - Paging: for each DM, page backward from newest to oldest in pages of 500. Advance the cursor to each page's oldest row, and stop on a short page.
  - Ingestion: write each page in one DB transaction:
    - upsert the chat under the resolved account;
    - insert each collapsed row only when its id is not already in that chat;
    - count added and already-present messages.
  - Contain failures:
    - a failing message is logged and skipped;
    - a failing conversation goes into the summary and the import continues;
    - a lost connection stops the import, with the number of conversations completed.
  - Report per-conversation progress. Never touch the zalo sync position.
  - Observable completion: importer integration tests show:
    - 3 DMs and 1 group with 1,201 messages: all DM messages imported, exact counts, group skipped;
    - a pre-seeded zalo-sync message counts as already present, and a second run adds zero;
    - a mid-page disconnect keeps earlier pages, and a re-run completes the rest;
    - `sync_state` for zalo is unchanged;
    - normal relaunch and session close are called on success, on a post-launch readiness failure (not logged in, shape, mismatch), and on a lost connection;
    - a readiness failure after reading the user leaves the binding file unchanged.
  - _Requirements: 2.6, 3.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 7.1, 7.2, 7.3_
  - _Boundary: Importer_
  - _Depends: 3.1_

- [ ] 3.3 Build the `import zalo-history` command entry
  - Parse `--account`, `--app-path`, and `--help`.
  - Resolve the account: an explicit listed account, else `default`, else the only account, else an error listing the choices.
  - Read the optional configured Zalo uid from the account's fields.
  - Print the fidelity and restart disclosure first, then the readiness report, the progress lines, and the final summary.
  - Map every error to the operator message in design.md. `uid_store_invalid` reads: "The Zalo account link file <path> is corrupt. Fix or delete it, then re-run."
  - Exit 1 on any error or failed conversation, and 0 otherwise.
  - Wire the real ports, and open the archive the same way zalo-sync does.
  - Observable completion: `tests/zalo-history-cli.test.ts` covers:
    - argument parsing;
    - the four account-resolution cases;
    - the disclosure printed before anything else;
    - exit codes for success, error, and partial failure.
  - _Requirements: 5.3, 6.3, 7.4, 8.5_
  - _Boundary: Cli_
  - _Depends: 2.5, 3.2_

- [ ] 3.4 Route `khipu import zalo-history` through the khipu CLI
  - Add an `import` subcommand that forwards `zalo-history` and its arguments to the new entry, rejects unknown import targets, and appears in the root and subcommand usage text.
  - Observable completion: `tests/khipu.test.ts` asserts that:
    - `import zalo-history --account work` routes to the entry with its args;
    - `import foo` is an error;
    - `khipu import --help` shows usage.
  - _Requirements: 5.3_
  - _Boundary: KhipuRouter_
  - _Depends: 3.3_

- [ ] 4. Validation and documentation
- [ ] 4.1 Document the command and the new external-process prerequisite
  - In the README's Zalo section, describe:
    - the command and its prerequisites (macOS, Zalo PC installed and logged in);
    - that Zalo PC is restarted twice;
    - the bounded fidelity;
    - the account linking;
    - the manual Export Data fallback for a single conversation.
  - Add a Zalo PC row to the external-process table in `.kiro/steering/tech.md`.
  - Observable completion: the README section and the steering row exist and match the shipped command's flags and messages.
  - _Requirements: 6.3, 6.5_

- [ ] 4.2 Run the end-to-end import against the real Zalo PC and confirm parity
  - Needs the operator present. Run the import for the default account, then run it again.
  - Confirm that the CLI, MCP, and full-text search, filtered to platform `zalo`, return pre-link messages.
  - Confirm that `git diff` shows no changes to MCP, CLI query, or web query logic, and that Zalo PC is back in normal mode with no debugging port listening.
  - Observable completion:
    - the second run reports zero added;
    - a `khipu search` for a known old message returns it;
    - `lsof -iTCP -sTCP:LISTEN` shows no Zalo debug port;
    - the results are noted in `research.md`.
  - _Requirements: 2.6, 5.2, 8.1, 8.3, 8.4_

- [ ] 4.3 Run the full regression suite
  - Run the full vitest suite under Node 24. Check that the new files add no type errors (the repo already has known, unrelated tsc errors).
  - Observable completion: all tests pass with the pass count reported, and `tsc --noEmit` output contains no errors from `src/platforms/zalo/history/` or the modified files.
  - _Requirements: 8.5_

## Implementation Notes
- 1.2: CDP `onClose` fires only on connection LOSS, never on our own `close()`; `connection_lost` from the client carries `conversationsDone: 0`, the importer (3.2) must fill the real count. `connect` rejects (throws) after a 10s timeout, so `openReader` must convert that to a Result.
- 1.3 (GO): match the page target on `/index.html`; poll `store.getUserId()` until non-empty after attach. DM = `isGroup !== true && !oaInfo` (OA = types 5/7 with `oaInfo`). Text is `message` (string); captions are `message.title ?? message.description ?? message.desc`. Rows within a page are oldest first: compute the cursor as the min `(sendDttm, msgId)`, never `rows[last]`. msgId parity with zalo-sync confirmed.
- 1.3: tell users in docs (4.1) to run Zalo PC "sync messages from phone" first; Zalo PC on this Mac held only days of history for an active chat.
- User feedback 2026-11-12: launching the Zalo binary directly made windows flash and steal focus. Always use `open -g -j` for the debug launch and `open -g` for the final relaunch.
