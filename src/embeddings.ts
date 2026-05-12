import os from 'os'
import path from 'path'

// Lazily import to avoid loading the heavy ONNX runtime at module load time
type Pipeline = Awaited<ReturnType<typeof import('@huggingface/transformers').pipeline>>

let _pipeline: Pipeline | null = null

async function getPipeline(): Promise<Pipeline> {
  if (_pipeline) return _pipeline

  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = path.join(os.homedir(), '.cache', 'khipuchat', 'models')
  env.allowRemoteModels = true

  _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'fp32',
    device: 'cpu',
  } as Parameters<typeof pipeline>[2])

  // After first successful load, go offline — no re-downloads on subsequent calls
  env.allowRemoteModels = false

  return _pipeline
}

/**
 * Embed one or more texts. Returns one 384-dim normalized Float32Array per input.
 * Texts are processed in batches for efficiency.
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) throw new Error('No texts to embed')

  const extractor = await getPipeline()
  const results: Float32Array[] = []

  // Process in batches of 64 to bound memory usage
  const BATCH = 64
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).filter(t => t.length > 0)
    if (batch.length === 0) continue

    const output = await extractor(batch, { pooling: 'mean', normalize: true })
    const flat = output.data as Float32Array
    const dims = output.dims as number[]
    const vecLen = dims[dims.length - 1] // 384

    for (let j = 0; j < batch.length; j++) {
      results.push(flat.slice(j * vecLen, (j + 1) * vecLen))
    }
  }

  return results
}

/** Embed a single text. Convenience wrapper around embed(). */
export async function embedOne(text: string): Promise<Float32Array> {
  const [vec] = await embed([text])
  return vec
}

/** Reset the pipeline singleton (for testing). */
export function _resetPipeline(): void {
  _pipeline = null
}
