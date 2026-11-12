// Shared contracts for the Zalo PC full-history importer (zalo-full-history spec).
// Types only: no runtime logic lives here.

/** A conversation as listed by Zalo PC's renderer store. */
export interface ZaloPcConversation {
  uid: string
  name: string
  /** null when Zalo PC did not say either way. */
  isGroup: boolean | null
  /** Official Account (Zalo PC sets `oaInfo`; types 5 and 7). Confirmed in task 1.3. */
  isOfficialAccount: boolean
}

/** One message row from Zalo PC's renderer store, normalized to strings. */
export interface ZaloPcRow {
  /** May carry a "_NNN" device suffix on multi-device copies. */
  msgId: string
  cliMsgId: string
  /** "0" means sent by the logged-in user. */
  fromUid: string
  /** The conversation uid. */
  toUid: string
  /** Epoch milliseconds, as a string. */
  sendDttm: string
  serverTime: string | null
  msgType: number
  /** A string for text messages, an object for media/links, null when absent. */
  message: string | Record<string, unknown> | null
  dName: string | null
}

/** Keyset cursor: fetch messages strictly older than this one. */
export interface PageCursor {
  sendDttm: string
  msgId: string
}

export type ImportStep = 'locate' | 'launch' | 'attach' | 'login' | 'shape' | 'account' | 'read'

export type ImportError =
  | { kind: 'not_installed'; step: 'locate'; searched: string[] }
  | { kind: 'launch_failed'; step: 'launch'; message: string }
  | { kind: 'attach_failed'; step: 'attach'; message: string }
  | { kind: 'not_logged_in'; step: 'login' }
  | { kind: 'shape_unrecognised'; step: 'shape'; detail: string; zaloVersion: string | null }
  | { kind: 'account_mismatch'; step: 'account'; expectedUid: string; actualUid: string }
  | { kind: 'uid_store_invalid'; step: 'account'; path: string }
  | { kind: 'connection_lost'; step: 'read'; conversationsDone: number }

export type Result<T> = { ok: true; value: T } | { ok: false; error: ImportError }

/** What the automatic readiness check reports before any write. */
export interface ReadinessReport {
  zaloVersion: string
  chromium: string
  ownUid: string
  ownName: string
  dmCount: number
  sample: { name: string; oldestTs: number | null }
}

export interface ImportSummary {
  conversations: number
  added: number
  alreadyPresent: number
  skipped: number
  failed: Array<{ name: string; reason: string }>
}

export interface Reporter {
  info(line: string): void
  progress(name: string, read: number): void
  warn(line: string): void
}
