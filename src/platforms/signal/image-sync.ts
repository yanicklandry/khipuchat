import fs from 'fs'
import type { BeeperMessage, BeeperSignalClient } from './client'
import { getDb, getMessageIdByExternalId, updateMessageMedia } from '../../db'
import { storeMedia } from '../../media-storage'
import { extractText } from '../../ocr'

type Attachment = NonNullable<BeeperMessage['attachments']>[number]

export function extFromMime(mimeType: string | undefined): string {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}

export function pickImageAttachment(msg: BeeperMessage): Attachment | null {
  const attachments = msg.attachments ?? []
  for (const att of attachments) {
    if (att.type === 'img' && (att.srcURL || att.id)) {
      return att
    }
  }
  return null
}

async function fetchSignalAttachment(
  client: Pick<BeeperSignalClient, 'fetchAttachmentBuffer'>,
  srcURL: string | undefined,
  id: string | undefined,
): Promise<Buffer | null> {
  const url = srcURL ?? id
  if (!url) return null
  const beeperBuf = await client.fetchAttachmentBuffer(url)
  if (beeperBuf !== null) return beeperBuf
  if (srcURL?.startsWith('file://')) {
    try {
      const path = srcURL.replace(/^file:\/\//, '')
      const buf = fs.readFileSync(path)
      if (buf.length > 0) return buf
    } catch {
      // fall through
    }
  }
  return null
}

export async function processSignalImageMessages(
  client: Pick<BeeperSignalClient, 'fetchAttachmentBuffer'>,
  chatId: number,
  imageMsgs: readonly BeeperMessage[],
): Promise<{ stored: number; failed: number }> {
  let stored = 0
  let failed = 0

  for (const m of imageMsgs) {
    try {
      const dbId = getMessageIdByExternalId(chatId, m.id)
      if (dbId === null) continue

      const row = getDb()
        .prepare('SELECT media_file_path, ocr_text FROM messages WHERE id = ?')
        .get(dbId) as { media_file_path: string | null; ocr_text: string | null } | undefined

      if (row?.media_file_path) continue

      const att = pickImageAttachment(m)
      if (!att) {
        console.log(`[signal image-sync] message ${m.id} has no image attachment, skipping`)
        continue
      }

      const buffer = await fetchSignalAttachment(client, att.srcURL, att.id)
      if (buffer === null) {
        failed++
        continue
      }

      const filePath = storeMedia({
        platform: 'signal',
        chatId,
        externalId: m.id,
        ext: extFromMime(att.mimeType),
        data: buffer,
      })

      const width = att.size?.width ?? null
      const height = att.size?.height ?? null

      let ocrText: string | null = row?.ocr_text ?? null
      if (ocrText === null) {
        ocrText = await extractText(buffer)
      }

      updateMessageMedia(dbId, {
        media_file_path: filePath,
        media_width: width,
        media_height: height,
        ocr_text: ocrText,
      })

      stored++
    } catch (err) {
      console.error(
        `[signal image-sync] failed to process message ${m.id}: ${err instanceof Error ? err.message : String(err)}`
      )
      failed++
    }
  }

  return { stored, failed }
}
