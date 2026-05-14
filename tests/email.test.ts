import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, getChats } from '../src/db'
import {
  hashStr,
  resolveThreadChatId,
  mapMessage,
  runBackfillImpl,
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

// ── resolveThreadChatId ───────────────────────────────────────────────────────

describe('resolveThreadChatId', () => {
  it('creates new chatId for root message', () => {
    const map = new Map<string, number>()
    const chatId = resolveThreadChatId('root@ex.com', null, map)
    expect(chatId).toBe(hashStr('root@ex.com'))
  })

  it('reply inherits parent chatId', () => {
    const map = new Map<string, number>()
    const rootId = resolveThreadChatId('root@ex.com', null, map)
    const replyId = resolveThreadChatId('reply@ex.com', 'root@ex.com', map)
    expect(replyId).toBe(rootId)
  })

  it('stores the reply messageId in the map', () => {
    const map = new Map<string, number>()
    resolveThreadChatId('root@ex.com', null, map)
    resolveThreadChatId('reply@ex.com', 'root@ex.com', map)
    expect(map.has('reply@ex.com')).toBe(true)
  })

  it('unknown inReplyTo creates a new root', () => {
    const map = new Map<string, number>()
    const id = resolveThreadChatId('orphan@ex.com', 'unknown@ex.com', map)
    expect(id).toBe(hashStr('orphan@ex.com'))
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
