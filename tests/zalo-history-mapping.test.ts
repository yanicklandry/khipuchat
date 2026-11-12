import { describe, it, expect } from 'vitest'
import {
  isDmConversation,
  collapseDuplicates,
  toChat,
  toMessage,
  classifyType,
  captionOf,
} from '../src/platforms/zalo/history/mapping'
import { mapChat, mapMessage } from '../src/platforms/zalo/sync'
import { ZaloThreadType } from '../src/platforms/zalo/client'
import type { ZaloPcConversation, ZaloPcRow } from '../src/platforms/zalo/history/types'

const OWN = '283886062958706980'
const PEER = '1017560865672061899'

function row(over: Partial<ZaloPcRow> = {}): ZaloPcRow {
  return {
    msgId: '8481248414744',
    cliMsgId: '1794483366795',
    fromUid: PEER,
    toUid: PEER,
    sendDttm: '1794483366878',
    serverTime: '1794483366900',
    msgType: 1,
    message: 'hello',
    dName: 'Linh',
    ...over,
  }
}

const conv = (over: Partial<ZaloPcConversation> = {}): ZaloPcConversation => ({
  uid: PEER, name: 'Linh', isGroup: false, isOfficialAccount: false, ...over,
})

describe('isDmConversation', () => {
  it('accepts a plain DM, including one with isGroup unknown', () => {
    expect(isDmConversation(conv())).toBe(true)
    expect(isDmConversation(conv({ isGroup: null }))).toBe(true)
  })
  it('rejects groups by flag or by g-prefixed uid', () => {
    expect(isDmConversation(conv({ isGroup: true }))).toBe(false)
    expect(isDmConversation(conv({ uid: 'g123', isGroup: null }))).toBe(false)
  })
  it('rejects Official Accounts', () => {
    expect(isDmConversation(conv({ isOfficialAccount: true }))).toBe(false)
  })
})

describe('toChat', () => {
  it('is identical to zalo-sync mapChat for the same thread', () => {
    expect(toChat(conv(), 'work')).toEqual(mapChat({ threadId: PEER, name: 'Linh' }, 'work'))
    expect(toChat(conv(), 'work')).toMatchObject({ external_id: PEER, type: 'private', platform: 'zalo', account: 'work' })
  })
})

describe('toMessage identity parity with zalo-sync', () => {
  it('received text: same record as mapMessage for the equivalent live event', () => {
    const live = mapMessage({
      msgId: '8481248414744', threadId: PEER, threadType: ZaloThreadType.User, isSelf: false,
      senderId: PEER, senderName: 'Linh', content: 'hello', ts: 1794483366878,
    }, 7)
    expect(toMessage(row(), 7, OWN, 'Linh')).toEqual(live)
  })

  it('sent text ("0" sender): is_sender=1 and no sender fields, like mapMessage', () => {
    const live = mapMessage({
      msgId: '8481248866499', threadId: PEER, threadType: ZaloThreadType.User, isSelf: true,
      senderId: OWN, senderName: 'Me', content: 'hi', ts: 1794483374257,
    }, 7)
    const got = toMessage(row({ msgId: '8481248866499', fromUid: '0', message: 'hi', sendDttm: '1794483374257', dName: 'Me' }), 7, OWN, 'Linh')
    expect(got).toEqual(live)
    expect(got).toMatchObject({ is_sender: 1, sender_id: null, sender_name: null })
  })

  it('treats fromUid equal to the own uid as sent too', () => {
    expect(toMessage(row({ fromUid: OWN }), 7, OWN, 'Linh').is_sender).toBe(1)
  })

  it('falls back to the conversation name when dName is missing', () => {
    expect(toMessage(row({ dName: null }), 7, OWN, 'Linh').sender_name).toBe('Linh')
  })

  it('converts epoch-ms sendDttm to unix seconds', () => {
    expect(toMessage(row({ sendDttm: '1794483366878' }), 7, OWN, 'Linh').timestamp).toBe(1794483366)
  })
})

describe('non-text messages', () => {
  it('maps observed and documented msgTypes', () => {
    expect(classifyType(1, 'hi')).toBe('text')
    expect(classifyType(2, { title: '' })).toBe('image')
    expect(classifyType(7, {})).toBe('sticker')
    expect(classifyType(18, {})).toBe('video')
    expect(classifyType(17, { title: 'Café' })).toBe('other')
    expect(classifyType(99, null)).toBe('other')
  })

  it('keeps a caption from title, then description, then desc', () => {
    expect(captionOf({ title: 'Card', description: 'x' })).toBe('Card')
    expect(captionOf({ title: '', description: 'Shared link' })).toBe('Shared link')
    expect(captionOf({ desc: 'Office' })).toBe('Office')
    expect(captionOf({ title: 3 })).toBeNull()
    expect(captionOf('plain')).toBeNull()
    expect(captionOf(null)).toBeNull()
  })

  it('a location row becomes type other with its caption as text, never failing', () => {
    const m = toMessage(row({ msgType: 17, message: { title: 'Café Giảng', desc: 'Hà Nội', lat: 21 } }), 7, OWN, 'Linh')
    expect(m).toMatchObject({ type: 'other', text: 'Café Giảng', external_id: '8481248414744' })
  })

  it('an image without a caption has null text', () => {
    expect(toMessage(row({ msgType: 2, message: { href: 'x' } }), 7, OWN, 'Linh')).toMatchObject({ type: 'image', text: null })
  })

  it('an empty string message maps to type other with empty text, like mapMessage', () => {
    expect(toMessage(row({ message: '' }), 7, OWN, 'Linh')).toMatchObject({ type: 'other', text: '' })
  })
})

describe('collapseDuplicates', () => {
  it('keeps the unsuffixed copy of a multi-device pair', () => {
    const pc = row({ msgId: '8481248414744', serverTime: '100' })
    const phone = row({ msgId: '8481248414744_123', serverTime: '200' })
    expect(collapseDuplicates([phone, pc])).toEqual([pc])
  })

  it('otherwise keeps the later serverTime, then the larger msgId', () => {
    const a = row({ msgId: '8481248414744_1', serverTime: '100' })
    const b = row({ msgId: '8481248414744_2', serverTime: '200' })
    expect(collapseDuplicates([b, a])).toEqual([b])
    const c = row({ msgId: '8481248414744_5', serverTime: '200' })
    expect(collapseDuplicates([b, c])).toEqual([c])
  })

  it('leaves distinct messages alone and keeps input order', () => {
    const a = row({ msgId: '1', cliMsgId: 'a' })
    const b = row({ msgId: '2', cliMsgId: 'b' })
    expect(collapseDuplicates([a, b])).toEqual([a, b])
  })
})
