import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TelegramClient } from 'telegram'
import { config, saveSessionString } from '../src/config'
import { runAuthWizard, runBackfill, runSync, startListener, syncIncrementalImpl, type PromptFn } from '../src/platforms/telegram/sync'
import { initDb, upsertChat, getChats, getMessages, getPlatformLastSyncedAt, setPlatformLastSyncedAt } from '../src/db'

const T = 1700000000

// ── Helpers — env files ───────────────────────────────────────────────────────

function tempEnvFile(content: string = ''): string {
  const p = join(tmpdir(), `test-env-${Date.now()}.env`)
  writeFileSync(p, content, 'utf8')
  return p
}

// ── Helpers — GramJS-shaped mock objects ──────────────────────────────────────

interface MockPeer {
  className: 'PeerUser'
  userId: bigint
}

interface MockMessage {
  className: 'Message'
  id: number
  message: string
  date: number
  fromId: MockPeer
  peerId: MockPeer
  media: undefined
  replyTo: undefined
  out: boolean
}

interface MockUserEntity {
  className: 'User'
  id: bigint
  firstName: string
  lastName: string | null
  username: string | null
  bot: boolean
}

interface MockChannelEntity {
  className: 'Channel'
  id: bigint
  title: string
  username: string | null
  broadcast: boolean
}

function makeMsg(
  id: number,
  text: string,
  date: number,
  peerId = 1,
  fromId = 999,
  out = false,
): MockMessage {
  return {
    className: 'Message',
    id,
    message: text,
    date,
    fromId: { className: 'PeerUser', userId: BigInt(fromId) },
    peerId: { className: 'PeerUser', userId: BigInt(peerId) },
    media: undefined,
    replyTo: undefined,
    out,
  }
}

function makeUserEntity(
  id: number,
  firstName: string,
  username: string | null = null,
): MockUserEntity {
  return { className: 'User', id: BigInt(id), firstName, lastName: null, username, bot: false }
}

function makeChannelEntity(id: number, title: string, broadcast: boolean): MockChannelEntity {
  return { className: 'Channel', id: BigInt(id), title, username: null, broadcast }
}

function makeMockClient(sessionString = 'saved-session-xyz') {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    session: { save: vi.fn().mockReturnValue(sessionString) } as unknown as TelegramClient['session'],
    disconnect: vi.fn().mockResolvedValue(undefined),
    getDialogs: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    addEventHandler: vi.fn(),
  }
}

// ── saveSessionString ─────────────────────────────────────────────────────────

describe('saveSessionString', () => {
  let envPath: string

  afterEach(() => {
    if (existsSync(envPath)) unlinkSync(envPath)
  })

  it('replaces existing TELEGRAM_SESSION_STRING= line', () => {
    envPath = tempEnvFile('API_ID=123\nTELEGRAM_SESSION_STRING=old\nAPI_HASH=abc\n')
    saveSessionString('new-session', envPath)
    const result = readFileSync(envPath, 'utf8')
    expect(result).toContain('TELEGRAM_SESSION_STRING=new-session')
    expect(result).not.toContain('TELEGRAM_SESSION_STRING=old')
    expect(result).toContain('API_ID=123')
    expect(result).toContain('API_HASH=abc')
  })

  it('appends SESSION_STRING when the key is absent', () => {
    envPath = tempEnvFile('API_ID=123\nAPI_HASH=abc\n')
    saveSessionString('brand-new', envPath)
    const result = readFileSync(envPath, 'utf8')
    expect(result).toContain('TELEGRAM_SESSION_STRING=brand-new')
    expect(result).toContain('API_ID=123')
  })

  it('works on an empty .env file', () => {
    envPath = tempEnvFile('')
    saveSessionString('fresh', envPath)
    const result = readFileSync(envPath, 'utf8')
    expect(result).toContain('TELEGRAM_SESSION_STRING=fresh')
  })

  it('updates config.sessionString in memory', () => {
    envPath = tempEnvFile('TELEGRAM_SESSION_STRING=\n')
    saveSessionString('mem-session', envPath)
    expect(config.sessionString).toBe('mem-session')
  })
})

// ── Config loading ────────────────────────────────────────────────────────────

describe('config', () => {
  it('exposes apiId as a number', () => {
    expect(typeof config.apiId).toBe('number')
    expect(Number.isFinite(config.apiId)).toBe(true)
  })

  it('exposes apiHash as a non-empty string', () => {
    expect(typeof config.apiHash).toBe('string')
    expect(config.apiHash.length).toBeGreaterThan(0)
  })

  it('exposes phoneNumber as a non-empty string', () => {
    expect(typeof config.phoneNumber).toBe('string')
    expect(config.phoneNumber.length).toBeGreaterThan(0)
  })

  it('exposes sessionString as a string (possibly empty)', () => {
    expect(typeof config.sessionString).toBe('string')
  })
})

// ── runAuthWizard ─────────────────────────────────────────────────────────────

describe('runAuthWizard', () => {
  let envPath: string

  beforeEach(() => {
    envPath = tempEnvFile('TELEGRAM_SESSION_STRING=\n')
  })

  afterEach(() => {
    if (existsSync(envPath)) unlinkSync(envPath)
  })

  it('calls client.start() when sessionString is empty', async () => {
    const client = makeMockClient()
    const promptFn: PromptFn = vi.fn().mockResolvedValue('12345')

    await runAuthWizard(client as unknown as TelegramClient, promptFn, { sessionString: '' }, envPath)

    expect(client.start).toHaveBeenCalledOnce()
  })

  it('writes the session string to .env after successful auth', async () => {
    const client = makeMockClient('fresh-session-abc')
    const promptFn: PromptFn = vi.fn().mockResolvedValue('12345')

    await runAuthWizard(client as unknown as TelegramClient, promptFn, { sessionString: '' }, envPath)

    const result = readFileSync(envPath, 'utf8')
    expect(result).toContain('TELEGRAM_SESSION_STRING=fresh-session-abc')
  })

  it('calls client.connect() and skips start() when sessionString exists', async () => {
    const client = makeMockClient()
    const promptFn: PromptFn = vi.fn()

    await runAuthWizard(
      client as unknown as TelegramClient,
      promptFn,
      { sessionString: 'existing-session' },
      envPath,
    )

    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.start).not.toHaveBeenCalled()
    expect(promptFn).not.toHaveBeenCalled()
  })
})

// ── runBackfill ───────────────────────────────────────────────────────────────

describe('runBackfill', () => {
  beforeEach(() => {
    initDb(':memory:')
  })

  it('upserts chat and inserts messages for a User dialog (first-time: single fetch)', async () => {
    const entity = makeUserEntity(1, 'Tony Lin', 'tonylin1115')
    const msgs = [makeMsg(1, 'hi', T + 1), makeMsg(2, 'hey', T + 2)]
    const client = makeMockClient()
    client.getDialogs.mockResolvedValue([{ entity }])
    client.getMessages.mockResolvedValue(msgs)
    const sleep = vi.fn().mockResolvedValue(undefined)

    await runBackfill(client as unknown as TelegramClient, sleep, 20)

    expect(getChats()).toHaveLength(1)
    expect(getChats()[0].name).toBe('Tony Lin')
    expect(getMessages(1, 10)).toHaveLength(2)
    // First-time sync: exactly 1 call with no offsetId/reverse
    expect(client.getMessages).toHaveBeenCalledTimes(1)
    const [, opts] = client.getMessages.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(opts['offsetId']).toBeUndefined()
    expect(opts['reverse']).toBeUndefined()
  })

  it('paginates until a page is smaller than pageSize (incremental)', async () => {
    const entity = makeUserEntity(1, 'Tony Lin')
    // Pre-seed so incremental path is used
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: null, platform: 'telegram' })
    const { insertMessage } = await import('../src/db')
    insertMessage({ external_id: '0', chat_id: 1, sender_id: null, sender_name: 'T', text: 'seed', type: 'text', timestamp: T, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })

    const batch = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => makeMsg(start + i, `msg ${start + i}`, T + start + i))

    const client = makeMockClient()
    client.getDialogs.mockResolvedValue([{ entity }])
    client.getMessages
      .mockResolvedValueOnce(batch(1, 20))
      .mockResolvedValueOnce(batch(21, 20))
      .mockResolvedValueOnce(batch(41, 10))
    const sleep = vi.fn().mockResolvedValue(undefined)

    await runBackfill(client as unknown as TelegramClient, sleep, 20)

    expect(getMessages(1, 100)).toHaveLength(51) // 1 seed + 50 new
    expect(client.getMessages).toHaveBeenCalledTimes(3)
  })

  it('resumes from getLastSyncedId — passes correct offsetId on first fetch', async () => {
    const entity = makeUserEntity(1, 'Tony Lin')
    // pre-seed 3 messages so getLastSyncedId(1) returns '3'
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: null, platform: 'telegram' })
    for (let i = 1; i <= 3; i++) {
      const { insertMessage } = await import('../src/db')
      insertMessage({
        external_id: String(i), chat_id: 1, sender_id: null, sender_name: 'Tony',
        text: `old ${i}`, type: 'text', timestamp: T + i, is_sender: 0,
        reply_to_external_id: null, platform: 'telegram',
      })
    }

    const client = makeMockClient()
    client.getDialogs.mockResolvedValue([{ entity }])
    // Only new messages after the resume point
    client.getMessages
      .mockResolvedValueOnce([makeMsg(4, 'new', T + 4), makeMsg(5, 'newer', T + 5)])
      .mockResolvedValue([])
    const sleep = vi.fn().mockResolvedValue(undefined)

    await runBackfill(client as unknown as TelegramClient, sleep, 20)

    // First getMessages call must use offsetId=3
    const [, opts] = client.getMessages.mock.calls[0] as [unknown, { offsetId: number }]
    expect(opts.offsetId).toBe(3)
    // Total = 3 pre-seeded + 2 new
    expect(getMessages(1, 10)).toHaveLength(5)
  })

  it('skips Channel entities with broadcast=true', async () => {
    const user = makeUserEntity(1, 'Tony Lin')
    const channel = makeChannelEntity(2, 'News Channel', true)

    const client = makeMockClient()
    client.getDialogs.mockResolvedValue([{ entity: user }, { entity: channel }])
    client.getMessages.mockResolvedValue([])
    const sleep = vi.fn().mockResolvedValue(undefined)

    await runBackfill(client as unknown as TelegramClient, sleep, 20)

    expect(getChats()).toHaveLength(1)
    expect(getChats()[0].name).toBe('Tony Lin')
  })

  it('calls sleep between dialogs but not after the last one', async () => {
    const e1 = makeUserEntity(1, 'Alice')
    const e2 = makeUserEntity(2, 'Bob')

    const client = makeMockClient()
    client.getDialogs.mockResolvedValue([{ entity: e1 }, { entity: e2 }])
    client.getMessages.mockResolvedValue([])
    const sleep = vi.fn().mockResolvedValue(undefined)

    await runBackfill(client as unknown as TelegramClient, sleep, 20)

    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(300)
  })
})

// ── startListener ─────────────────────────────────────────────────────────────

describe('startListener', () => {
  beforeEach(() => {
    initDb(':memory:')
    upsertChat({ id: 1, name: 'Tony Lin', type: 'user', username: null, platform: 'telegram' })
  })

  it('registers exactly one event handler on the client', () => {
    const client = makeMockClient()
    startListener(client as unknown as TelegramClient)
    expect(client.addEventHandler).toHaveBeenCalledOnce()
  })

  it('inserts a new message into the DB when the handler fires', async () => {
    const client = makeMockClient()
    startListener(client as unknown as TelegramClient)

    const handler = client.addEventHandler.mock.calls[0][0] as (e: { message: MockMessage }) => Promise<void>
    await handler({ message: makeMsg(42, 'live message', T + 100, 1, 999, false) })

    const msgs = getMessages(1, 10)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].text).toBe('live message')
    expect(msgs[0].external_id).toBe('42')
  })

  it('logs the chat id when a new message arrives', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const client = makeMockClient()
    startListener(client as unknown as TelegramClient)

    const handler = client.addEventHandler.mock.calls[0][0] as (e: { message: MockMessage }) => Promise<void>
    await handler({ message: makeMsg(1, 'hello', T + 1, 1, 999, false) })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1'))
    consoleSpy.mockRestore()
  })
})

// ── runSync (mode-select logic) ───────────────────────────────────────────────

describe('runSync', () => {
  beforeEach(() => {
    initDb(':memory:')
  })

  it('logs sync mode: backfill when --backfill flag is set (even with prior timestamp)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const client = makeMockClient()
    const syncFn = vi.fn().mockResolvedValue(undefined)

    await runSync(client as unknown as TelegramClient, { backfillFlag: true, since: 1700000000 }, syncFn)

    expect(consoleSpy).toHaveBeenCalledWith('[telegram] sync mode: backfill')
    consoleSpy.mockRestore()
  })

  it('logs sync mode: backfill when no prior timestamp', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const client = makeMockClient()
    const syncFn = vi.fn().mockResolvedValue(undefined)

    await runSync(client as unknown as TelegramClient, { backfillFlag: false, since: null }, syncFn)

    expect(consoleSpy).toHaveBeenCalledWith('[telegram] sync mode: backfill')
    consoleSpy.mockRestore()
  })

  it('logs sync mode: incremental when no flag and prior timestamp exists', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const client = makeMockClient()
    const syncFn = vi.fn().mockResolvedValue(undefined)

    await runSync(client as unknown as TelegramClient, { backfillFlag: false, since: 1700000000 }, syncFn)

    expect(consoleSpy).toHaveBeenCalledWith('[telegram] sync mode: incremental')
    consoleSpy.mockRestore()
  })

  it('updates sync_state after successful sync', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const client = makeMockClient()
    const syncFn = vi.fn().mockResolvedValue(undefined)

    await runSync(client as unknown as TelegramClient, { backfillFlag: false, since: null }, syncFn)

    const ts = getPlatformLastSyncedAt('telegram')
    expect(ts).not.toBeNull()
    expect(ts).toBeGreaterThan(0)
    vi.restoreAllMocks()
  })

  it('does not update sync_state when sync throws (error leaves sync_state unchanged)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const client = makeMockClient()
    const syncFn = vi.fn().mockRejectedValue(new Error('network failure'))

    await expect(
      runSync(client as unknown as TelegramClient, { backfillFlag: false, since: null }, syncFn)
    ).rejects.toThrow('network failure')

    expect(getPlatformLastSyncedAt('telegram')).toBeNull()
    vi.restoreAllMocks()
  })
})

// ── syncIncrementalImpl ───────────────────────────────────────────────────────

describe('syncIncrementalImpl', () => {
  beforeEach(() => {
    initDb(':memory:')
  })

  it('skips dialogs where dialogDate <= sinceTs', async () => {
    const since = new Date(T * 1000)  // sinceTs = T
    const entity = makeUserEntity(1, 'Alice')
    // dialogDate = T (equal to sinceTs — should be skipped)
    const client = makeMockClient()
    client.getDialogs.mockResolvedValue([{ entity, date: T }])
    const sleep = vi.fn().mockResolvedValue(undefined)

    await syncIncrementalImpl(client as unknown as TelegramClient, since, sleep, 20)

    // No messages fetched because dialog was skipped
    expect(client.getMessages).not.toHaveBeenCalled()
    expect(getChats()).toHaveLength(0)
  })

  it('processes dialogs where dialogDate > sinceTs', async () => {
    const since = new Date(T * 1000)
    const entity = makeUserEntity(1, 'Bob')
    const msgs = [makeMsg(10, 'hello', T + 1)]
    const client = makeMockClient()
    client.getDialogs.mockResolvedValue([{ entity, date: T + 1 }])
    client.getMessages.mockResolvedValue(msgs)
    const sleep = vi.fn().mockResolvedValue(undefined)

    await syncIncrementalImpl(client as unknown as TelegramClient, since, sleep, 20)

    expect(getChats()).toHaveLength(1)
    expect(getChats()[0].name).toBe('Bob')
  })

  it('skips messages within the dialog that are at or before sinceTs', async () => {
    const since = new Date(T * 1000)
    const entity = makeUserEntity(1, 'Carol')
    // dialogDate > sinceTs, but some messages are old
    const msgs = [
      makeMsg(1, 'old msg', T - 1),   // before since — skip
      makeMsg(2, 'at since', T),       // equal — skip
      makeMsg(3, 'new msg', T + 1),    // after — keep
    ]
    const client = makeMockClient()
    client.getDialogs.mockResolvedValue([{ entity, date: T + 1 }])
    client.getMessages.mockResolvedValue(msgs)
    const sleep = vi.fn().mockResolvedValue(undefined)

    await syncIncrementalImpl(client as unknown as TelegramClient, since, sleep, 20)

    const stored = getMessages(1, 10)
    expect(stored).toHaveLength(1)
    expect(stored[0].external_id).toBe('3')
  })
})
