import { createWorker } from 'tesseract.js'

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>

let _worker: TesseractWorker | null = null

async function getWorker(): Promise<TesseractWorker> {
  if (_worker === null) {
    _worker = await createWorker('eng')
  }
  return _worker
}

/**
 * Returns trimmed OCR text, or null if extraction yields nothing or fails.
 * Never throws to the caller.
 */
export async function extractText(input: string | Buffer): Promise<string | null> {
  try {
    const worker = await getWorker()
    const { data: { text } } = await worker.recognize(input as string)
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (err) {
    process.stderr.write(`[ocr] extraction failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return null
  }
}

/**
 * Terminates the singleton worker; called at process shutdown.
 */
export async function terminateOcr(): Promise<void> {
  if (_worker !== null) {
    await _worker.terminate()
    _worker = null
  }
}
