import * as fs from 'fs'
import { getDb } from './db'
import type { MessageType } from './db'

export interface GetImageResultAvailable {
  message_id: number
  type: 'image'
  file_available: true
  file_path: string
  content_base64: string
  ocr_text: string | null
  ocr_available: boolean
}

export interface GetImageResultUnavailable {
  message_id: number
  type: 'image'
  file_available: false
  file_path: string | null
  ocr_text: string | null
  ocr_available: boolean
  error: string
}

export type GetImageResult = GetImageResultAvailable | GetImageResultUnavailable

interface MessageImageRow {
  id: number
  type: MessageType
  media_file_path: string | null
  ocr_text: string | null
}

export async function handleGetImage(messageId: number): Promise<GetImageResult> {
  const row = getDb()
    .prepare('SELECT id, type, media_file_path, ocr_text FROM messages WHERE id = ?')
    .get(messageId) as MessageImageRow | undefined

  if (!row) throw new Error(`message not found: ${messageId}`)
  if (row.type !== 'image') throw new Error(`message ${messageId} has type '${row.type}', not supported by get_image`)

  if (!row.media_file_path) {
    return {
      message_id: row.id,
      type: 'image' as const,
      file_available: false as const,
      file_path: null,
      ocr_text: row.ocr_text ?? null,
      ocr_available: row.ocr_text !== null,
      error: `image file unavailable for message ${messageId}: no media_file_path recorded`,
    }
  }

  let data: Buffer
  try {
    data = fs.readFileSync(row.media_file_path) as Buffer
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        message_id: row.id,
        type: 'image' as const,
        file_available: false as const,
        file_path: row.media_file_path,
        ocr_text: row.ocr_text ?? null,
        ocr_available: row.ocr_text !== null,
        error: `image file not found on disk for message ${messageId}: ${row.media_file_path}`,
      }
    }
    throw err
  }

  return {
    message_id: row.id,
    type: 'image' as const,
    file_available: true as const,
    file_path: row.media_file_path,
    content_base64: data.toString('base64'),
    ocr_text: row.ocr_text ?? null,
    ocr_available: row.ocr_text !== null,
  }
}
