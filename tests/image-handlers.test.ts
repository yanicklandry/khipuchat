import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, upsertChat, insertMessage, getDb } from '../src/db'
import { handleGetImage } from '../src/image-handlers'
import * as fs from 'fs'

vi.mock('fs')

const T = 1700000000

describe('handleGetImage', () => {
  let chatId: number
  let messageId: number

  beforeEach(() => {
    initDb(':memory:')
    vi.clearAllMocks()

    chatId = upsertChat({
      external_id: '42',
      account: 'default',
      name: 'Test Chat',
      type: 'user',
      username: null,
      platform: 'telegram',
    })

    insertMessage({
      external_id: '101',
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

    const row = getDb()
      .prepare('SELECT id FROM messages WHERE external_id = ? AND chat_id = ?')
      .get('101', chatId) as { id: number }
    messageId = row.id
  })

  it('returns base64 content and ocr_text with ocr_available: true for a stored image with OCR', async () => {
    getDb()
      .prepare('UPDATE messages SET media_file_path = ?, ocr_text = ? WHERE id = ?')
      .run('/fake/path/image.jpg', 'some text in image', messageId)

    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from('fake image data'))

    const result = await handleGetImage(messageId)

    expect(result.message_id).toBe(messageId)
    expect(result.file_path).toBe('/fake/path/image.jpg')
    expect(result.content_base64).toBe(Buffer.from('fake image data').toString('base64'))
    expect(result.ocr_text).toBe('some text in image')
    expect(result.ocr_available).toBe(true)
  })

  it('returns content with ocr_available: false when ocr_text is null', async () => {
    getDb()
      .prepare('UPDATE messages SET media_file_path = ?, ocr_text = NULL WHERE id = ?')
      .run('/fake/path/image.jpg', messageId)

    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from('fake image data'))

    const result = await handleGetImage(messageId)

    expect(result.message_id).toBe(messageId)
    expect(result.ocr_text).toBeNull()
    expect(result.ocr_available).toBe(false)
  })

  it('throws a descriptive error when message has no media_file_path', async () => {
    // media_file_path is NULL by default
    await expect(handleGetImage(messageId)).rejects.toThrow('image not available')
  })

  it('throws a descriptive error when the file is missing on disk', async () => {
    getDb()
      .prepare('UPDATE messages SET media_file_path = ? WHERE id = ?')
      .run('/missing/file.jpg', messageId)

    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    })

    await expect(handleGetImage(messageId)).rejects.toThrow('image file not found on disk')
  })

  it('throws a descriptive error when message is not found', async () => {
    await expect(handleGetImage(999999)).rejects.toThrow('message not found')
  })
})
