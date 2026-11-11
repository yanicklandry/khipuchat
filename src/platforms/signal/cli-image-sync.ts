/**
 * signal-cli image-attachment ingestion.
 *
 * signal-cli writes DECRYPTED attachments to its local attachments dir keyed by
 * the attachment `id`; there is no separate download API call. We read that file
 * and push it through the SHARED media-storage + OCR pipeline unchanged.
 *
 * Scope note (Requirement 6.5): encrypted media older than ~45 days is deleted
 * server-side and is unrecoverable via linking. A missing file is therefore a
 * clean per-item skip (message archived without media), never a sync failure.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SignalAttachment } from './cli-client'
import { getDb, getMessageIdByExternalId, updateMessageMedia } from '../../db'
import { storeMedia } from '../../media-storage'
import { extractText } from '../../ocr'

export interface CliImageItem {
  externalId: string
  attachment: SignalAttachment
}

/** Resolve the signal-cli attachments directory (override via env). */
export function attachmentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['SIGNAL_CLI_ATTACHMENTS_DIR']
  if (override) return override
  const dataHome = env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share')
  return path.join(dataHome, 'signal-cli', 'attachments')
}

export function extFromContentType(ct: string | undefined): string {
  if (ct === 'image/png') return 'png'
  if (ct === 'image/gif') return 'gif'
  if (ct === 'image/webp') return 'webp'
  return 'jpg'
}

/**
 * Store + OCR each image attachment. Idempotent (skips rows that already carry a
 * media path). Returns per-run counters. `skipped` counts missing/expired files
 * (not a failure); `failed` counts genuine store/OCR errors. Never aborts.
 */
export async function processCliImageMessages(
  chatId: number,
  items: readonly CliImageItem[],
): Promise<{ stored: number; failed: number; skipped: number }> {
  const dir = attachmentsDir()
  let stored = 0
  let failed = 0
  let skipped = 0

  for (const { externalId, attachment } of items) {
    try {
      const dbId = getMessageIdByExternalId(chatId, externalId)
      if (dbId === null) continue

      const row = getDb()
        .prepare('SELECT media_file_path, ocr_text FROM messages WHERE id = ?')
        .get(dbId) as { media_file_path: string | null; ocr_text: string | null } | undefined
      if (row?.media_file_path) continue

      const filePath = path.join(dir, attachment.id)
      let buffer: Buffer
      try {
        buffer = fs.readFileSync(filePath)
      } catch {
        // Missing/expired decrypted file: archive without media, keep going.
        skipped++
        continue
      }
      if (buffer.length === 0) {
        skipped++
        continue
      }

      const storedPath = storeMedia({
        platform: 'signal',
        chatId,
        externalId,
        ext: extFromContentType(attachment.contentType),
        data: buffer,
      })

      let ocrText: string | null = row?.ocr_text ?? null
      if (ocrText === null) ocrText = await extractText(buffer)

      updateMessageMedia(dbId, {
        media_file_path: storedPath,
        media_width: attachment.width ?? null,
        media_height: attachment.height ?? null,
        ocr_text: ocrText,
      })
      stored++
    } catch (err) {
      console.error(
        `[signal cli-image] failed to process ${externalId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      failed++
    }
  }

  return { stored, failed, skipped }
}
