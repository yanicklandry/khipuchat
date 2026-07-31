import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDb, getChats } from '../src/db'
import {
  hashStr,
  mapChat,
  mapMessage,
  runBackfillImpl,
  runIncrementalImpl,
  createSlackAdapter,
} from '../src/platforms/slack/sync'
import { createSlackClient } from '../src/platforms/slack/client'
import type { SlackClient, SlackConversation, SlackMessage } from '../src/platforms/slack/client'

// ── Mock factory ──────────────────────────────────────────────────────────────

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
  userName = 'Alice',
): SlackClient {
  return {
    listConversations: () => asyncOf(...convs),
    fetchHistory: () => asyncOf(...msgs),
    getUserName: async () => userName,
  }
}

// ── hashStr ───────────────────────────────────────────────────────────────────

describe('hashStr', () => {
  it('is stable', () => { expect(hashStr('C001')).toBe(hashStr('C001')) })
  it('differs for different inputs', () => { expect(hashStr('a')).not.toBe(hashStr('b')) })
  it('returns a positive safe integer', () => {
    expect(hashStr('test')).toBeGreaterThan(0)
    expect(Number.isSafeInteger(hashStr('test'))).toBe(true)
  })
})

// ── mapChat ───────────────────────────────────────────────────────────────────

describe('mapChat', () => {
  it('sets platform to slack', () => {
    expect(mapChat(makeConv(), 'default').platform).toBe('slack')
  })

  it('sets type=private for DM (is_im=true)', () => {
    expect(mapChat(makeConv({ is_im: true, user: 'U001' }), 'default').type).toBe('private')
  })

  it('sets type=group for group DM (is_mpim=true)', () => {
    expect(mapChat(makeConv({ is_mpim: true }), 'default').type).toBe('group')
  })

  it('sets type=user for regular channel', () => {
    expect(mapChat(makeConv(), 'default').type).toBe('user')
  })

  it('uses channel name when available', () => {
    expect(mapChat(makeConv({ name: 'general' }), 'default').name).toBe('general')
  })

  it('falls back to user id for DMs without name', () => {
    expect(mapChat(makeConv({ is_im: true, name: null, user: 'U999' }), 'default').name).toBe('U999')
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const msg = makeMsg()

  it('sets platform to slack', () => {
    expect(mapMessage(msg, 1, 'Alice').platform).toBe('slack')
  })

  it('sets external_id to msg.ts', () => {
    expect(mapMessage(msg, 1, 'Alice').external_id).toBe('1700000000.000001')
  })

  it('converts ts float to unix seconds', () => {
    expect(mapMessage(msg, 1, 'Alice').timestamp).toBe(1700000000)
  })

  it('sets type=text for non-empty text without subtype', () => {
    expect(mapMessage(msg, 1, 'Alice').type).toBe('text')
  })

  it('sets type=other when subtype is present', () => {
    expect(mapMessage({ ...msg, subtype: 'bot_message' }, 1, 'Alice').type).toBe('other')
  })

  it('sets type=other for empty text', () => {
    expect(mapMessage({ ...msg, text: '' }, 1, 'Alice').type).toBe('other')
  })

  it('sets is_sender to 0', () => {
    expect(mapMessage(msg, 1, 'Alice').is_sender).toBe(0)
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

describe('runBackfillImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('imports channels and messages', async () => {
    const client = makeMockClient(
      [makeConv({ id: 'C001', name: 'general' })],
      [makeMsg({ ts: '1700000001.000001' }), makeMsg({ ts: '1700000002.000001' })],
    )
    await runBackfillImpl(client)
    expect(getChats()).toHaveLength(1)
    expect(getChats()[0]!.platform).toBe('slack')
  })

  it('is idempotent', async () => {
    const client = makeMockClient(
      [makeConv({ id: 'C002' })],
      [makeMsg({ ts: '1700000003.000001' })],
    )
    await runBackfillImpl(client)
    await runBackfillImpl(client)
    expect(getChats()).toHaveLength(1)
  })

  it('skips archived conversations', async () => {
    const client = makeMockClient(
      [makeConv({ is_archived: true })],
      [makeMsg()],
    )
    await runBackfillImpl(client)
    expect(getChats()).toHaveLength(0)
  })
})

// ── runIncrementalImpl ────────────────────────────────────────────────────────

describe('runIncrementalImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('passes oldest parameter to fetchHistory', async () => {
    const since = new Date(1700000000 * 1000)
    const fetchHistorySpy = vi.fn(async function* () { yield makeMsg() })
    const client: SlackClient = {
      listConversations: () => asyncOf(makeConv({ id: 'C-inc-1' })),
      fetchHistory: fetchHistorySpy,
      getUserName: async () => 'Alice',
    }

    await runIncrementalImpl(client, since)

    expect(fetchHistorySpy).toHaveBeenCalledWith('C-inc-1', (1700000000).toString())
  })

  it('imports messages from incremental sync', async () => {
    const client = makeMockClient(
      [makeConv({ id: 'C-inc-2' })],
      [makeMsg({ ts: '1700000001.000001' })],
    )
    await runIncrementalImpl(client, new Date(1699000000 * 1000))
    expect(getChats()).toHaveLength(1)
  })

  it('skips archived conversations in incremental sync', async () => {
    const client = makeMockClient(
      [makeConv({ is_archived: true })],
      [makeMsg()],
    )
    await runIncrementalImpl(client, new Date())
    expect(getChats()).toHaveLength(0)
  })
})

// ── SlackClient 429 retry ─────────────────────────────────────────────────────

describe('createSlackClient — 429 retry', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('retries after Retry-After delay on 429 response', async () => {
    vi.useFakeTimers()
    const retryAfterSeconds = 2

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 429,
        headers: { get: (_h: string) => String(retryAfterSeconds) },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ ok: true, channels: [], response_metadata: {} }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const client = createSlackClient('xoxp-test-token')
    const gen = client.listConversations()

    const promise = gen.next()
    await vi.advanceTimersByTimeAsync(1200)
    await vi.advanceTimersByTimeAsync(retryAfterSeconds * 1000)
    await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})

// ── createSlackAdapter missing token ─────────────────────────────────────────

describe('createSlackAdapter — missing token', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('exits with code 1 and writes to stderr when SLACK_USER_TOKEN is absent', async () => {
    const db = initDb(':memory:')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => { throw new Error('process.exit') })

    const adapter = createSlackAdapter('default', { name: 'default', fields: { SLACK_USER_TOKEN: '' } })

    await expect(adapter.runBackfill(db)).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    const stderr = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stderr).toContain('SLACK_USER_TOKEN')
  })
})
