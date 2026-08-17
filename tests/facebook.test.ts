import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBeeperFacebookClient, FACEBOOK_NETWORK, FACEBOOK_NETWORK_CANDIDATES } from '../src/platforms/facebook/client'
import type { BeeperFacebookClient } from '../src/platforms/facebook/client'
import { mapChat, mapMessage, runBackfillImpl, runIncrementalImpl } from '../src/platforms/facebook/sync'
import type { BeeperChat, BeeperMessage } from '../src/platforms/facebook/client'
import { initDb, getChats, getMessages, insertMessage, upsertChat, rebuildFtsIndex } from '../src/db'
import { loadRegistry } from '../src/account-registry'
import {
  handleListChats,
  handleListMessages,
  handleSearchMessages,
  handleFindChatByName,
} from '../src/query-handlers'

// ── mapChat ───────────────────────────────────────────────────────────────────

describe('mapChat', () => {
  const baseChat: BeeperChat = {
    id: 'chat-abc-123',
    accountID: 'fb-acct-1',
    network: 'facebookgo',
    title: 'Alice Smith',
    type: 'single',
    unreadCount: 0,
    participants: { hasMore: false, items: [], total: 1 },
  }

  it('maps id to external_id', () => {
    const result = mapChat(baseChat, 'my-account')
    expect(result.external_id).toBe('chat-abc-123')
  })

  it('maps title to name', () => {
    const result = mapChat(baseChat, 'my-account')
    expect(result.name).toBe('Alice Smith')
  })

  it('sets platform to facebook', () => {
    const result = mapChat(baseChat, 'my-account')
    expect(result.platform).toBe('facebook')
  })

  it('sets account from argument', () => {
    const result = mapChat(baseChat, 'my-account')
    expect(result.account).toBe('my-account')
  })

  it('maps single chat type to private', () => {
    const result = mapChat({ ...baseChat, type: 'single' }, 'acct')
    expect(result.type).toBe('private')
  })

  it('maps group chat type to group', () => {
    const result = mapChat({ ...baseChat, type: 'group' }, 'acct')
    expect(result.type).toBe('group')
  })

  it('sets username to null', () => {
    const result = mapChat(baseChat, 'acct')
    expect(result.username).toBeNull()
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const baseMessage: BeeperMessage = {
    id: 'msg-xyz-789',
    accountID: 'fb-acct-1',
    chatID: 'chat-abc-123',
    senderID: 'fb-user-1',
    sortKey: '1000',
    timestamp: '2024-06-15T10:30:00.000Z',
    senderName: 'Alice Smith',
    isSender: false,
    type: 'TEXT',
    text: 'Hello world',
  }

  it('maps id to external_id', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.external_id).toBe('msg-xyz-789')
  })

  it('sets chat_id from argument', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.chat_id).toBe(42)
  })

  it('maps senderName to sender_name', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.sender_name).toBe('Alice Smith')
  })

  it('converts ISO timestamp to unix seconds', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.timestamp).toBe(Math.floor(Date.parse('2024-06-15T10:30:00.000Z') / 1000))
  })

  it('maps isSender false to is_sender 0', () => {
    const result = mapMessage({ ...baseMessage, isSender: false }, 42)
    expect(result.is_sender).toBe(0)
  })

  it('maps isSender true to is_sender 1', () => {
    const result = mapMessage({ ...baseMessage, isSender: true }, 42)
    expect(result.is_sender).toBe(1)
  })

  it('maps linkedMessageID to reply_to_external_id', () => {
    const result = mapMessage({ ...baseMessage, linkedMessageID: 'parent-msg-id' }, 42)
    expect(result.reply_to_external_id).toBe('parent-msg-id')
  })

  it('sets reply_to_external_id to null when no linkedMessageID', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.reply_to_external_id).toBeNull()
  })

  it('maps text to text field', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.text).toBe('Hello world')
  })

  it('sets type to text when type is TEXT and text is non-empty', () => {
    const result = mapMessage({ ...baseMessage, type: 'TEXT', text: 'Hi' }, 42)
    expect(result.type).toBe('text')
  })

  it('sets type to image when type is IMAGE', () => {
    const result = mapMessage({ ...baseMessage, type: 'IMAGE' }, 42)
    expect(result.type).toBe('image')
  })

  it('sets type to other when text is empty string', () => {
    const result = mapMessage({ ...baseMessage, type: 'TEXT', text: '' }, 42)
    expect(result.type).toBe('other')
  })

  it('sets type to other when text is undefined', () => {
    const result = mapMessage({ ...baseMessage, type: 'TEXT', text: undefined }, 42)
    expect(result.type).toBe('other')
  })

  it('sets platform to facebook', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.platform).toBe('facebook')
  })

  it('sets media_file_path to null', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.media_file_path).toBeNull()
  })

  it('sets media_url to null', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.media_url).toBeNull()
  })

  it('sets media_width to null', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.media_width).toBeNull()
  })

  it('sets media_height to null', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.media_height).toBeNull()
  })

  it('sets ocr_text to null', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.ocr_text).toBeNull()
  })

  it('sets sender_name to null when senderName is undefined', () => {
    const result = mapMessage({ ...baseMessage, senderName: undefined }, 42)
    expect(result.sender_name).toBeNull()
  })

  it('sets text to null when text is undefined', () => {
    const result = mapMessage({ ...baseMessage, text: undefined }, 42)
    expect(result.text).toBeNull()
  })

  it('sets is_sender to 0 when isSender is undefined', () => {
    const result = mapMessage({ ...baseMessage, isSender: undefined }, 42)
    expect(result.is_sender).toBe(0)
  })
})

// ── createBeeperFacebookClient ────────────────────────────────────────────────

describe('createBeeperFacebookClient', () => {
  it('throws synchronously when accessToken is empty string', () => {
    expect(() => createBeeperFacebookClient('')).toThrow()
  })

  it('error message names BEEPER_ACCESS_TOKEN when token is empty', () => {
    expect(() => createBeeperFacebookClient('')).toThrow(/BEEPER_ACCESS_TOKEN/)
  })

  it('returns an object satisfying the BeeperFacebookClient interface shape', () => {
    const client: BeeperFacebookClient = createBeeperFacebookClient('fake-token')
    expect(typeof client.facebookAccountIds).toBe('function')
    expect(typeof client.listChats).toBe('function')
    expect(typeof client.listChatMessages).toBe('function')
    expect(typeof client.listNewChatMessages).toBe('function')
  })

  it('returned client.listChats() is an async generator', () => {
    const client = createBeeperFacebookClient('fake-token')
    const gen = client.listChats()
    expect(typeof gen[Symbol.asyncIterator]).toBe('function')
  })

  it('returned client.listChatMessages() is an async generator', () => {
    const client = createBeeperFacebookClient('fake-token')
    const gen = client.listChatMessages('some-chat-id')
    expect(typeof gen[Symbol.asyncIterator]).toBe('function')
  })

  it('returned client.listNewChatMessages() is an async generator', () => {
    const client = createBeeperFacebookClient('fake-token')
    const gen = client.listNewChatMessages('some-chat-id', new Date())
    expect(typeof gen[Symbol.asyncIterator]).toBe('function')
  })
})

// ── network-filter matching (candidates, case-insensitive) ───────────────────

vi.mock('@beeper/desktop-api', () => {
  const fakeAccounts = [
    { accountID: 'fb-default', network: 'facebookgo' },
  ]

  async function* makeAsyncIter<T>(items: T[]) {
    for (const item of items) yield item
  }

  const mockBeeper = {
    accounts: { list: vi.fn().mockResolvedValue(fakeAccounts) },
    chats: { search: vi.fn().mockReturnValue(makeAsyncIter([])) },
    messages: { search: vi.fn().mockReturnValue(makeAsyncIter([])) },
  }

  const BeeperDesktop = vi.fn().mockReturnValue(mockBeeper)
  class APIConnectionError extends Error {}
  class AuthenticationError extends Error {}

  // Each test overrides accounts.list via _mockBeeper before invoking the client.
  return { BeeperDesktop, APIConnectionError, AuthenticationError, _mockBeeper: mockBeeper }
})

describe('BeeperFacebookClient — network filter matching', () => {
  it('matches the pinned FACEBOOK_NETWORK value case-insensitively', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.accounts.list.mockResolvedValue([
      { accountID: 'fb-1', network: FACEBOOK_NETWORK.toUpperCase() },
    ])

    const client = createBeeperFacebookClient('test-token')
    const ids = await client.facebookAccountIds()
    expect(ids).toEqual(['fb-1'])
  })

  it.each(FACEBOOK_NETWORK_CANDIDATES)('matches candidate network "%s" case-insensitively', async (candidate) => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.accounts.list.mockResolvedValue([
      { accountID: 'fb-cand', network: candidate.toUpperCase() },
    ])

    const client = createBeeperFacebookClient('test-token')
    const ids = await client.facebookAccountIds()
    expect(ids).toEqual(['fb-cand'])
  })

  it('excludes a non-Messenger network', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.accounts.list.mockResolvedValue([
      { accountID: 'signal-1', network: 'signal' },
      { accountID: 'whatsapp-1', network: 'whatsapp' },
    ])

    const client = createBeeperFacebookClient('test-token')
    const ids = await client.facebookAccountIds()
    expect(ids).toEqual([])
  })

  it('listChats passes only Messenger accountIDs to chats.search', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.accounts.list.mockResolvedValue([
      { accountID: 'fb-1', network: FACEBOOK_NETWORK },
      { accountID: 'whatsapp-1', network: 'whatsapp' },
    ])
    _mockBeeper.chats.search.mockClear()

    const client = createBeeperFacebookClient('test-token')
    for await (const _chat of client.listChats()) { /* drain */ }

    expect(_mockBeeper.chats.search).toHaveBeenCalledOnce()
    const callArgs = _mockBeeper.chats.search.mock.calls[0][0]
    expect(callArgs.accountIDs).toEqual(['fb-1'])
    expect(callArgs.accountIDs).not.toContain('whatsapp-1')
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

function makeFacebookChat(overrides: Partial<BeeperChat> = {}): BeeperChat {
  return {
    id: 'chat-abc-123',
    accountID: 'fb-acct-1',
    network: 'facebookgo',
    title: 'Alice Smith',
    type: 'single',
    unreadCount: 0,
    participants: { hasMore: false, items: [], total: 1 },
    ...overrides,
  }
}

function makeFacebookMessage(overrides: Partial<BeeperMessage> = {}): BeeperMessage {
  return {
    id: 'msg-xyz-789',
    accountID: 'fb-acct-1',
    chatID: 'chat-abc-123',
    senderID: 'fb-user-1',
    sortKey: '1000',
    timestamp: '2024-06-15T10:30:00.000Z',
    senderName: 'Alice Smith',
    isSender: false,
    type: 'TEXT',
    text: 'Hello world',
    ...overrides,
  }
}

function makeMockFacebookClient(
  accountIds: string[],
  chats: BeeperChat[],
  messagesByChat: Map<string, BeeperMessage[]>,
): BeeperFacebookClient {
  return {
    facebookAccountIds: vi.fn().mockResolvedValue(accountIds),
    listChats: vi.fn(() => asyncGen(chats)),
    listChatMessages: vi.fn((chatId: string) => asyncGen(messagesByChat.get(chatId) ?? [])),
    listNewChatMessages: vi.fn(() => asyncGen([])),
  }
}

describe('runBackfillImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('upserts chats and inserts messages from mock client', async () => {
    const chat1 = makeFacebookChat({ id: 'chat-1', title: 'Alice' })
    const chat2 = makeFacebookChat({ id: 'chat-2', title: 'Bob', type: 'group' })
    const msg1 = makeFacebookMessage({ id: 'msg-1', chatID: 'chat-1' })
    const msg2 = makeFacebookMessage({ id: 'msg-2', chatID: 'chat-1' })
    const msg3 = makeFacebookMessage({ id: 'msg-3', chatID: 'chat-2' })

    const msgMap = new Map([
      ['chat-1', [msg1, msg2]],
      ['chat-2', [msg3]],
    ])
    const client = makeMockFacebookClient(['fb-acct-1'], [chat1, chat2], msgMap)

    await runBackfillImpl(client, 'test-account')

    const chats = getChats()
    expect(chats).toHaveLength(2)
    expect(chats.every(c => c.platform === 'facebook')).toBe(true)

    const chat1Row = chats.find(c => c.external_id === 'chat-1')!
    expect(chat1Row).toBeDefined()
    const msgs = getMessages(chat1Row.id as unknown as number, 100)
    expect(msgs).toHaveLength(2)
  })

  it('is idempotent — second run produces no additional rows', async () => {
    const chat = makeFacebookChat({ id: 'chat-idem' })
    const msg = makeFacebookMessage({ id: 'msg-idem', chatID: 'chat-idem' })
    const msgMap = new Map([['chat-idem', [msg]]])
    const client = makeMockFacebookClient(['fb-acct-1'], [chat], msgMap)

    await runBackfillImpl(client, 'test-account')
    await runBackfillImpl(client, 'test-account')

    expect(getChats()).toHaveLength(1)
    const chatRow = getChats()[0]!
    const msgs = getMessages(chatRow.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
  })

  it('skips deleted and hidden messages', async () => {
    const chat = makeFacebookChat({ id: 'chat-del' })
    const activeMsg = makeFacebookMessage({ id: 'msg-active', chatID: 'chat-del' })
    const deletedMsg = makeFacebookMessage({ id: 'msg-deleted', chatID: 'chat-del', isDeleted: true })
    const hiddenMsg = makeFacebookMessage({ id: 'msg-hidden', chatID: 'chat-del', isHidden: true })
    const msgMap = new Map([['chat-del', [activeMsg, deletedMsg, hiddenMsg]]])
    const client = makeMockFacebookClient(['fb-acct-1'], [chat], msgMap)

    await runBackfillImpl(client, 'test-account')

    const chatRow = getChats()[0]!
    const msgs = getMessages(chatRow.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.external_id).toBe('msg-active')
  })

  it('continues processing remaining chats when one chat message fetch throws', async () => {
    const chat1 = makeFacebookChat({ id: 'chat-err', title: 'Error Chat' })
    const chat2 = makeFacebookChat({ id: 'chat-ok', title: 'OK Chat' })
    const msg = makeFacebookMessage({ id: 'msg-ok', chatID: 'chat-ok' })

    const client: BeeperFacebookClient = {
      facebookAccountIds: vi.fn().mockResolvedValue(['fb-acct-1']),
      listChats: vi.fn(() => asyncGen([chat1, chat2])),
      listChatMessages: vi.fn((chatId: string) => {
        if (chatId === 'chat-err') {
          return (async function* () { throw new Error('network error') })()
        }
        return asyncGen([msg])
      }),
      listNewChatMessages: vi.fn(() => asyncGen([])),
    }

    await expect(runBackfillImpl(client, 'test-account')).resolves.toBeUndefined()

    const chats = getChats()
    const okChat = chats.find(c => c.external_id === 'chat-ok')
    expect(okChat).toBeDefined()
    const msgs = getMessages(okChat!.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
  })

  it('completes with no rows and no error when no Messenger accounts', async () => {
    const client = makeMockFacebookClient([], [], new Map())
    await expect(runBackfillImpl(client, 'test-account')).resolves.toBeUndefined()
    expect(getChats()).toHaveLength(0)
  })
})

// ── createFacebookAdapter credential guard ────────────────────────────────────

describe('createFacebookAdapter — empty BEEPER_ACCESS_TOKEN guard', () => {
  it('calls process.exit(1) and writes to stderr naming Beeper Desktop when token is empty', async () => {
    const { createFacebookAdapter } = await import('../src/platforms/facebook/sync')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const adapter = createFacebookAdapter('default', { name: 'default', fields: { BEEPER_ACCESS_TOKEN: '' } })
    await adapter.runBackfill({} as any)

    expect(exitSpy).toHaveBeenCalledWith(1)
    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(stderrOutput).toMatch(/Beeper Desktop/)

    exitSpy.mockRestore()
    stderrSpy.mockRestore()
  })
})

// ── runIncrementalImpl integration ────────────────────────────────────────────

describe('runIncrementalImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  const since = new Date('2024-06-15T00:00:00.000Z')

  it('calls listChatMessages (full history) for a new chat with no prior messages', async () => {
    const chat = makeFacebookChat({ id: 'chat-new', title: 'New Chat' })
    const msg = makeFacebookMessage({ id: 'msg-new', chatID: 'chat-new' })
    const msgMap = new Map([['chat-new', [msg]]])
    const client = makeMockFacebookClient(['fb-acct-1'], [chat], msgMap)

    await runIncrementalImpl(client, since, 'test-account')

    expect(client.listChatMessages).toHaveBeenCalledWith('chat-new')
    expect(client.listNewChatMessages).not.toHaveBeenCalled()

    const chats = getChats()
    expect(chats).toHaveLength(1)
    const msgs = getMessages(chats[0]!.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.external_id).toBe('msg-new')
  })

  it('calls listNewChatMessages for a returning chat that already has messages', async () => {
    const chat = makeFacebookChat({ id: 'chat-returning', title: 'Returning Chat' })

    const chatId = upsertChat(mapChat(chat, 'test-account'))
    const priorMsg = makeFacebookMessage({ id: 'msg-prior', chatID: 'chat-returning' })
    insertMessage(mapMessage(priorMsg, chatId))

    const newMsg = makeFacebookMessage({ id: 'msg-new', chatID: 'chat-returning', timestamp: '2024-06-16T10:00:00.000Z' })
    const client: BeeperFacebookClient = {
      facebookAccountIds: vi.fn().mockResolvedValue(['fb-acct-1']),
      listChats: vi.fn(() => asyncGen([chat])),
      listChatMessages: vi.fn(() => asyncGen([])),
      listNewChatMessages: vi.fn(() => asyncGen([newMsg])),
    }

    await runIncrementalImpl(client, since, 'test-account')

    expect(client.listNewChatMessages).toHaveBeenCalledWith('chat-returning', since)
    expect(client.listChatMessages).not.toHaveBeenCalled()

    const msgs = getMessages(chatId, 100)
    expect(msgs).toHaveLength(2)
    expect(msgs.some(m => m.external_id === 'msg-new')).toBe(true)
  })

  it('continues processing remaining chats when one chat throws (per-chat error isolation)', async () => {
    const chat1 = makeFacebookChat({ id: 'chat-err', title: 'Error Chat' })
    const chat2 = makeFacebookChat({ id: 'chat-ok', title: 'OK Chat' })
    const msg = makeFacebookMessage({ id: 'msg-ok', chatID: 'chat-ok' })

    const client: BeeperFacebookClient = {
      facebookAccountIds: vi.fn().mockResolvedValue(['fb-acct-1']),
      listChats: vi.fn(() => asyncGen([chat1, chat2])),
      listChatMessages: vi.fn((chatId: string) => {
        if (chatId === 'chat-err') {
          return (async function* () { throw new Error('network error') })()
        }
        return asyncGen([msg])
      }),
      listNewChatMessages: vi.fn(() => asyncGen([])),
    }

    await expect(runIncrementalImpl(client, since, 'test-account')).resolves.toBeUndefined()

    const chats = getChats()
    const okChat = chats.find(c => c.external_id === 'chat-ok')
    expect(okChat).toBeDefined()
    const msgs = getMessages(okChat!.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
  })

  it('completes with no rows and no error when there are no chats', async () => {
    const client = makeMockFacebookClient([], [], new Map())
    await expect(runIncrementalImpl(client, since, 'test-account')).resolves.toBeUndefined()
    expect(getChats()).toHaveLength(0)
  })
})

// ── Query parity: Facebook Messenger data is returned by existing query handlers ─────

describe('Facebook Messenger platform query parity', () => {
  // Req 6.1-6.5: Messenger data must be retrievable via standard MCP/CLI query paths
  // with no modifications to those tools.

  let fbChatId: number

  beforeEach(() => {
    initDb(':memory:')

    fbChatId = upsertChat({
      external_id: 'fb-chat-1',
      account: 'default',
      name: 'Alice',
      type: 'private',
      username: null,
      platform: 'facebook',
    })

    insertMessage({
      external_id: 'fb-msg-1',
      chat_id: fbChatId,
      sender_id: null,
      sender_name: 'Alice',
      text: 'Hello from Messenger',
      type: 'text',
      timestamp: 1704067200,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'facebook',
    })

    rebuildFtsIndex()
  })

  it('handleListChats returns the synced Messenger chat', () => {
    const chats = handleListChats()
    const fbChat = chats.find(c => c.platform === 'facebook')
    expect(fbChat).toBeDefined()
    expect(fbChat!.name).toBe('Alice')
  })

  it('handleFindChatByName resolves the Messenger chat by name', () => {
    const results = handleFindChatByName('Alice')
    const fbChat = results.find(c => c.platform === 'facebook')
    expect(fbChat).toBeDefined()
    expect(fbChat!.name).toBe('Alice')
  })

  it('handleListMessages returns Messenger messages using only standard chatId argument', () => {
    const { messages } = handleListMessages(fbChatId)
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every(m => m.platform === 'facebook')).toBe(true)
    expect(messages.some(m => m.text === 'Hello from Messenger')).toBe(true)
  })

  it('handleSearchMessages returns Messenger messages without Messenger-specific arguments', () => {
    const results = handleSearchMessages('Hello from Messenger')
    const fbMsg = results.find(m => m.platform === 'facebook')
    expect(fbMsg).toBeDefined()
    expect(fbMsg!.text).toBe('Hello from Messenger')
  })

  it('rebuildFtsIndex then handleSearchMessages includes Messenger message text in full-text search', () => {
    rebuildFtsIndex()
    const results = handleSearchMessages('Messenger')
    expect(results.some(m => m.platform === 'facebook' && m.text !== null && m.text.includes('Messenger'))).toBe(true)
  })

  it('handleListChats with platform filter returns only Messenger chats', () => {
    upsertChat({
      external_id: 'tg-chat-1',
      account: 'default',
      name: 'TelegramUser',
      type: 'private',
      username: null,
      platform: 'telegram',
    })
    const fbChats = handleListChats({ platform: 'facebook' })
    expect(fbChats.every(c => c.platform === 'facebook')).toBe(true)
    expect(fbChats.some(c => c.name === 'Alice')).toBe(true)
    expect(fbChats.some(c => c.platform === 'telegram')).toBe(false)
  })
})

// ── Legacy env-var registry consistency (R8) ──────────────────────────────────

describe('loadRegistry — legacy single-account BEEPER_ACCESS_TOKEN mode', () => {
  it('lists a default account for both facebook and signal when BEEPER_ACCESS_TOKEN is set and no config file exists', () => {
    const registry = loadRegistry('/nonexistent/khipu.config.json', { BEEPER_ACCESS_TOKEN: 'tok' } as NodeJS.ProcessEnv)
    expect(registry.listAccounts('facebook')).toEqual(['default'])
    expect(registry.listAccounts('signal')).toEqual(['default'])
    expect(registry.credentialsFor('facebook', 'default').fields['BEEPER_ACCESS_TOKEN']).toBe('tok')
  })

  it('lists no accounts for facebook or signal when BEEPER_ACCESS_TOKEN is unset', () => {
    const registry = loadRegistry('/nonexistent/khipu.config.json', {} as NodeJS.ProcessEnv)
    expect(registry.listAccounts('facebook')).toEqual([])
    expect(registry.listAccounts('signal')).toEqual([])
  })
})
