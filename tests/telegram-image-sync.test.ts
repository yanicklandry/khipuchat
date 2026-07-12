import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initDb, upsertChat, insertMessage, getDb, getMessageIdByExternalId } from '../src/db'
import { processImageMessages, type RawTelegramMessage } from '../src/platforms/telegram/image-sync'

// Mock media-storage and ocr modules
vi.mock('../src/media-storage', () => ({
  storeMedia: vi.fn().mockReturnValue('/fake/path/image.jpg'),
}))

vi.mock('../src/ocr', () => ({
  extractText: vi.fn().mockResolvedValue('extracted text'),
}))

import { storeMedia } from '../src/media-storage'
import { extractText } from '../src/ocr'

const NO_SLEEP = () => Promise.resolve()
const T = 1700000000

function makeImageMsg(id: number): RawTelegramMessage {
  return {
    className: 'Message',
    id,
    date: T + id,
    media: {
      className: 'MessageMediaPhoto',
      photo: {
        sizes: [
          { type: 's', w: 10, h: 10 },
          { type: 'm', w: 100, h: 100 },
          { type: 'x', w: 800, h: 600 },
        ],
      },
    },
  }
}

function makeMockClient(downloadResult: Buffer | undefined = Buffer.from('fakeimg')) {
  return {
    downloadMedia: vi.fn().mockResolvedValue(downloadResult),
  }
}

describe('processImageMessages', () => {
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
      platform: 'telegram',
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
      platform: 'telegram',
    })
  })

  it('downloads, stores, and persists media for a new image message', async () => {
    const client = makeMockClient()
    const msg = makeImageMsg(1)

    await processImageMessages(client as never, chatId, [msg], NO_SLEEP)

    expect(client.downloadMedia).toHaveBeenCalledOnce()
    expect(storeMedia).toHaveBeenCalledWith({
      platform: 'telegram',
      chatId,
      externalId: '1',
      ext: 'jpg',
      data: expect.any(Buffer),
    })
    expect(extractText).toHaveBeenCalledOnce()

    const id = getMessageIdByExternalId(chatId, '1')!
    const row = getDb().prepare('SELECT media_file_path, media_width, media_height, ocr_text FROM messages WHERE id = ?').get(id) as {
      media_file_path: string | null
      media_width: number | null
      media_height: number | null
      ocr_text: string | null
    }
    expect(row.media_file_path).toBe('/fake/path/image.jpg')
    expect(row.media_width).toBe(800)
    expect(row.media_height).toBe(600)
    expect(row.ocr_text).toBe('extracted text')
  })

  it('re-run skips already-processed messages (zero DB writes)', async () => {
    // First run: process the message
    const client = makeMockClient()
    const msg = makeImageMsg(1)
    await processImageMessages(client as never, chatId, [msg], NO_SLEEP)

    // Verify first run worked
    expect(client.downloadMedia).toHaveBeenCalledOnce()
    vi.clearAllMocks()
    ;(storeMedia as ReturnType<typeof vi.fn>).mockReturnValue('/fake/path/image.jpg')
    ;(extractText as ReturnType<typeof vi.fn>).mockResolvedValue('extracted text')

    // Second run: should skip entirely
    const client2 = makeMockClient()
    await processImageMessages(client2 as never, chatId, [msg], NO_SLEEP)

    // No download, no store, no OCR on re-run
    expect(client2.downloadMedia).not.toHaveBeenCalled()
    expect(storeMedia).not.toHaveBeenCalled()
    expect(extractText).not.toHaveBeenCalled()
  })

  it('download failure is caught, media_file_path not set, processing continues for next image', async () => {
    // Insert a second message
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
      platform: 'telegram',
    })

    const client = {
      downloadMedia: vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))  // fails for msg 1
        .mockResolvedValueOnce(Buffer.from('img2')),        // succeeds for msg 2
    }

    const msg1 = makeImageMsg(1)
    const msg2 = makeImageMsg(2)

    await processImageMessages(client as never, chatId, [msg1, msg2], NO_SLEEP)

    // msg1: download failed, no media stored
    const id1 = getMessageIdByExternalId(chatId, '1')!
    const row1 = getDb().prepare('SELECT media_file_path FROM messages WHERE id = ?').get(id1) as { media_file_path: string | null }
    expect(row1.media_file_path).toBeNull()

    // msg2: processed successfully
    const id2 = getMessageIdByExternalId(chatId, '2')!
    const row2 = getDb().prepare('SELECT media_file_path FROM messages WHERE id = ?').get(id2) as { media_file_path: string | null }
    expect(row2.media_file_path).toBe('/fake/path/image.jpg')

    // Both download attempts were made (continued after failure)
    expect(client.downloadMedia).toHaveBeenCalledTimes(2)
  })

  it('skips message not found in DB', async () => {
    const client = makeMockClient()
    const msg = makeImageMsg(999) // ID not in DB

    await processImageMessages(client as never, chatId, [msg], NO_SLEEP)

    expect(client.downloadMedia).not.toHaveBeenCalled()
    expect(storeMedia).not.toHaveBeenCalled()
  })

  it('skips OCR if ocr_text is already set', async () => {
    // Manually set ocr_text on the message
    const id = getMessageIdByExternalId(chatId, '1')!
    getDb().prepare('UPDATE messages SET ocr_text = ? WHERE id = ?').run('existing ocr', id)

    const client = makeMockClient()
    const msg = makeImageMsg(1)

    await processImageMessages(client as never, chatId, [msg], NO_SLEEP)

    // OCR should NOT be called because ocr_text already set
    expect(extractText).not.toHaveBeenCalled()

    // But media_file_path should still be set
    const row = getDb().prepare('SELECT media_file_path, ocr_text FROM messages WHERE id = ?').get(id) as {
      media_file_path: string | null
      ocr_text: string | null
    }
    expect(row.media_file_path).toBe('/fake/path/image.jpg')
    expect(row.ocr_text).toBe('existing ocr')
  })

  it('handles undefined downloadMedia result gracefully', async () => {
    const client = { downloadMedia: vi.fn().mockResolvedValue(undefined) }
    const msg = makeImageMsg(1)

    await processImageMessages(client as never, chatId, [msg], NO_SLEEP)

    expect(storeMedia).not.toHaveBeenCalled()

    const id = getMessageIdByExternalId(chatId, '1')!
    const row = getDb().prepare('SELECT media_file_path FROM messages WHERE id = ?').get(id) as { media_file_path: string | null }
    expect(row.media_file_path).toBeNull()
  })

  it('selects largest non-s photo size for width/height', async () => {
    const client = makeMockClient()
    const msg: RawTelegramMessage = {
      className: 'Message',
      id: 1,
      date: T,
      media: {
        className: 'MessageMediaPhoto',
        photo: {
          sizes: [
            { type: 's', w: 999, h: 999 }, // should be excluded
            { type: 'm', w: 200, h: 150 },
            { type: 'x', w: 1200, h: 900 },
            { type: 'y', w: 800, h: 600 },
          ],
        },
      },
    }

    await processImageMessages(client as never, chatId, [msg], NO_SLEEP)

    const id = getMessageIdByExternalId(chatId, '1')!
    const row = getDb().prepare('SELECT media_width, media_height FROM messages WHERE id = ?').get(id) as {
      media_width: number | null
      media_height: number | null
    }
    expect(row.media_width).toBe(1200)
    expect(row.media_height).toBe(900)
  })

  it('sleeps between downloads', async () => {
    // Insert a second message
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
      platform: 'telegram',
    })

    const sleepFn = vi.fn().mockResolvedValue(undefined)
    const client = makeMockClient()

    const msg1 = makeImageMsg(1)
    const msg2 = makeImageMsg(2)

    await processImageMessages(client as never, chatId, [msg1, msg2], sleepFn)

    // Sleep called once between msg1 and msg2
    expect(sleepFn).toHaveBeenCalledOnce()
    expect(sleepFn).toHaveBeenCalledWith(1000)
  })
})
