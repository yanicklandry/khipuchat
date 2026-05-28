import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the heavy ONNX runtime — never download 90 MB in tests
vi.mock('@huggingface/transformers', () => {
  const makeVec = (seed: number) => new Float32Array(384).fill(seed)
  return {
    pipeline: vi.fn().mockResolvedValue(
      vi.fn().mockImplementation(async (texts: string | string[]) => {
        const arr = Array.isArray(texts) ? texts : [texts]
        // Deterministic: same text → same float value
        const flat = new Float32Array(arr.length * 384)
        arr.forEach((t, i) => flat.set(makeVec(t.length % 10), i * 384))
        return { data: flat, dims: [arr.length, 384], type: 'float32' }
      }),
    ),
    env: { cacheDir: '', allowRemoteModels: true },
  }
})

import { embed, embedOne, _resetPipeline } from '../src/embeddings'

describe('embeddings', () => {
  beforeEach(() => {
    _resetPipeline()
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
