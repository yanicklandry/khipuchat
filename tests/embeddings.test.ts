import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the heavy ONNX runtime — never download 90 MB in tests
vi.mock('@huggingface/transformers', () => {
  const makeVec = (seed: number) => new Float32Array(384).fill(seed)
  const extractor = vi.fn().mockImplementation(async (texts: string | string[]) => {
    const arr = Array.isArray(texts) ? texts : [texts]
    // Deterministic: same text → same float value
    const flat = new Float32Array(arr.length * 384)
    arr.forEach((t, i) => flat.set(makeVec(t.length % 10), i * 384))
    return { data: flat, dims: [arr.length, 384], type: 'float32' }
  })
  return {
    pipeline: vi.fn().mockResolvedValue(extractor),
    env: { cacheDir: '/fake/cache', allowRemoteModels: true },
  }
})

vi.mock('node:fs', () => ({
  readdirSync: vi.fn().mockReturnValue(['onnx', 'config.json']),
}))

import { embed, embedOne, _resetPipeline } from '../src/embeddings'
import { readdirSync } from 'node:fs'

const mockReaddirSync = vi.mocked(readdirSync)

describe('embeddings', () => {
  beforeEach(() => {
    _resetPipeline()
    // Default: cache present with some files
    mockReaddirSync.mockReturnValue(['onnx', 'config.json'] as any)
  })

  it('embedOne returns Float32Array of length 384', async () => {
    const vec = await embedOne('hello world')
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(384)
  })

  it('embed returns one array per input text', async () => {
    const vecs = await embed(['text a', 'text b'])
    expect(vecs).toHaveLength(2)
    expect(vecs[0]).toBeInstanceOf(Float32Array)
    expect(vecs[0].length).toBe(384)
    expect(vecs[1]).toBeInstanceOf(Float32Array)
    expect(vecs[1].length).toBe(384)
  })

  it('same input produces identical output (deterministic mock)', async () => {
    const a = await embedOne('consistent')
    _resetPipeline()
    const b = await embedOne('consistent')
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('throws when given empty array', async () => {
    await expect(embed([])).rejects.toThrow('No texts to embed')
  })
})

describe('embeddings — cache-miss download notice', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetPipeline()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    _resetPipeline()
  })

  it('logs exactly one download-notice line when cache directory is absent', async () => {
    // Simulate missing cache: readdirSync throws ENOENT
    mockReaddirSync.mockImplementation(() => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw err
    })

    await embedOne('test')

    const downloadLines = logSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].toLowerCase().includes('download'),
    )
    expect(downloadLines).toHaveLength(1)
  })

  it('logs exactly one download-notice line when cache directory is empty', async () => {
    // Simulate empty cache directory
    mockReaddirSync.mockReturnValue([] as any)

    await embedOne('test')

    const downloadLines = logSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].toLowerCase().includes('download'),
    )
    expect(downloadLines).toHaveLength(1)
  })

  it('logs no download-notice line when cache directory is present and non-empty', async () => {
    // Simulate populated cache
    mockReaddirSync.mockReturnValue(['onnx', 'config.json'] as any)

    await embedOne('test')

    const downloadLines = logSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].toLowerCase().includes('download'),
    )
    expect(downloadLines).toHaveLength(0)
  })

  it('KHIPUCHAT_EMBED_MOCK=1 bypasses cache check and logs nothing', async () => {
    mockReaddirSync.mockImplementation(() => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw err
    })
    process.env['KHIPUCHAT_EMBED_MOCK'] = '1'

    try {
      await embedOne('test')
    } finally {
      delete process.env['KHIPUCHAT_EMBED_MOCK']
    }

    const downloadLines = logSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].toLowerCase().includes('download'),
    )
    expect(downloadLines).toHaveLength(0)
  })
})
