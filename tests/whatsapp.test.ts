import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, getChats } from '../src/db'
import {
  hashStr,
  mapChat,
  mapMessage,
  runBackfillImpl,
} from '../src/platforms/whatsapp/sync'
import type { WhatsAppClient, WAChat, WAMessage } from '../src/platforms/whatsapp/client'

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeChat(overrides: Partial<WAChat> = {}): WAChat {
  return {
    id: { _serialized: 'chatid@c.us' },
    name: 'Alice',
    isGroup: false,
    ...overrides,
  }
}

function makeMsg(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    id: { _serialized: 'msg-001@c.us' },
    body: 'Hello',
    from: 'chatid@c.us',
    fromMe: false,
    timestamp: 1700000000,
    type: 'chat',
    ...overrides,
  }
}

function makeMockClient(
  chats: WAChat[],
  messages: WAMessage[],
  contactName = 'Alice',
): WhatsAppClient {
  return {
    getChats: async () => chats,
    fetchMessages: async () => messages,
    getContactName: async () => contactName,
    destroy: async () => {},
  }
}

// ── hashStr ───────────────────────────────────────────────────────────────────

describe('hashStr', () => {
  it('is stable', () => { expect(hashStr('wa-123')).toBe(hashStr('wa-123')) })
  it('differs for different inputs', () => { expect(hashStr('a')).not.toBe(hashStr('b')) })
})

// ── mapChat ───────────────────────────────────────────────────────────────────

describe('mapChat', () => {
  it('sets platform to whatsapp', () => {
    expect(mapChat(makeChat()).platform).toBe('whatsapp')
  })

  it('sets type=private when isGroup=false', () => {
    expect(mapChat(makeChat({ isGroup: false })).type).toBe('private')
  })

  it('sets type=group when isGroup=true', () => {
    expect(mapChat(makeChat({ isGroup: true })).type).toBe('group')
  })

  it('uses chat.name', () => {
    expect(mapChat(makeChat({ name: 'Team Chat' })).name).toBe('Team Chat')
  })

  it('uses hashStr of id._serialized', () => {
    const chat = makeChat()
    expect(mapChat(chat).id).toBe(hashStr(chat.id._serialized))
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const msg = makeMsg()

  it('sets platform to whatsapp', () => {
    expect(mapMessage(msg, 1, 'Alice').platform).toBe('whatsapp')
  })

  it('sets external_id to id._serialized', () => {
    expect(mapMessage(msg, 1, 'Alice').external_id).toBe('msg-001@c.us')
  })

  it('sets is_sender=0 when fromMe=false', () => {
    expect(mapMessage(msg, 1, 'Alice').is_sender).toBe(0)
  })

  it('sets is_sender=1 when fromMe=true', () => {
    expect(mapMessage({ ...msg, fromMe: true }, 1, 'Me').is_sender).toBe(1)
  })

  it('uses timestamp directly', () => {
    expect(mapMessage(msg, 1, 'Alice').timestamp).toBe(1700000000)
  })

  it('sets type=text for chat type with body', () => {
    expect(mapMessage(msg, 1, 'Alice').type).toBe('text')
  })

  it('sets type=other for image type', () => {
    expect(mapMessage({ ...msg, type: 'image', body: '' }, 1, 'Alice').type).toBe('other')
  })

  it('sets text to null for empty body', () => {
    expect(mapMessage({ ...msg, body: '' }, 1, 'Alice').text).toBeNull()
  })

  it('sets sender_name to null when fromMe=true', () => {
    expect(mapMessage({ ...msg, fromMe: true }, 1, 'Me').sender_name).toBeNull()
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

describe('runBackfillImpl', () => {
  beforeEach(() => { initDb(':memory:') })

  it('imports chats and messages', async () => {
    const client = makeMockClient(
      [makeChat({ id: { _serialized: 'alice@c.us' }, name: 'Alice' })],
      [makeMsg({ id: { _serialized: 'msg-1@c.us' } }), makeMsg({ id: { _serialized: 'msg-2@c.us' } })],
    )
    await runBackfillImpl(client)

    const chats = getChats()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.platform).toBe('whatsapp')
  })

  it('is idempotent', async () => {
    const client = makeMockClient(
      [makeChat({ id: { _serialized: 'bob@c.us' } })],
      [makeMsg({ id: { _serialized: 'msg-idem@c.us' } })],
    )
    await runBackfillImpl(client)
    await runBackfillImpl(client)
    expect(getChats()).toHaveLength(1)
  })

  it('handles empty chat list', async () => {
    const client = makeMockClient([], [])
    await expect(runBackfillImpl(client)).resolves.not.toThrow()
    expect(getChats()).toHaveLength(0)
  })
})
