import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initDb, upsertChat, insertMessage, getDb, getMessageIdByExternalId } from '../src/db'
import {
  extFromMime,
  pickImageAttachment,
  processSignalImageMessages,
} from '../src/platforms/signal/image-sync'
import type { BeeperMessage } from '../src/platforms/signal/client'

vi.mock('../src/media-storage', () => ({
  storeMedia: vi.fn().mockReturnValue('/fake/path/image.jpg'),
}))

vi.mock('../src/ocr', () => ({
  extractText: vi.fn().mockResolvedValue('extracted text'),
}))

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
  },
}))

import { storeMedia } from '../src/media-storage'
import { extractText } from '../src/ocr'
import fs from 'fs'

const T = 1700000000

function makeMsg(id: string, overrides: Partial<BeeperMessage> = {}): BeeperMessage {
  return {
    id,
    chatID: '42',
    timestamp: new Date(T * 1000).toISOString(),
    attachments: [
      {
        type: 'img',
        srcURL: 'beeper://signal/img/' + id,
        mimeType: 'image/jpeg',
        size: { width: 800, height: 600 },
      },
    ],
    ...overrides,
  } as unknown as BeeperMessage
}

function makeMockClient(returnValue: Buffer | null = Buffer.from('fakeimg')) {
  return {
    fetchAttachmentBuffer: vi.fn().mockResolvedValue(returnValue),
  }
}

describe('extFromMime', () => {
  it('maps image/png to png', () => {
    expect(extFromMime('image/png')).toBe('png')
  })
  it('maps image/gif to gif', () => {
    expect(extFromMime('image/gif')).toBe('gif')
  })
  it('maps image/webp to webp', () => {
    expect(extFromMime('image/webp')).toBe('webp')
  })
  it('maps image/jpeg to jpg', () => {
    expect(extFromMime('image/jpeg')).toBe('jpg')
  })
  it('maps undefined to jpg', () => {
    expect(extFromMime(undefined)).toBe('jpg')
  })
  it('maps unknown mime to jpg', () => {
    expect(extFromMime('application/octet-stream')).toBe('jpg')
  })
})

describe('pickImageAttachment', () => {
  it('returns first img attachment with srcURL', () => {
    const msg = makeMsg('1')
    const att = pickImageAttachment(msg)
    expect(att).not.toBeNull()
    expect(att?.type).toBe('img')
  })

  it('returns first img attachment with id (no srcURL)', () => {
    const msg = makeMsg('1', {
      attachments: [{ type: 'img', id: 'some-id' }],
    } as Partial<BeeperMessage>)
    expect(pickImageAttachment(msg)).not.toBeNull()
  })

  it('returns null when no attachments', () => {
    const msg = makeMsg('1', { attachments: [] } as Partial<BeeperMessage>)
    expect(pickImageAttachment(msg)).toBeNull()
  })

  it('returns null when only non-img attachments', () => {
    const msg = makeMsg('1', {
      attachments: [{ type: 'video', srcURL: 'beeper://video/1' }],
    } as Partial<BeeperMessage>)
    expect(pickImageAttachment(msg)).toBeNull()
  })

  it('returns null when img has neither srcURL nor id', () => {
    const msg = makeMsg('1', {
      attachments: [{ type: 'img' }],
    } as Partial<BeeperMessage>)
    expect(pickImageAttachment(msg)).toBeNull()
  })

  it('skips non-img attachments and returns first qualifying img', () => {
    const msg = makeMsg('1', {
      attachments: [
        { type: 'audio', srcURL: 'beeper://audio/1' },
        { type: 'img', srcURL: 'beeper://img/1', mimeType: 'image/png' },
      ],
    } as Partial<BeeperMessage>)
    const att = pickImageAttachment(msg)
    expect(att?.mimeType).toBe('image/png')
  })
})

describe('processSignalImageMessages', () => {
  let chatId: number

  beforeEach(() => {
    initDb(':memory:')
    vi.clearAllMocks()
    ;(storeMedia as ReturnType<typeof vi.fn>).mockReturnValue('/fake/path/image.jpg')
    ;(extractText as ReturnType<typeof vi.fn>).mockResolvedValue('extracted text')

    chatId = upsertChat({
      external_id: '42',
      account: 'default',
      name: 'Test Chat',
      type: 'user',
      username: null,
      platform: 'signal',
    })

    insertMessage({
      external_id: '1',
      chat_id: chatId,
      sender_id: null,
      sender_name: null,
      text: null,
      type: 'image',
      timestamp: T,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'signal',
    })
  })

  it('fetches, stores, and persists media for a new image message', async () => {
    const client = makeMockClient()
    const msg = makeMsg('1')

    const result = await processSignalImageMessages(client, chatId, [msg])

    expect(result).toEqual({ stored: 1, failed: 0 })
    expect(client.fetchAttachmentBuffer).toHaveBeenCalledOnce()
    expect(storeMedia).toHaveBeenCalledWith({
      platform: 'signal',
      chatId,
      externalId: '1',
      ext: 'jpg',
      data: expect.any(Buffer),
    })
    expect(extractText).toHaveBeenCalledOnce()

    const dbId = getMessageIdByExternalId(chatId, '1')!
    const row = getDb()
      .prepare('SELECT media_file_path, media_width, media_height, ocr_text FROM messages WHERE id = ?')
      .get(dbId) as { media_file_path: string | null; media_width: number | null; media_height: number | null; ocr_text: string | null }
    expect(row.media_file_path).toBe('/fake/path/image.jpg')
    expect(row.media_width).toBe(800)
    expect(row.media_height).toBe(600)
    expect(row.ocr_text).toBe('extracted text')
  })

  it('skips already-processed messages (media_file_path set)', async () => {
    const client = makeMockClient()
    const msg = makeMsg('1')

    // First run
    await processSignalImageMessages(client, chatId, [msg])
    vi.clearAllMocks()
    ;(storeMedia as ReturnType<typeof vi.fn>).mockReturnValue('/fake/path/image.jpg')

    // Second run
    const result = await processSignalImageMessages(client, chatId, [msg])
    expect(result).toEqual({ stored: 0, failed: 0 })
    expect(client.fetchAttachmentBuffer).not.toHaveBeenCalled()
    expect(storeMedia).not.toHaveBeenCalled()
  })

  it('skips message not found in DB (uncounted)', async () => {
    const client = makeMockClient()
    const msg = makeMsg('999')

    const result = await processSignalImageMessages(client, chatId, [msg])
    expect(result).toEqual({ stored: 0, failed: 0 })
    expect(client.fetchAttachmentBuffer).not.toHaveBeenCalled()
  })

  it('skips message with no image attachment (uncounted, logged)', async () => {
    const client = makeMockClient()
    const msg = makeMsg('1', { attachments: [] } as Partial<BeeperMessage>)

    const result = await processSignalImageMessages(client, chatId, [msg])
    expect(result).toEqual({ stored: 0, failed: 0 })
    expect(client.fetchAttachmentBuffer).not.toHaveBeenCalled()
  })

  it('counts failed when fetchAttachmentBuffer returns null', async () => {
    const client = makeMockClient(null)
    const msg = makeMsg('1')

    const result = await processSignalImageMessages(client, chatId, [msg])
    expect(result).toEqual({ stored: 0, failed: 1 })
    expect(storeMedia).not.toHaveBeenCalled()
  })

  it('counts failed and continues when fetch throws', async () => {
    insertMessage({
      external_id: '2',
      chat_id: chatId,
      sender_id: null,
      sender_name: null,
      text: null,
      type: 'image',
      timestamp: T + 1,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'signal',
    })

    const client = {
      fetchAttachmentBuffer: vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(Buffer.from('img2')),
    }

    const result = await processSignalImageMessages(client, chatId, [makeMsg('1'), makeMsg('2')])
    expect(result).toEqual({ stored: 1, failed: 1 })

    const dbId2 = getMessageIdByExternalId(chatId, '2')!
    const row2 = getDb()
      .prepare('SELECT media_file_path FROM messages WHERE id = ?')
      .get(dbId2) as { media_file_path: string | null }
    expect(row2.media_file_path).toBe('/fake/path/image.jpg')
  })

  it('skips OCR if ocr_text is already set', async () => {
    const dbId = getMessageIdByExternalId(chatId, '1')!
    getDb().prepare('UPDATE messages SET ocr_text = ? WHERE id = ?').run('existing ocr', dbId)

    const client = makeMockClient()
    const result = await processSignalImageMessages(client, chatId, [makeMsg('1')])

    expect(result).toEqual({ stored: 1, failed: 0 })
    expect(extractText).not.toHaveBeenCalled()

    const row = getDb()
      .prepare('SELECT media_file_path, ocr_text FROM messages WHERE id = ?')
      .get(dbId) as { media_file_path: string | null; ocr_text: string | null }
    expect(row.media_file_path).toBe('/fake/path/image.jpg')
    expect(row.ocr_text).toBe('existing ocr')
  })

  it('reads correct extension from mimeType', async () => {
    const client = makeMockClient()
    const msg = makeMsg('1', {
      attachments: [{ type: 'img', srcURL: 'beeper://img/1', mimeType: 'image/png', size: { width: 100, height: 100 } }],
    } as Partial<BeeperMessage>)

    await processSignalImageMessages(client, chatId, [msg])

    expect(storeMedia).toHaveBeenCalledWith(expect.objectContaining({ ext: 'png' }))
  })

  it('uses id as fallback when srcURL is absent', async () => {
    const client = makeMockClient()
    const msg = makeMsg('1', {
      attachments: [{ type: 'img', id: 'attach-id-123' }],
    } as Partial<BeeperMessage>)

    await processSignalImageMessages(client, chatId, [msg])

    expect(client.fetchAttachmentBuffer).toHaveBeenCalledWith('attach-id-123')
  })

  it('tries file:// fallback when beeper fetch returns null', async () => {
    const client = { fetchAttachmentBuffer: vi.fn().mockResolvedValue(null) }
    // This tests the fallback path logs + counts as failed (no real file on disk)
    const msg = makeMsg('1', {
      attachments: [{
        type: 'img',
        srcURL: 'file:///nonexistent/path/img.jpg',
        mimeType: 'image/jpeg',
      }],
    } as Partial<BeeperMessage>)

    const result = await processSignalImageMessages(client, chatId, [msg])
    // File doesn't exist, so both strategies fail => failed++
    expect(result).toEqual({ stored: 0, failed: 1 })
  })

  it('reads from disk via file:// fallback when beeper fetch returns null and file exists', async () => {
    const diskBuffer = Buffer.from('disk-image-data')
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(diskBuffer)

    const client = { fetchAttachmentBuffer: vi.fn().mockResolvedValue(null) }
    const msg = makeMsg('1', {
      attachments: [{
        type: 'img',
        srcURL: 'file:///some/real/path/img.jpg',
        mimeType: 'image/jpeg',
      }],
    } as Partial<BeeperMessage>)

    const result = await processSignalImageMessages(client, chatId, [msg])
    expect(result).toEqual({ stored: 1, failed: 0 })
    expect(storeMedia).toHaveBeenCalledWith(expect.objectContaining({ data: diskBuffer }))
  })

  it('stores image and counts as stored when OCR returns null; ocr_text remains null in DB', async () => {
    ;(extractText as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)

    const client = makeMockClient()
    const msg = makeMsg('1')

    const result = await processSignalImageMessages(client, chatId, [msg])
    expect(result).toEqual({ stored: 1, failed: 0 })
    expect(storeMedia).toHaveBeenCalledOnce()

    const dbId = getMessageIdByExternalId(chatId, '1')!
    const row = getDb()
      .prepare('SELECT media_file_path, ocr_text FROM messages WHERE id = ?')
      .get(dbId) as { media_file_path: string | null; ocr_text: string | null }
    expect(row.media_file_path).toBe('/fake/path/image.jpg')
    expect(row.ocr_text).toBeNull()
  })

  it('returns { stored: 0, failed: 0 } for empty list', async () => {
    const client = makeMockClient()
    const result = await processSignalImageMessages(client, chatId, [])
    expect(result).toEqual({ stored: 0, failed: 0 })
  })

  it('stores null width/height when size is absent', async () => {
    const client = makeMockClient()
    const msg = makeMsg('1', {
      attachments: [{ type: 'img', srcURL: 'beeper://img/1', mimeType: 'image/jpeg' }],
    } as Partial<BeeperMessage>)

    await processSignalImageMessages(client, chatId, [msg])

    const dbId = getMessageIdByExternalId(chatId, '1')!
    const row = getDb()
      .prepare('SELECT media_width, media_height FROM messages WHERE id = ?')
      .get(dbId) as { media_width: number | null; media_height: number | null }
    expect(row.media_width).toBeNull()
    expect(row.media_height).toBeNull()
  })
})
