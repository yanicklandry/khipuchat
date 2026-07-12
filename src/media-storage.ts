import * as fs from 'fs'
import * as path from 'path'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoreMediaInput {
  platform: string
  chatId: number | string
  externalId: string
  ext: string   // e.g. 'jpg' — caller-provided, NO leading dot
  data: Buffer
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the absolute path for a media file without writing anything.
 * Path convention: <mediaDir>/<platform>/<chatId>/<externalId>.<ext>
 *
 * Reads MEDIA_DIR from the environment at call time so tests can override it.
 */
export function mediaPathFor(input: Omit<StoreMediaInput, 'data'>): string {
  const mediaDir = process.env['MEDIA_DIR'] ?? path.resolve(process.cwd(), 'media')
  const { platform, chatId, externalId, ext } = input
  return path.join(mediaDir, platform, String(chatId), `${externalId}.${ext}`)
}

/**
 * Writes `data` to the resolved path, creating parent directories as needed.
 * Returns the absolute path written. Idempotent — a second call overwrites.
 * Throws on write failure (caller is responsible for handling errors).
 */
export function storeMedia(input: StoreMediaInput): string {
  const filePath = mediaPathFor(input)
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, input.data)
  return filePath
}
