import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBeeperSignalClient } from '../src/platforms/signal/client'
import type { BeeperSignalClient } from '../src/platforms/signal/client'
import { mapChat, mapMessage, runBackfillImpl, runIncrementalImpl } from '../src/platforms/signal/sync'
import type { BeeperChat, BeeperMessage } from '../src/platforms/signal/client'
import { initDb, getChats, getMessages, insertMessage, upsertChat, rebuildFtsIndex } from '../src/db'
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
    accountID: 'signal-acct-1',
    network: 'signal',
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

  it('sets platform to signal', () => {
    const result = mapChat(baseChat, 'my-account')
    expect(result.platform).toBe('signal')
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
    accountID: 'signal-acct-1',
    chatID: 'chat-abc-123',
    senderID: '@user:signal',
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

  it('sets platform to signal', () => {
    const result = mapMessage(baseMessage, 42)
    expect(result.platform).toBe('signal')
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

// ── createBeeperSignalClient ──────────────────────────────────────────────────

describe('createBeeperSignalClient', () => {
  it('throws synchronously when accessToken is empty string', () => {
    expect(() => createBeeperSignalClient('')).toThrow()
  })

  it('throws synchronously when accessToken is empty string (error names BEEPER_ACCESS_TOKEN)', () => {
    // Guard uses !accessToken (falsy check); empty string '' is falsy and throws.
    // Whitespace ' ' is truthy and does NOT throw — that is intentional per the guard.
    expect(() => createBeeperSignalClient('')).toThrow(/BEEPER_ACCESS_TOKEN/)
  })

  it('returns an object satisfying the BeeperSignalClient interface shape', () => {
    const client: BeeperSignalClient = createBeeperSignalClient('fake-token')
    expect(typeof client.signalAccountIds).toBe('function')
    expect(typeof client.listChats).toBe('function')
    expect(typeof client.listChatMessages).toBe('function')
    expect(typeof client.listNewChatMessages).toBe('function')
  })

  it('returned client.listChats() is an async generator', () => {
    const client = createBeeperSignalClient('fake-token')
    const gen = client.listChats()
    expect(typeof gen[Symbol.asyncIterator]).toBe('function')
  })

  it('returned client.listChatMessages() is an async generator', () => {
    const client = createBeeperSignalClient('fake-token')
    const gen = client.listChatMessages('some-chat-id')
    expect(typeof gen[Symbol.asyncIterator]).toBe('function')
  })

  it('returned client.listNewChatMessages() is an async generator', () => {
    const client = createBeeperSignalClient('fake-token')
    const gen = client.listNewChatMessages('some-chat-id', new Date())
    expect(typeof gen[Symbol.asyncIterator]).toBe('function')
  })

  it('error message names BEEPER_ACCESS_TOKEN when token is empty', () => {
    expect(() => createBeeperSignalClient('')).toThrow(/BEEPER_ACCESS_TOKEN/)
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

function makeSignalChat(overrides: Partial<BeeperChat> = {}): BeeperChat {
  return {
    id: 'chat-abc-123',
    accountID: 'signal-acct-1',
    network: 'signal',
    title: 'Alice Smith',
    type: 'single',
    unreadCount: 0,
    participants: { hasMore: false, items: [], total: 1 },
    ...overrides,
  }
}

function makeSignalMessage(overrides: Partial<BeeperMessage> = {}): BeeperMessage {
  return {
    id: 'msg-xyz-789',
    accountID: 'signal-acct-1',
    chatID: 'chat-abc-123',
    senderID: '@user:signal',
    sortKey: '1000',
    timestamp: '2024-06-15T10:30:00.000Z',
    senderName: 'Alice Smith',
    isSender: false,
    type: 'TEXT',
    text: 'Hello world',
    ...overrides,
  }
}

function makeMockSignalClient(
  accountIds: string[],
  chats: BeeperChat[],
  messagesByChat: Map<string, BeeperMessage[]>,
): BeeperSignalClient {
  return {
    signalAccountIds: vi.fn().mockResolvedValue(accountIds),
    listChats: vi.fn(() => asyncGen(chats)),
    listChatMessages: vi.fn((chatId: string) => asyncGen(messagesByChat.get(chatId) ?? [])),
    listNewChatMessages: vi.fn(() => asyncGen([])),
  }
}

describe('runBackfillImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('upserts chats and inserts messages from mock client', async () => {
    const chat1 = makeSignalChat({ id: 'chat-1', title: 'Alice' })
    const chat2 = makeSignalChat({ id: 'chat-2', title: 'Bob', type: 'group' })
    const msg1 = makeSignalMessage({ id: 'msg-1', chatID: 'chat-1' })
    const msg2 = makeSignalMessage({ id: 'msg-2', chatID: 'chat-1' })
    const msg3 = makeSignalMessage({ id: 'msg-3', chatID: 'chat-2' })

    const msgMap = new Map([
      ['chat-1', [msg1, msg2]],
      ['chat-2', [msg3]],
    ])
    const client = makeMockSignalClient(['signal-acct-1'], [chat1, chat2], msgMap)

    await runBackfillImpl(client, 'test-account')

    const chats = getChats()
    expect(chats).toHaveLength(2)
    expect(chats.every(c => c.platform === 'signal')).toBe(true)

    const chat1Row = chats.find(c => c.external_id === 'chat-1')!
    expect(chat1Row).toBeDefined()
    const msgs = getMessages(chat1Row.id as unknown as number, 100)
    expect(msgs).toHaveLength(2)
  })

  it('is idempotent — second run produces no additional rows', async () => {
    const chat = makeSignalChat({ id: 'chat-idem' })
    const msg = makeSignalMessage({ id: 'msg-idem', chatID: 'chat-idem' })
    const msgMap = new Map([['chat-idem', [msg]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat], msgMap)

    await runBackfillImpl(client, 'test-account')
    await runBackfillImpl(client, 'test-account')

    expect(getChats()).toHaveLength(1)
    const chatRow = getChats()[0]!
    const msgs = getMessages(chatRow.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
  })

  it('skips deleted messages', async () => {
    const chat = makeSignalChat({ id: 'chat-del' })
    const activeMsg = makeSignalMessage({ id: 'msg-active', chatID: 'chat-del' })
    const deletedMsg = makeSignalMessage({ id: 'msg-deleted', chatID: 'chat-del', isDeleted: true })
    const hiddenMsg = makeSignalMessage({ id: 'msg-hidden', chatID: 'chat-del', isHidden: true })
    const msgMap = new Map([['chat-del', [activeMsg, deletedMsg, hiddenMsg]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat], msgMap)

    await runBackfillImpl(client, 'test-account')

    const chatRow = getChats()[0]!
    const msgs = getMessages(chatRow.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.external_id).toBe('msg-active')
  })

  it('continues processing remaining chats when one chat message fetch throws', async () => {
    const chat1 = makeSignalChat({ id: 'chat-err', title: 'Error Chat' })
    const chat2 = makeSignalChat({ id: 'chat-ok', title: 'OK Chat' })
    const msg = makeSignalMessage({ id: 'msg-ok', chatID: 'chat-ok' })

    const client: BeeperSignalClient = {
      signalAccountIds: vi.fn().mockResolvedValue(['signal-acct-1']),
      listChats: vi.fn(() => asyncGen([chat1, chat2])),
      listChatMessages: vi.fn((chatId: string) => {
        if (chatId === 'chat-err') {
          return (async function* () { throw new Error('network error') })()
        }
        return asyncGen([msg])
      }),
      listNewChatMessages: vi.fn(() => asyncGen([])),
    }

    // Should not throw
    await expect(runBackfillImpl(client, 'test-account')).resolves.toBeUndefined()

    // OK chat should still be processed
    const chats = getChats()
    const okChat = chats.find(c => c.external_id === 'chat-ok')
    expect(okChat).toBeDefined()
    const msgs = getMessages(okChat!.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
  })

  it('completes with no rows and no error when no Signal accounts', async () => {
    const client = makeMockSignalClient([], [], new Map())
    await expect(runBackfillImpl(client, 'test-account')).resolves.toBeUndefined()
    expect(getChats()).toHaveLength(0)
  })
})

// ── accountIDs filter passthrough (mock-based integration) ───────────────────

vi.mock('@beeper/desktop-api', () => {
  const fakeAccounts = [
    { accountID: 'signal-acct-1', network: 'signal' },
    { accountID: 'whatsapp-acct-1', network: 'whatsapp' },
  ]

  const fakeChats = [{ id: 'chat-1', name: 'Test Chat' }]
  const fakeMessages = [{ id: 'msg-1', text: 'hello', timestamp: '2024-01-01T00:00:00Z' }]

  async function* makeAsyncIter<T>(items: T[]) {
    for (const item of items) yield item
  }

  const mockBeeper = {
    accounts: {
      list: vi.fn().mockResolvedValue(fakeAccounts),
    },
    chats: {
      search: vi.fn().mockReturnValue(makeAsyncIter(fakeChats)),
    },
    messages: {
      search: vi.fn().mockReturnValue(makeAsyncIter(fakeMessages)),
    },
  }

  const BeeperDesktop = vi.fn().mockReturnValue(mockBeeper)
  class APIConnectionError extends Error {}
  class AuthenticationError extends Error {}

  return { BeeperDesktop, APIConnectionError, AuthenticationError, _mockBeeper: mockBeeper }
})

describe('BeeperSignalClient — accountIDs filter passthrough', () => {
  it('listChats passes only Signal accountIDs to chats.search', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.chats.search.mockClear()

    const client = createBeeperSignalClient('test-token')
    const results: unknown[] = []
    for await (const chat of client.listChats()) {
      results.push(chat)
    }

    expect(_mockBeeper.chats.search).toHaveBeenCalledOnce()
    const callArgs = _mockBeeper.chats.search.mock.calls[0][0]
    expect(callArgs).toHaveProperty('accountIDs')
    expect(callArgs.accountIDs).toEqual(['signal-acct-1'])
    expect(callArgs.accountIDs).not.toContain('whatsapp-acct-1')
  })

  it('listChatMessages passes Signal accountIDs to messages.search', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.messages.search.mockClear()

    const client = createBeeperSignalClient('test-token')
    const results: unknown[] = []
    for await (const msg of client.listChatMessages('chat-1')) {
      results.push(msg)
    }

    expect(_mockBeeper.messages.search).toHaveBeenCalledOnce()
    const callArgs = _mockBeeper.messages.search.mock.calls[0][0]
    expect(callArgs).toHaveProperty('accountIDs')
    expect(callArgs.accountIDs).toEqual(['signal-acct-1'])
    expect(callArgs).toHaveProperty('chatIDs', ['chat-1'])
    expect(callArgs.accountIDs).not.toContain('whatsapp-acct-1')
  })
})

// ── createSignalAdapter credential guard ─────────────────────────────────────

describe('createSignalAdapter — empty BEEPER_ACCESS_TOKEN guard', () => {
  it('calls process.exit(1) and writes to stderr naming Beeper Desktop when token is empty', async () => {
    const { createSignalAdapter } = await import('../src/platforms/signal/sync')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const adapter = createSignalAdapter('default', { name: 'default', fields: { BEEPER_ACCESS_TOKEN: '' } })
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
    const chat = makeSignalChat({ id: 'chat-new', title: 'New Chat' })
    const msg = makeSignalMessage({ id: 'msg-new', chatID: 'chat-new' })
    const msgMap = new Map([['chat-new', [msg]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat], msgMap)

    await runIncrementalImpl(client, since, 'test-account')

    // listChatMessages called, listNewChatMessages not called
    expect(client.listChatMessages).toHaveBeenCalledWith('chat-new')
    expect(client.listNewChatMessages).not.toHaveBeenCalled()

    const chats = getChats()
    expect(chats).toHaveLength(1)
    const msgs = getMessages(chats[0]!.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.external_id).toBe('msg-new')
  })

  it('calls listNewChatMessages for a returning chat that already has messages', async () => {
    const chat = makeSignalChat({ id: 'chat-returning', title: 'Returning Chat' })

    // Pre-insert a message to simulate prior sync
    const chatId = upsertChat(mapChat(chat, 'test-account'))
    const priorMsg = makeSignalMessage({ id: 'msg-prior', chatID: 'chat-returning' })
    insertMessage(mapMessage(priorMsg, chatId))

    const newMsg = makeSignalMessage({ id: 'msg-new', chatID: 'chat-returning', timestamp: '2024-06-16T10:00:00.000Z' })
    const client: BeeperSignalClient = {
      signalAccountIds: vi.fn().mockResolvedValue(['signal-acct-1']),
      listChats: vi.fn(() => asyncGen([chat])),
      listChatMessages: vi.fn(() => asyncGen([])),
      listNewChatMessages: vi.fn(() => asyncGen([newMsg])),
    }

    await runIncrementalImpl(client, since, 'test-account')

    expect(client.listNewChatMessages).toHaveBeenCalledWith('chat-returning', since)
    expect(client.listChatMessages).not.toHaveBeenCalled()

    const msgs = getMessages(chatId, 100)
    // Should have prior message + new message
    expect(msgs).toHaveLength(2)
    expect(msgs.some(m => m.external_id === 'msg-new')).toBe(true)
  })

  it('skips deleted and hidden messages in incremental new-chat path', async () => {
    const chat = makeSignalChat({ id: 'chat-skip', title: 'Skip Chat' })
    const activeMsg = makeSignalMessage({ id: 'msg-active', chatID: 'chat-skip' })
    const deletedMsg = makeSignalMessage({ id: 'msg-del', chatID: 'chat-skip', isDeleted: true })
    const hiddenMsg = makeSignalMessage({ id: 'msg-hid', chatID: 'chat-skip', isHidden: true })
    const msgMap = new Map([['chat-skip', [activeMsg, deletedMsg, hiddenMsg]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat], msgMap)

    await runIncrementalImpl(client, since, 'test-account')

    const chats = getChats()
    const msgs = getMessages(chats[0]!.id as unknown as number, 100)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.external_id).toBe('msg-active')
  })

  it('skips deleted and hidden messages in incremental returning-chat path', async () => {
    const chat = makeSignalChat({ id: 'chat-ret-skip', title: 'Ret Skip Chat' })
    const chatId = upsertChat(mapChat(chat, 'test-account'))
    const priorMsg = makeSignalMessage({ id: 'msg-prior', chatID: 'chat-ret-skip' })
    insertMessage(mapMessage(priorMsg, chatId))

    const activeMsg = makeSignalMessage({ id: 'msg-active', chatID: 'chat-ret-skip', timestamp: '2024-06-16T10:00:00.000Z' })
    const deletedMsg = makeSignalMessage({ id: 'msg-del', chatID: 'chat-ret-skip', isDeleted: true })
    const client: BeeperSignalClient = {
      signalAccountIds: vi.fn().mockResolvedValue(['signal-acct-1']),
      listChats: vi.fn(() => asyncGen([chat])),
      listChatMessages: vi.fn(() => asyncGen([])),
      listNewChatMessages: vi.fn(() => asyncGen([activeMsg, deletedMsg])),
    }

    await runIncrementalImpl(client, since, 'test-account')

    const msgs = getMessages(chatId, 100)
    // prior + active only (deleted skipped)
    expect(msgs).toHaveLength(2)
    expect(msgs.some(m => m.external_id === 'msg-active')).toBe(true)
    expect(msgs.some(m => m.external_id === 'msg-del')).toBe(false)
  })

  it('continues processing remaining chats when one chat throws (per-chat error isolation)', async () => {
    const chat1 = makeSignalChat({ id: 'chat-err', title: 'Error Chat' })
    const chat2 = makeSignalChat({ id: 'chat-ok', title: 'OK Chat' })
    const msg = makeSignalMessage({ id: 'msg-ok', chatID: 'chat-ok' })

    const client: BeeperSignalClient = {
      signalAccountIds: vi.fn().mockResolvedValue(['signal-acct-1']),
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
    const client = makeMockSignalClient([], [], new Map())
    await expect(runIncrementalImpl(client, since, 'test-account')).resolves.toBeUndefined()
    expect(getChats()).toHaveLength(0)
  })
})

// ── Query parity: Signal data is returned by existing query handlers without Signal-specific changes ──

describe('Signal platform query parity', () => {
  // Req 6.1-6.5: Signal data must be retrievable via standard MCP/CLI query paths
  // with no modifications to those tools.

  let signalChatId: number

  beforeEach(() => {
    initDb(':memory:')

    // Simulate a synced Signal chat and message (as runBackfillImpl would produce)
    signalChatId = upsertChat({
      external_id: 'signal-chat-1',
      account: 'default',
      name: 'Alice',
      type: 'private',
      username: null,
      platform: 'signal',
    })

    insertMessage({
      external_id: 'signal-msg-1',
      chat_id: signalChatId,
      sender_id: null,
      sender_name: 'Alice',
      text: 'Hello from Signal',
      type: 'text',
      timestamp: 1704067200,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'signal',
    })

    rebuildFtsIndex()
  })

  // Req 6.1: handleListChats returns the synced Signal chat
  it('handleListChats returns the synced Signal chat', () => {
    const chats = handleListChats()
    const signalChat = chats.find(c => c.platform === 'signal')
    expect(signalChat).toBeDefined()
    expect(signalChat!.name).toBe('Alice')
  })

  // Req 6.2: handleSearchMessages / handleFindChatByName resolves Signal chat by name
  it('handleFindChatByName resolves the Signal chat by name', () => {
    const results = handleFindChatByName('Alice')
    const signalChat = results.find(c => c.platform === 'signal')
    expect(signalChat).toBeDefined()
    expect(signalChat!.name).toBe('Alice')
  })

  // Req 6.3: handleListMessages returns Signal messages for the synced chat without Signal-specific arguments
  it('handleListMessages returns Signal messages using only standard chatId argument', () => {
    const { messages } = handleListMessages(signalChatId)
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every(m => m.platform === 'signal')).toBe(true)
    expect(messages.some(m => m.text === 'Hello from Signal')).toBe(true)
  })

  // Req 6.3 (search path): handleSearchMessages returns Signal messages without Signal-specific arguments
  it('handleSearchMessages returns Signal messages without Signal-specific arguments', () => {
    const results = handleSearchMessages('Hello from Signal')
    const signalMsg = results.find(m => m.platform === 'signal')
    expect(signalMsg).toBeDefined()
    expect(signalMsg!.text).toBe('Hello from Signal')
  })

  // Req 6.4: rebuildFtsIndex followed by handleSearchMessages includes Signal message text in FTS results
  it('rebuildFtsIndex then handleSearchMessages includes Signal message text in full-text search', () => {
    rebuildFtsIndex()
    const results = handleSearchMessages('Signal')
    expect(results.some(m => m.platform === 'signal' && m.text !== null && m.text.includes('Signal'))).toBe(true)
  })

  // Req 6.5: platform filter still works — Signal messages appear when filtering by platform:'signal'
  it('handleListChats with platform filter returns only Signal chats', () => {
    // Add a non-Signal chat to ensure filter works
    upsertChat({
      external_id: 'tg-chat-1',
      account: 'default',
      name: 'TelegramUser',
      type: 'private',
      username: null,
      platform: 'telegram',
    })
    const signalChats = handleListChats({ platform: 'signal' })
    expect(signalChats.every(c => c.platform === 'signal')).toBe(true)
    expect(signalChats.some(c => c.name === 'Alice')).toBe(true)
    expect(signalChats.some(c => c.platform === 'telegram')).toBe(false)
  })
})

// ── image sync wiring ─────────────────────────────────────────────────────────

vi.mock('../src/platforms/signal/image-sync', () => ({
  processSignalImageMessages: vi.fn().mockResolvedValue({ stored: 0, failed: 0 }),
}))

describe('image sync wiring — runBackfillImpl', () => {
  beforeEach(async () => {
    initDb(':memory:')
    const { processSignalImageMessages } = await import('../src/platforms/signal/image-sync')
    vi.mocked(processSignalImageMessages).mockClear()
    vi.mocked(processSignalImageMessages).mockResolvedValue({ stored: 1, failed: 0 })
  })

  it('collects IMAGE messages and calls processSignalImageMessages after inserts', async () => {
    const { processSignalImageMessages } = await import('../src/platforms/signal/image-sync')

    const chat = makeSignalChat({ id: 'chat-img-wiring', title: 'Image Chat' })
    const textMsg = makeSignalMessage({ id: 'msg-text', chatID: 'chat-img-wiring', type: 'TEXT', text: 'hello' })
    const imageMsg = makeSignalMessage({ id: 'msg-img', chatID: 'chat-img-wiring', type: 'IMAGE', text: undefined })
    const msgMap = new Map([['chat-img-wiring', [textMsg, imageMsg]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat], msgMap)

    await runBackfillImpl(client, 'test-account')

    // Both messages inserted
    const chats = getChats()
    const chatRow = chats.find(c => c.external_id === 'chat-img-wiring')!
    const msgs = getMessages(chatRow.id as unknown as number, 100)
    expect(msgs).toHaveLength(2)

    // processSignalImageMessages called once per chat, with only the IMAGE message
    expect(processSignalImageMessages).toHaveBeenCalledOnce()
    const [, , imageMsgsArg] = vi.mocked(processSignalImageMessages).mock.calls[0]!
    expect(imageMsgsArg).toHaveLength(1)
    expect(imageMsgsArg[0]!.id).toBe('msg-img')
  })

  it('appends images count to completion log line', async () => {
    const consoleSpy = vi.spyOn(console, 'log')

    const chat = makeSignalChat({ id: 'chat-log', title: 'Log Chat' })
    const imageMsg = makeSignalMessage({ id: 'msg-log-img', chatID: 'chat-log', type: 'IMAGE', text: undefined })
    const msgMap = new Map([['chat-log', [imageMsg]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat], msgMap)

    await runBackfillImpl(client, 'test-account')

    const logCall = consoleSpy.mock.calls.find(c => String(c[0]).includes('Sync complete'))
    expect(logCall).toBeDefined()
    expect(String(logCall![0])).toMatch(/images: 1 stored, 0 failed/)

    consoleSpy.mockRestore()
  })

  it('accumulates stored/failed counts across multiple chats', async () => {
    const { processSignalImageMessages } = await import('../src/platforms/signal/image-sync')
    vi.mocked(processSignalImageMessages)
      .mockResolvedValueOnce({ stored: 1, failed: 0 })
      .mockResolvedValueOnce({ stored: 0, failed: 1 })

    const consoleSpy = vi.spyOn(console, 'log')

    const chat1 = makeSignalChat({ id: 'chat-acc-1', title: 'Chat 1' })
    const chat2 = makeSignalChat({ id: 'chat-acc-2', title: 'Chat 2' })
    const img1 = makeSignalMessage({ id: 'img-1', chatID: 'chat-acc-1', type: 'IMAGE', text: undefined })
    const img2 = makeSignalMessage({ id: 'img-2', chatID: 'chat-acc-2', type: 'IMAGE', text: undefined })
    const msgMap = new Map([['chat-acc-1', [img1]], ['chat-acc-2', [img2]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat1, chat2], msgMap)

    await runBackfillImpl(client, 'test-account')

    const logCall = consoleSpy.mock.calls.find(c => String(c[0]).includes('Sync complete'))
    expect(String(logCall![0])).toMatch(/images: 1 stored, 1 failed/)

    consoleSpy.mockRestore()
  })
})

describe('image sync wiring — runIncrementalImpl', () => {
  const since = new Date('2024-06-15T00:00:00.000Z')

  beforeEach(async () => {
    initDb(':memory:')
    const { processSignalImageMessages } = await import('../src/platforms/signal/image-sync')
    vi.mocked(processSignalImageMessages).mockClear()
    vi.mocked(processSignalImageMessages).mockResolvedValue({ stored: 1, failed: 0 })
  })

  it('collects IMAGE messages and calls processSignalImageMessages after inserts', async () => {
    const { processSignalImageMessages } = await import('../src/platforms/signal/image-sync')

    const chat = makeSignalChat({ id: 'chat-inc-img', title: 'Inc Image Chat' })
    const textMsg = makeSignalMessage({ id: 'msg-inc-text', chatID: 'chat-inc-img', type: 'TEXT', text: 'hello' })
    const imageMsg = makeSignalMessage({ id: 'msg-inc-img', chatID: 'chat-inc-img', type: 'IMAGE', text: undefined })
    const msgMap = new Map([['chat-inc-img', [textMsg, imageMsg]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat], msgMap)

    await runIncrementalImpl(client, since, 'test-account')

    const chats = getChats()
    const chatRow = chats.find(c => c.external_id === 'chat-inc-img')!
    const msgs = getMessages(chatRow.id as unknown as number, 100)
    expect(msgs).toHaveLength(2)

    expect(processSignalImageMessages).toHaveBeenCalledOnce()
    const [, , imageMsgsArg] = vi.mocked(processSignalImageMessages).mock.calls[0]!
    expect(imageMsgsArg).toHaveLength(1)
    expect(imageMsgsArg[0]!.id).toBe('msg-inc-img')
  })

  it('appends images count to incremental completion log line', async () => {
    const consoleSpy = vi.spyOn(console, 'log')

    const chat = makeSignalChat({ id: 'chat-inc-log', title: 'Inc Log Chat' })
    const imageMsg = makeSignalMessage({ id: 'msg-inc-log-img', chatID: 'chat-inc-log', type: 'IMAGE', text: undefined })
    const msgMap = new Map([['chat-inc-log', [imageMsg]]])
    const client = makeMockSignalClient(['signal-acct-1'], [chat], msgMap)

    await runIncrementalImpl(client, since, 'test-account')

    const logCall = consoleSpy.mock.calls.find(c => String(c[0]).includes('Incremental sync complete'))
    expect(logCall).toBeDefined()
    expect(String(logCall![0])).toMatch(/images: 1 stored, 0 failed/)

    consoleSpy.mockRestore()
  })
})
