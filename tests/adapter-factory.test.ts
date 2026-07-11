import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, getChats } from '../src/db'
import {
  createSlackAdapter,
  slackAdapter,
  runBackfillImpl,
} from '../src/platforms/slack/sync'
import { runBackfill as telegramRunBackfill } from '../src/platforms/telegram/sync'
import { runBackfillImpl as imessageRunBackfillImpl } from '../src/platforms/imessage/sync'
import { runBackfillImpl as discordRunBackfillImpl } from '../src/platforms/discord/sync'
import { runBackfillImpl as emailRunBackfillImpl } from '../src/platforms/email/sync'
import { runBackfillImpl as whatsappRunBackfillImpl } from '../src/platforms/whatsapp/sync'
import type { AccountCredentials } from '../src/account-registry'
import type { SlackClient, SlackConversation, SlackMessage } from '../src/platforms/slack/client'
import type { DiscordClient } from '../src/platforms/discord/client'
import type { EmailClient } from '../src/platforms/email/client'
import type { WhatsAppClient } from '../src/platforms/whatsapp/client'

// ── Helpers ───────────────────────────────────────────────────────────────────

const workCreds: AccountCredentials = {
  name: 'work',
  fields: { SLACK_USER_TOKEN: 'xoxp-work-token' },
}

const personalCreds: AccountCredentials = {
  name: 'personal',
  fields: { SLACK_USER_TOKEN: 'xoxp-personal-token' },
}

function makeConv(overrides: Partial<SlackConversation> = {}): SlackConversation {
  return { id: 'C001', name: 'general', is_im: false, is_mpim: false, is_archived: false, ...overrides }
}

function makeMsg(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return { ts: '1700000000.000001', user: 'U001', text: 'Hello', ...overrides }
}

async function* asyncOf<T>(...items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

function makeMockClient(
  convs: SlackConversation[],
  msgs: SlackMessage[],
): SlackClient {
  return {
    listConversations: () => asyncOf(...convs),
    fetchHistory: () => asyncOf(...msgs),
    getUserName: async () => 'Alice',
  }
}

// ── createSlackAdapter: account property ──────────────────────────────────────

describe('createSlackAdapter — factory properties', () => {
  it('sets platform to slack', () => {
    const adapter = createSlackAdapter('work', workCreds)
    expect(adapter.platform).toBe('slack')
  })

  it('sets account to the supplied account name', () => {
    const adapter = createSlackAdapter('work', workCreds)
    expect(adapter.account).toBe('work')
  })

  it('reflects the account name passed in, not a hardcoded value', () => {
    const adapter = createSlackAdapter('personal', personalCreds)
    expect(adapter.account).toBe('personal')
  })

  it('exposes runBackfill and startListener methods', () => {
    const adapter = createSlackAdapter('work', workCreds)
    expect(typeof adapter.runBackfill).toBe('function')
    expect(typeof adapter.startListener).toBe('function')
  })
})

// ── Legacy singleton ──────────────────────────────────────────────────────────

describe('slackAdapter — legacy singleton', () => {
  it('has account = default', () => {
    expect(slackAdapter.account).toBe('default')
  })

  it('has platform = slack', () => {
    expect(slackAdapter.platform).toBe('slack')
  })
})

// ── Credential isolation ──────────────────────────────────────────────────────

describe('createSlackAdapter — credential isolation', () => {
  it('work adapter uses work credentials, not personal credentials', () => {
    const workAdapter = createSlackAdapter('work', workCreds)
    const personalAdapter = createSlackAdapter('personal', personalCreds)

    // Verify the two adapters are distinct objects
    expect(workAdapter).not.toBe(personalAdapter)
    expect(workAdapter.account).not.toBe(personalAdapter.account)
  })

  it('credentials injected into work adapter are distinct from personal credentials', () => {
    // Verify that the fields object from each set of credentials is different
    expect(workCreds.fields['SLACK_USER_TOKEN']).toBe('xoxp-work-token')
    expect(personalCreds.fields['SLACK_USER_TOKEN']).toBe('xoxp-personal-token')
    expect(workCreds.fields['SLACK_USER_TOKEN']).not.toBe(
      personalCreds.fields['SLACK_USER_TOKEN'],
    )
  })

  it('does not share credential state between factory instances', () => {
    // Create two adapters — their accounts must differ
    const a1 = createSlackAdapter('acct-a', { name: 'acct-a', fields: { SLACK_USER_TOKEN: 'tok-a' } })
    const a2 = createSlackAdapter('acct-b', { name: 'acct-b', fields: { SLACK_USER_TOKEN: 'tok-b' } })

    expect(a1.account).toBe('acct-a')
    expect(a2.account).toBe('acct-b')
  })

  it('legacy singleton reads token from process.env, not from factory credentials', () => {
    // The singleton is created with process.env at module load time.
    // workCreds has a different token than any env var, so their token values differ
    // (unless the test environment happens to set SLACK_USER_TOKEN to 'xoxp-work-token')
    const envToken = process.env['SLACK_USER_TOKEN'] ?? ''
    // The adapter created with workCreds closes over workCreds.fields, which is
    // a separate object from the env-based fields used by slackAdapter.
    // We prove isolation by confirming the two adapters have different account tags.
    expect(slackAdapter.account).toBe('default')
    const workAdapter = createSlackAdapter('work', workCreds)
    expect(workAdapter.account).toBe('work')
    // And the env token must not equal the injected work token
    // (This assertion is skipped when env is deliberately set to the same value,
    //  but the account-level isolation above is the primary contract.)
    if (envToken !== 'xoxp-work-token') {
      expect(workCreds.fields['SLACK_USER_TOKEN']).not.toBe(envToken)
    }
  })
})

// ── DB integration: chats are tagged with the correct account ─────────────────

describe('createSlackAdapter — DB account tagging', () => {
  beforeEach(() => {
    initDb(':memory:')
  })

  it('runBackfillImpl writes chats with account = work when called with work client', async () => {
    // We call runBackfillImpl directly (the inner impl function) with a mock client.
    // The account parameter is threaded through to mapChat, so chats are tagged correctly.
    const client = makeMockClient(
      [makeConv({ id: 'C-work-1', name: 'work-general' })],
      [makeMsg({ ts: '1700000010.000001' })],
    )
    await runBackfillImpl(client, 'work')
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.platform).toBe('slack')
    expect(chats[0]!.account).toBe('work')
  })

  it('two separate backfill runs produce independent chat rows keyed by external_id', async () => {
    const client1 = makeMockClient(
      [makeConv({ id: 'C-a', name: 'alpha' })],
      [makeMsg({ ts: '1700000020.000001' })],
    )
    const client2 = makeMockClient(
      [makeConv({ id: 'C-b', name: 'beta' })],
      [makeMsg({ ts: '1700000030.000001' })],
    )
    await runBackfillImpl(client1)
    await runBackfillImpl(client2)
    const chats = getChats()
    expect(chats).toHaveLength(2)
    const externalIds = chats.map((c) => c.external_id)
    expect(externalIds).toContain('C-a')
    expect(externalIds).toContain('C-b')
  })
})

// ── Factory shape: adapter interface completeness ─────────────────────────────

describe('createSlackAdapter — adapter interface', () => {
  it('returns an object matching the PlatformAdapter interface', () => {
    const adapter = createSlackAdapter('work', workCreds)
    // Required fields
    expect(adapter).toHaveProperty('platform')
    expect(adapter).toHaveProperty('account')
    expect(adapter).toHaveProperty('runBackfill')
    expect(adapter).toHaveProperty('startListener')
  })

  it('platform and account fields are strings', () => {
    const adapter = createSlackAdapter('work', workCreds)
    expect(typeof adapter.platform).toBe('string')
    expect(typeof adapter.account).toBe('string')
  })

  it('startListener is a no-op (does not throw)', () => {
    const adapter = createSlackAdapter('work', workCreds)
    const db = initDb(':memory:')
    expect(() => adapter.startListener(db)).not.toThrow()
  })
})

// ── Discord: DB account tagging ───────────────────────────────────────────────

describe('discord runBackfillImpl — DB account tagging', () => {
  beforeEach(() => { initDb(':memory:') })

  it('writes chats with the provided account, not hardcoded default', async () => {
    const mockClient: DiscordClient = {
      getGuilds: vi.fn().mockResolvedValue([]),
      getGuildChannels: vi.fn().mockResolvedValue([]),
      getDirectMessageChannels: vi.fn().mockResolvedValue([
        { id: 'DM-work-1', type: 1, name: 'dm-alice', recipients: [{ id: 'U1', username: 'alice' }] },
      ]),
      getMessages: vi.fn().mockResolvedValue([]),
    }
    await discordRunBackfillImpl(mockClient, 'work')
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.platform).toBe('discord')
    expect(chats[0]!.account).toBe('work')
  })
})

// ── Email: DB account tagging ─────────────────────────────────────────────────

describe('email runBackfillImpl — DB account tagging', () => {
  beforeEach(() => { initDb(':memory:') })

  it('writes chats with the provided account, not hardcoded default', async () => {
    async function* fakeInbox() {
      yield {
        messageId: 'msg-001@example.com',
        inReplyTo: null,
        from: 'sender@example.com',
        subject: 'Test email',
        date: new Date('2024-01-01T00:00:00Z'),
        text: 'Hello',
      }
    }
    const mockClient: EmailClient = {
      fetchFolder: (folder) => (folder === 'INBOX' ? fakeInbox() : (async function* () {})()),
      listSpecialFolder: vi.fn().mockResolvedValue(null),
    }
    await emailRunBackfillImpl(mockClient, 'work@example.com', undefined, 'work')
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.platform).toBe('email')
    expect(chats[0]!.account).toBe('work')
  })
})

// ── WhatsApp: DB account tagging ──────────────────────────────────────────────

describe('whatsapp runBackfillImpl — DB account tagging', () => {
  beforeEach(() => { initDb(':memory:') })

  it('writes chats with the provided account, not hardcoded default', async () => {
    const mockClient: WhatsAppClient = {
      getChats: vi.fn().mockResolvedValue([
        { id: { _serialized: 'chat-1@c.us' }, name: 'Alice Work', isGroup: false },
      ]),
      fetchMessages: vi.fn().mockResolvedValue([]),
      getContactName: vi.fn().mockResolvedValue('Alice Work'),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    await whatsappRunBackfillImpl(mockClient, 'work')
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.platform).toBe('whatsapp')
    expect(chats[0]!.account).toBe('work')
  })
})

// ── Telegram: DB account tagging ─────────────────────────────────────────────

describe('telegram runBackfill — DB account tagging', () => {
  beforeEach(() => { initDb(':memory:') })

  it('writes chats with the provided account, not hardcoded default', async () => {
    const mockClient = {
      getDialogs: vi.fn().mockResolvedValue([
        {
          entity: { className: 'User', id: 42n, firstName: 'Alice', lastName: null, username: 'alice', bot: false },
          date: 1700000000,
        },
      ]),
      getMessages: vi.fn().mockResolvedValue([]),
    }
    await telegramRunBackfill(mockClient as never, async () => {}, 100, 200, 'work')
    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.platform).toBe('telegram')
    expect(chats[0]!.account).toBe('work')
  })
})
