import type { TelegramClient } from 'telegram'
import { getDb, getMessageIdByExternalId, updateMessageMedia } from '../../db'
import { storeMedia } from '../../media-storage'
import { extractText } from '../../ocr'

// Minimal typed shape for the raw GramJS message object
export interface RawTelegramMessage {
  className: string
  id: number
  message?: string
  date: number
  fromId?: { className: string; userId?: bigint }
  peerId?: { className: string; userId?: bigint; chatId?: bigint; channelId?: bigint }
  media?: unknown
  replyTo?: { replyToMsgId?: number }
  out?: boolean
}

interface PhotoSize {
  type: string
  w?: number
  h?: number
  bytes?: Buffer
}

interface MessageMediaPhoto {
  className: 'MessageMediaPhoto'
  photo: {
    sizes: PhotoSize[]
  }
}

function getLargestPhotoSize(sizes: PhotoSize[]): PhotoSize | null {
  // Filter out 's' type (strip thumbnails) and entries without width
  const candidates = sizes.filter(s => s.type !== 's' && s.w !== undefined)
  if (candidates.length === 0) return null
  return candidates.reduce((best, s) =>
    (s.w ?? 0) > (best.w ?? 0) ? s : best
  )
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Processes image messages for one chat: download -> store -> OCR -> persist.
 * Never throws; each image's failure is isolated and logged.
 */
export async function processImageMessages(
  client: TelegramClient,
  chatId: number,
  imageMsgs: RawTelegramMessage[],
  sleep: (ms: number) => Promise<void> = DEFAULT_SLEEP,
): Promise<void> {
  for (let i = 0; i < imageMsgs.length; i++) {
    const msg = imageMsgs[i]
    try {
      // Resolve DB id
      const id = getMessageIdByExternalId(chatId, String(msg.id))
      if (id === null) {
        console.log(`[telegram image-sync] message ${msg.id} not found in DB, skipping`)
        continue
      }

      // Check if already processed
      const row = getDb().prepare(
        'SELECT media_file_path, ocr_text FROM messages WHERE id = ?'
      ).get(id) as { media_file_path: string | null; ocr_text: string | null } | undefined

      if (row?.media_file_path) {
        // Already has media stored; skip
        continue
      }

      // Download buffer
      const buffer = await (client as unknown as { downloadMedia: (msg: unknown) => Promise<Buffer | undefined> })
        .downloadMedia(msg) as Buffer | undefined

      if (!buffer) {
        console.log(`[telegram image-sync] downloadMedia returned nothing for message ${msg.id}, skipping`)
        continue
      }

      // Store media
      const filePath = storeMedia({
        platform: 'telegram',
        chatId: chatId,
        externalId: String(msg.id),
        ext: 'jpg',
        data: buffer,
      })

      // Get width/height from photo sizes
      const media = msg.media as MessageMediaPhoto | undefined
      const sizes = media?.photo?.sizes ?? []
      const largest = getLargestPhotoSize(sizes)
      const width = largest?.w ?? null
      const height = largest?.h ?? null

      // Run OCR if not already done
      let ocrText: string | null = row?.ocr_text ?? null
      if (ocrText === null) {
        ocrText = await extractText(buffer)
      }

      // Persist to DB
      await updateMessageMedia(id, {
        media_file_path: filePath,
        media_width: width,
        media_height: height,
        ocr_text: ocrText,
      })
    } catch (err) {
      console.error(
        `[telegram image-sync] failed to process message ${msg.id}: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Sleep between downloads (except after the last one)
    if (i < imageMsgs.length - 1) {
      await sleep(1000)
    }
  }
}
