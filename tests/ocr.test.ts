import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock tesseract.js before importing the module under test
const mockRecognize = vi.fn()
const mockTerminate = vi.fn()
const mockCreateWorker = vi.fn()

vi.mock('tesseract.js', () => ({
  createWorker: mockCreateWorker,
}))

// Import after mock is set up
let extractText: (input: string | Buffer) => Promise<string | null>
let terminateOcr: () => Promise<void>

beforeEach(async () => {
  vi.resetModules()
  mockRecognize.mockReset()
  mockTerminate.mockReset()
  mockCreateWorker.mockReset()

  // Default: worker resolves successfully with some text
  mockCreateWorker.mockResolvedValue({
    recognize: mockRecognize,
    terminate: mockTerminate,
  })

  const mod = await import('../src/ocr')
  extractText = mod.extractText
  terminateOcr = mod.terminateOcr
})

afterEach(async () => {
  // Terminate any worker created during the test to avoid leaks
  await terminateOcr()
})

describe('extractText', () => {
  it('returns trimmed text for a file path input', async () => {
    mockRecognize.mockResolvedValue({ data: { text: '  Hello World  ' } })

    const result = await extractText('/some/image.png')

    expect(result).toBe('Hello World')
    expect(mockRecognize).toHaveBeenCalledWith('/some/image.png')
  })

  it('returns trimmed text for a Buffer input', async () => {
    const buf = Buffer.from('fake image data')
    mockRecognize.mockResolvedValue({ data: { text: 'OCR text from buffer' } })

    const result = await extractText(buf)

    expect(result).toBe('OCR text from buffer')
    expect(mockRecognize).toHaveBeenCalledWith(buf)
  })

  it('returns null (not throw) when OCR output is empty string', async () => {
    mockRecognize.mockResolvedValue({ data: { text: '' } })

    const result = await extractText('/empty.png')

    expect(result).toBeNull()
  })

  it('returns null (not throw) when OCR output is whitespace only', async () => {
    mockRecognize.mockResolvedValue({ data: { text: '   \n\t  ' } })

    const result = await extractText('/whitespace.png')

    expect(result).toBeNull()
  })

  it('returns null (not throw) on extraction failure', async () => {
    mockRecognize.mockRejectedValue(new Error('OCR engine failure'))

    let threw = false
    let result: string | null = null
    try {
      result = await extractText('/garbage.bin')
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(result).toBeNull()
  })

  it('returns null (not throw) when worker creation fails', async () => {
    // Re-mock createWorker to fail on this test
    vi.resetModules()
    mockCreateWorker.mockRejectedValue(new Error('Cannot initialize WASM'))

    const mod = await import('../src/ocr')
    extractText = mod.extractText
    terminateOcr = mod.terminateOcr

    let threw = false
    let result: string | null = null
    try {
      result = await extractText('/image.png')
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(result).toBeNull()
  })

  it('reuses a single worker across consecutive calls', async () => {
    mockRecognize.mockResolvedValue({ data: { text: 'text' } })

    await extractText('/img1.png')
    await extractText('/img2.png')
    await extractText('/img3.png')

    // Worker should only have been created once
    expect(mockCreateWorker).toHaveBeenCalledTimes(1)
    // recognize should have been called once per extractText call
    expect(mockRecognize).toHaveBeenCalledTimes(3)
  })
})

describe('terminateOcr', () => {
  it('terminates the worker when one exists', async () => {
    mockRecognize.mockResolvedValue({ data: { text: 'hello' } })

    await extractText('/img.png')
    await terminateOcr()

    expect(mockTerminate).toHaveBeenCalledTimes(1)
  })

  it('does not throw when no worker has been initialized', async () => {
    await expect(terminateOcr()).resolves.not.toThrow()
  })

  it('creates a new worker after terminateOcr is called', async () => {
    mockRecognize.mockResolvedValue({ data: { text: 'hello' } })

    await extractText('/img1.png')
    await terminateOcr()

    // Second call should create a new worker
    await extractText('/img2.png')

    expect(mockCreateWorker).toHaveBeenCalledTimes(2)
  })
})
