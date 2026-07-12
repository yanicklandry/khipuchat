import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Override MEDIA_DIR before importing config/media-storage
let tmpDir: string

// We'll test via a tmpDir override applied at module-call time
import { storeMedia, mediaPathFor } from '../src/media-storage'

describe('mediaPathFor', () => {
  it('returns the expected path without creating anything', () => {
    const result = mediaPathFor({
      platform: 'telegram',
      chatId: 42,
      externalId: 'abc123',
      ext: 'jpg',
    })
    // Path must end with telegram/42/abc123.jpg
    expect(result).toMatch(/telegram[/\\]42[/\\]abc123\.jpg$/)
  })

  it('has no leading dot on the extension', () => {
    const result = mediaPathFor({
      platform: 'telegram',
      chatId: 99,
      externalId: 'xyz',
      ext: 'png',
    })
    expect(result).not.toMatch(/\.\.png$/)
    expect(result).toMatch(/\.png$/)
  })
})

describe('storeMedia', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-storage-test-'))
    process.env['MEDIA_DIR'] = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env['MEDIA_DIR']
  })

  it('writes buffer to the correct path and returns absolute path', () => {
    const data = Buffer.from('fake-image-bytes')
    const result = storeMedia({
      platform: 'telegram',
      chatId: 123,
      externalId: 'msg456',
      ext: 'jpg',
      data,
    })

    const expected = path.join(tmpDir, 'telegram', '123', 'msg456.jpg')
    expect(result).toBe(expected)
    expect(fs.existsSync(result)).toBe(true)
    expect(fs.readFileSync(result)).toEqual(data)
  })

  it('creates parent directories when they do not exist', () => {
    const data = Buffer.from('test')
    const result = storeMedia({
      platform: 'telegram',
      chatId: 'chat-99',
      externalId: 'file1',
      ext: 'mp4',
      data,
    })

    const dir = path.dirname(result)
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('is idempotent — second call overwrites without error', () => {
    const input = {
      platform: 'telegram',
      chatId: 1,
      externalId: 'dup',
      ext: 'jpg',
      data: Buffer.from('first'),
    }
    storeMedia(input)
    const result = storeMedia({ ...input, data: Buffer.from('second') })
    expect(fs.readFileSync(result).toString()).toBe('second')
  })
})
