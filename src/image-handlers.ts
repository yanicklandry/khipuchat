import * as fs from 'fs'
import { getDb } from './db'

export interface GetImageResult {
  message_id: number
  file_path: string
  content_base64: string
  ocr_text: string | null
  ocr_available: boolean
}

interface MessageImageRow {
  id: number
  media_file_path: string | null
  ocr_text: string | null
}

export async function handleGetImage(messageId: number): Promise<GetImageResult> {
  const row = getDb()
    .prepare('SELECT id, media_file_path, ocr_text FROM messages WHERE id = ?')
    .get(messageId) as MessageImageRow | undefined

  if (!row) throw new Error(`message not found: ${messageId}`)
  if (!row.media_file_path) throw new Error(`image not available for message ${messageId}: no media_file_path`)

  let data: Buffer
  try {
    data = fs.readFileSync(row.media_file_path) as Buffer
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error(`image file not found on disk: ${row.media_file_path}`)
    throw err
  }

  return {
    message_id: row.id,
    file_path: row.media_file_path,
    content_base64: data.toString('base64'),
    ocr_text: row.ocr_text ?? null,
    ocr_available: row.ocr_text !== null,
  }
}
