import { describe, it, expect } from 'vitest'
import { resolveChat, mapEnvelope } from '../src/platforms/signal/cli-mapping'
import type { SignalEnvelope } from '../src/platforms/signal/cli-client'

const noName = (): undefined => undefined

function received(over: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    sourceUuid: 'u-alice',
    sourceNumber: '+1500',
    sourceName: 'Alice',
    timestamp: 1_700_000_000_000,
    dataMessage: { message: 'hello' },
    ...over,
  }
}

function sent(over: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    sourceUuid: 'u-me',
    sourceName: 'Me',
    timestamp: 1_700_000_000_000,
    syncMessage: { sentMessage: { destination: 'u-bob', message: 'yo' } },
    ...over,
  }
}

describe('resolveChat', () => {
  it('resolves a direct chat from the received source', () => {
    const chat = resolveChat(received(), noName, noName)
    expect(chat).toEqual({ external_id: 'u-alice', name: 'Alice', type: 'private' })
  })

  it('resolves a direct chat from the sent destination for own-sends', () => {
    const chat = resolveChat(sent(), noName, noName)
    expect(chat?.external_id).toBe('u-bob')
    expect(chat?.type).toBe('private')
  })

  it('resolves a group chat from dataMessage.groupInfo', () => {
    const chat = resolveChat(received({ dataMessage: { message: 'hi', groupInfo: { groupId: 'G1' } } }), noName, noName)
    expect(chat).toEqual({ external_id: 'group.G1', name: 'G1', type: 'group' })
  })

  it('prefers a group name from the lookup', () => {
    const chat = resolveChat(
      received({ dataMessage: { groupInfo: { groupId: 'G1' } } }),
      (id) => (id === 'G1' ? 'Family' : undefined),
      noName,
    )
    expect(chat?.name).toBe('Family')
  })

  it('uses a contact-name lookup for a direct chat', () => {
    const chat = resolveChat(received(), noName, (id) => (id === 'u-alice' ? 'Alice Cooper' : undefined))
    expect(chat?.name).toBe('Alice Cooper')
  })

  it('returns null when no chat identity can be derived', () => {
    const chat = resolveChat({ timestamp: 1 } as SignalEnvelope, noName, noName)
    expect(chat).toBeNull()
  })
})

describe('mapEnvelope', () => {
  it('maps a received text message with is_sender 0', () => {
    const r = mapEnvelope(received(), 7)
    expect(r).not.toBeNull()
    expect(r?.message.is_sender).toBe(0)
    expect(r?.message.text).toBe('hello')
    expect(r?.message.type).toBe('text')
    expect(r?.message.chat_id).toBe(7)
    expect(r?.message.platform).toBe('signal')
    expect(r?.message.timestamp).toBe(1_700_000_000)
  })

  it('maps an own-sent (syncMessage.sentMessage) message with is_sender 1', () => {
    const r = mapEnvelope(sent(), 7)
    expect(r?.message.is_sender).toBe(1)
    expect(r?.message.text).toBe('yo')
    expect(r?.message.external_id.startsWith('self.')).toBe(true)
  })

  it('classifies as image when any attachment is image/*', () => {
    const env = received({
      dataMessage: { message: 'pic', attachments: [{ id: 'att-1', contentType: 'image/jpeg' }] },
    })
    const r = mapEnvelope(env, 1)
    expect(r?.message.type).toBe('image')
    expect(r?.imageAttachments).toHaveLength(1)
  })

  it('classifies as other when no text and only a non-image attachment', () => {
    const env = received({
      dataMessage: { attachments: [{ id: 'att-2', contentType: 'application/pdf' }] },
    })
    const r = mapEnvelope(env, 1)
    expect(r?.message.type).toBe('other')
    expect(r?.imageAttachments).toHaveLength(0)
  })

  it('stores the reply-to reference from a quote', () => {
    const env = received({ dataMessage: { message: 're', quote: { id: 1699999999000, author: 'u-bob' } } })
    const r = mapEnvelope(env, 1)
    expect(r?.message.reply_to_external_id).toBe('u-bob.1699999999000')
  })

  it('uses sentMessage.timestamp for own-sends when present', () => {
    const env = sent({ syncMessage: { sentMessage: { destination: 'u-bob', message: 'x', timestamp: 1_700_000_500_000 } } })
    const r = mapEnvelope(env, 1)
    expect(r?.message.timestamp).toBe(1_700_000_500)
  })

  it('returns null for a receipt-only envelope (no data/sync message)', () => {
    expect(mapEnvelope({ timestamp: 1, receiptMessage: {} } as SignalEnvelope, 1)).toBeNull()
  })

  it('returns null for an empty message with no text and no attachments', () => {
    expect(mapEnvelope(received({ dataMessage: { message: '' } }), 1)).toBeNull()
  })
})
