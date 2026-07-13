import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, getChats, getMessages } from '../src/db'
import {
  resolveThreadExternalId,
  mapMessage,
  runBackfillImpl,
  createEmailAdapter,
} from '../src/platforms/email/sync'
import type { EmailClient, RawEmailMessage, EmailSearchCriteria } from '../src/platforms/email/client'

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeRaw(overrides: Partial<RawEmailMessage> = {}): RawEmailMessage {
  return {
    messageId: 'msg-001@example.com',
    inReplyTo: null,
    from: 'Alice <alice@example.com>',
    subject: 'Hello thread',
    date: new Date('2024-01-01T00:00:00Z'),
    text: 'Hi there',
    ...overrides,
  }
}

async function* asyncOf<T>(...items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

function makeMockClient(
  inboxMsgs: RawEmailMessage[],
  sentMsgs: RawEmailMessage[] = [],
  sentFolder: string | null = 'Sent',
): EmailClient {
  return {
    fetchFolder: (folder: string, _criteria?: EmailSearchCriteria) => folder === 'INBOX'
      ? asyncOf(...inboxMsgs)
      : asyncOf(...sentMsgs),
    listSpecialFolder: async () => sentFolder,
  }
}

function makeSpyClient(
  inboxMsgs: RawEmailMessage[],
  sentMsgs: RawEmailMessage[] = [],
  sentFolder: string | null = 'Sent',
): { client: EmailClient; fetchFolderSpy: ReturnType<typeof vi.fn> } {
  const fetchFolderSpy = vi.fn((folder: string, _criteria?: EmailSearchCriteria) =>
    folder === 'INBOX' ? asyncOf(...inboxMsgs) : asyncOf(...sentMsgs),
  )
  const client: EmailClient = {
    fetchFolder: fetchFolderSpy,
    listSpecialFolder: async () => sentFolder,
  }
  return { client, fetchFolderSpy }
}

// ── resolveThreadExternalId ───────────────────────────────────────────────────

describe('resolveThreadExternalId', () => {
  it('creates new externalId for root message (uses messageId itself)', () => {
    const map = new Map<string, string>()
    const externalId = resolveThreadExternalId('root@ex.com', null, map)
    expect(externalId).toBe('root@ex.com')
  })

  it('reply inherits parent externalId', () => {
    const map = new Map<string, string>()
    const rootId = resolveThreadExternalId('root@ex.com', null, map)
    const replyId = resolveThreadExternalId('reply@ex.com', 'root@ex.com', map)
    expect(replyId).toBe(rootId)
  })

  it('stores the reply messageId in the map', () => {
    const map = new Map<string, string>()
    resolveThreadExternalId('root@ex.com', null, map)
    resolveThreadExternalId('reply@ex.com', 'root@ex.com', map)
    expect(map.has('reply@ex.com')).toBe(true)
  })

  it('unknown inReplyTo creates a new root using the messageId', () => {
    const map = new Map<string, string>()
    const id = resolveThreadExternalId('orphan@ex.com', 'unknown@ex.com', map)
    expect(id).toBe('orphan@ex.com')
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const raw = makeRaw()

  it('sets platform to email', () => {
    expect(mapMessage(raw, 1, 'user@ex.com').platform).toBe('email')
  })

  it('sets external_id to messageId', () => {
    expect(mapMessage(raw, 1, 'user@ex.com').external_id).toBe('msg-001@example.com')
  })

  it('sets is_sender=0 when from does not match userEmail', () => {
    expect(mapMessage(raw, 1, 'user@ex.com').is_sender).toBe(0)
  })

  it('sets is_sender=1 when from includes userEmail (case-insensitive)', () => {
    const sent = makeRaw({ from: 'Alice <ALICE@example.com>' })
    expect(mapMessage(sent, 1, 'alice@example.com').is_sender).toBe(1)
  })

  it('sets type=text when text is present', () => {
    expect(mapMessage(raw, 1, 'user@ex.com').type).toBe('text')
  })

  it('sets type=other when text is null', () => {
    expect(mapMessage({ ...raw, text: null }, 1, 'user@ex.com').type).toBe('other')
  })

  it('converts date to unix seconds', () => {
    expect(mapMessage(raw, 1, 'user@ex.com').timestamp).toBe(Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000))
  })

  it('sets reply_to_external_id from inReplyTo', () => {
    const reply = makeRaw({ inReplyTo: 'parent@ex.com' })
    expect(mapMessage(reply, 1, 'user@ex.com').reply_to_external_id).toBe('parent@ex.com')
  })

  it('parses sender display name from From header', () => {
    expect(mapMessage(raw, 1, 'user@ex.com').sender_name).toBe('Alice')
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

describe('runBackfillImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('imports messages from INBOX and groups them into threads', async () => {
    const root = makeRaw({ messageId: 'root@ex.com', inReplyTo: null, subject: 'Thread' })
    const reply = makeRaw({ messageId: 'reply@ex.com', inReplyTo: 'root@ex.com', subject: 'Thread' })
    const client = makeMockClient([root, reply])

    await runBackfillImpl(client, 'user@ex.com')

    const chats = getChats()
    expect(chats).toHaveLength(1) // both in same thread
    expect(chats[0]!.platform).toBe('email')
  })

  it('imports from both INBOX and Sent', async () => {
    const inbox = makeRaw({ messageId: 'inbox@ex.com', subject: 'Inbox thread' })
    const sent = makeRaw({
      messageId: 'sent@ex.com',
      subject: 'Sent thread',
      from: 'user <user@ex.com>',
    })
    const client = makeMockClient([inbox], [sent])

    await runBackfillImpl(client, 'user@ex.com')
    expect(getChats()).toHaveLength(2)
  })

  it('is idempotent', async () => {
    const raw = makeRaw({ messageId: 'idem@ex.com' })
    const client = makeMockClient([raw])

    await runBackfillImpl(client, 'user@ex.com')
    await runBackfillImpl(client, 'user@ex.com')
    expect(getChats()).toHaveLength(1)
  })

  it('skips Sent folder gracefully when not found', async () => {
    const raw = makeRaw({ messageId: 'only-inbox@ex.com' })
    const client = makeMockClient([raw], [], null)

    await expect(runBackfillImpl(client, 'user@ex.com')).resolves.not.toThrow()
    expect(getChats()).toHaveLength(1)
  })
})

// ── syncIncremental: passes since to fetchFolder ──────────────────────────────

describe('runBackfillImpl with since criteria', () => {
  beforeEach(() => { initDb(':memory:') })

  it('passes { since } to fetchFolder when criteria provided', async () => {
    const since = new Date('2024-06-01T00:00:00Z')
    const raw = makeRaw({ messageId: 'since-test@ex.com' })
    const { client, fetchFolderSpy } = makeSpyClient([raw])

    await runBackfillImpl(client, 'user@ex.com', { since })

    // fetchFolder should be called with the criteria containing since
    expect(fetchFolderSpy).toHaveBeenCalledWith('INBOX', { since })
  })

  it('passes undefined criteria to fetchFolder in backfill (no since)', async () => {
    const raw = makeRaw({ messageId: 'no-since@ex.com' })
    const { client, fetchFolderSpy } = makeSpyClient([raw])

    await runBackfillImpl(client, 'user@ex.com')

    expect(fetchFolderSpy).toHaveBeenCalledWith('INBOX', undefined)
  })

  it('imports messages when since criteria is passed', async () => {
    const since = new Date('2024-01-01T00:00:00Z')
    const raw = makeRaw({ messageId: 'inc-email@ex.com', date: new Date('2024-06-01') })
    const client = makeMockClient([raw])

    await runBackfillImpl(client, 'user@ex.com', { since })
    expect(getChats()).toHaveLength(1)
  })
})

// ── skip on no plain-text ─────────────────────────────────────────────────────

describe('runBackfillImpl: no plain-text messages', () => {
  beforeEach(() => { initDb(':memory:') })

  it('does not insert a message row when text is null', async () => {
    const raw = makeRaw({ messageId: 'no-text@ex.com', text: null })
    const client = makeMockClient([raw])

    await runBackfillImpl(client, 'user@ex.com')

    const chats = getChats()
    // chat created for thread root, but no message inserted
    expect(chats).toHaveLength(1)
    const msgs = getMessages(chats[0]!.id!, 100)
    expect(msgs).toHaveLength(0)
  })

  it('does not insert message row when only message in thread has no text', async () => {
    const root = makeRaw({ messageId: 'root-no-text@ex.com', text: null })
    const client = makeMockClient([root])

    await runBackfillImpl(client, 'user@ex.com')
    expect(getChats()).toHaveLength(1)
    const msgs = getMessages(getChats()[0]!.id!, 100)
    expect(msgs).toHaveLength(0)
  })
})

// ── message without Message-ID skipped ───────────────────────────────────────

describe('runBackfillImpl: message without Message-ID', () => {
  beforeEach(() => { initDb(':memory:') })

  it('skips a message with empty messageId', async () => {
    const noId = makeRaw({ messageId: '', text: 'Has text but no id' })
    const client = makeMockClient([noId])

    await runBackfillImpl(client, 'user@ex.com')
    expect(getChats()).toHaveLength(0)
  })
})

// ── createEmailAdapter credential guard ──────────────────────────────────────

describe('createEmailAdapter credential guard', () => {
  it('identifies missing EMAIL_IMAP_HOST', async () => {
    const captured: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { captured.push(String(s)); return true })
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)

    const adapter = createEmailAdapter('default', {
      name: 'default',
      fields: { EMAIL_IMAP_USER: 'u', EMAIL_IMAP_PASS: 'p' },
    })

    await expect(adapter.runBackfill({} as never)).rejects.toThrow('exit')
    expect(captured.join('')).toContain('EMAIL_IMAP_HOST')
    vi.restoreAllMocks()
  })

  it('lists all three vars when all are missing', async () => {
    const captured: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { captured.push(String(s)); return true })
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)

    const adapter = createEmailAdapter('default', { name: 'default', fields: {} })

    await expect(adapter.runBackfill({} as never)).rejects.toThrow('exit')
    const out = captured.join('')
    expect(out).toContain('EMAIL_IMAP_HOST')
    expect(out).toContain('EMAIL_IMAP_USER')
    expect(out).toContain('EMAIL_IMAP_PASS')
    vi.restoreAllMocks()
  })
})
