import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, getChats } from '../src/db'
import {
  hashStr,
  mapChat,
  mapMessage,
  runBackfillImpl,
} from '../src/platforms/discord/sync'
import type { DiscordClient, DiscordChannel, DiscordMessage } from '../src/platforms/discord/client'

// ── Mock client factory ───────────────────────────────────────────────────────

function makeChannel(overrides: Partial<DiscordChannel> = {}): DiscordChannel {
  return { id: 'ch-1', type: 1, name: null, recipients: [{ id: 'u-1', username: 'Alice' }], ...overrides }
}

function makeMsg(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: 'msg-1', content: 'Hello', type: 0,
    author: { id: 'u-1', username: 'Alice' },
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeMockClient(
  dms: DiscordChannel[],
  guilds: Array<{ id: string }>,
  guildChannels: DiscordChannel[],
  messages: DiscordMessage[],
): DiscordClient {
  return {
    getGuilds: vi.fn().mockResolvedValue(guilds),
    getGuildChannels: vi.fn().mockResolvedValue(guildChannels),
    getDirectMessageChannels: vi.fn().mockResolvedValue(dms),
    getMessages: vi.fn().mockResolvedValue(messages),
  }
}

// ── hashStr ───────────────────────────────────────────────────────────────────

describe('hashStr', () => {
  it('is stable for same input', () => {
    expect(hashStr('discord-123')).toBe(hashStr('discord-123'))
  })
  it('differs for different inputs', () => {
    expect(hashStr('a')).not.toBe(hashStr('b'))
  })
  it('returns a positive safe integer', () => {
    const h = hashStr('test')
    expect(h).toBeGreaterThan(0)
    expect(Number.isSafeInteger(h)).toBe(true)
  })
})

// ── mapChat ───────────────────────────────────────────────────────────────────

describe('mapChat', () => {
  it('sets platform to discord', () => {
    expect(mapChat(makeChannel()).platform).toBe('discord')
  })

  it('sets type=private for DM (type=1)', () => {
    expect(mapChat(makeChannel({ type: 1 })).type).toBe('private')
  })

  it('sets type=group for guild text (type=0)', () => {
    expect(mapChat(makeChannel({ type: 0, name: 'general' })).type).toBe('group')
  })

  it('sets type=group for group DM (type=3)', () => {
    expect(mapChat(makeChannel({ type: 3, name: 'group' })).type).toBe('group')
  })

  it('falls back to recipient username when name is null', () => {
    expect(mapChat(makeChannel({ type: 1, name: null })).name).toBe('Alice')
  })

  it('uses channel.name when available', () => {
    expect(mapChat(makeChannel({ type: 0, name: 'general' })).name).toBe('general')
  })

  it('falls back to channel id when no name and no recipients', () => {
    expect(mapChat(makeChannel({ type: 1, name: null, recipients: [] })).name).toBe('ch-1')
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const msg = makeMsg()

  it('sets platform to discord', () => {
    expect(mapMessage(msg, 1).platform).toBe('discord')
  })

  it('sets external_id to msg.id', () => {
    expect(mapMessage(msg, 1).external_id).toBe('msg-1')
  })

  it('sets is_sender to 0', () => {
    expect(mapMessage(msg, 1).is_sender).toBe(0)
  })

  it('converts ISO timestamp to unix seconds', () => {
    expect(mapMessage(msg, 1).timestamp).toBe(Math.floor(Date.parse('2024-01-01T00:00:00.000Z') / 1000))
  })

  it('sets type=text for non-empty content', () => {
    expect(mapMessage(msg, 1).type).toBe('text')
  })

  it('sets type=other for empty content', () => {
    expect(mapMessage({ ...msg, content: '' }, 1).type).toBe('other')
  })

  it('sets text to null for empty content', () => {
    expect(mapMessage({ ...msg, content: '' }, 1).text).toBeNull()
  })

  it('sets reply_to_external_id from message_reference', () => {
    const r = mapMessage({ ...msg, message_reference: { message_id: 'parent-1' } }, 1)
    expect(r.reply_to_external_id).toBe('parent-1')
  })

  it('sets reply_to_external_id to null when no reference', () => {
    expect(mapMessage(msg, 1).reply_to_external_id).toBeNull()
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

describe('runBackfillImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('imports chats and messages from DMs and guild channels', async () => {
    const dm = makeChannel({ id: 'dm-1', type: 1, name: null })
    const gc = makeChannel({ id: 'gc-1', type: 0, name: 'general' })
    const msg1 = makeMsg({ id: 'msg-1' })
    const msg2 = makeMsg({ id: 'msg-2' })

    const client = makeMockClient([dm], [{ id: 'guild-1' }], [gc], [msg1, msg2])
    await runBackfillImpl(client)

    const chats = getChats()
    expect(chats).toHaveLength(2)
    expect(chats.every(c => c.platform === 'discord')).toBe(true)
  })

  it('is idempotent — running twice yields same counts', async () => {
    const dm = makeChannel({ id: 'dm-2', type: 1 })
    const client = makeMockClient([dm], [], [], [makeMsg()])

    await runBackfillImpl(client)
    await runBackfillImpl(client)

    expect(getChats()).toHaveLength(1)
  })

  it('skips channels with non-allowed types', async () => {
    const voiceChannel = makeChannel({ id: 'vc-1', type: 2, name: 'voice' })
    const client = makeMockClient([], [{ id: 'guild-1' }], [voiceChannel], [])
    await runBackfillImpl(client)
    expect(getChats()).toHaveLength(0)
  })
})
