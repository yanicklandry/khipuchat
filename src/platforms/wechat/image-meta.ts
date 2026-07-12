import type { WechatMessageRow } from './sync'

export interface ImageMeta {
  media_file_path: string | null
  media_url: string | null
  media_width: number | null
  media_height: number | null
}

const NULL_META: ImageMeta = {
  media_file_path: null,
  media_url: null,
  media_width: null,
  media_height: null,
}

function parseAttr(xml: string, attrName: string): string | null {
  const re = new RegExp(`${attrName}="([^"]*)"`)
  const m = re.exec(xml)
  return m ? m[1] : null
}

function parseIntOrNull(value: string | null): number | null {
  if (value === null) return null
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

export function extractImageMeta(row: WechatMessageRow, isV4: boolean): ImageMeta {
  try {
    const content = isV4
      ? row.message_content
      : (row.strContent ?? row.Message)

    if (content == null) return { ...NULL_META }

    if (Buffer.isBuffer(content)) return { ...NULL_META }

    // Bare non-XML path: no '<' character
    if (!content.includes('<')) {
      return {
        media_file_path: content,
        media_url: null,
        media_width: null,
        media_height: null,
      }
    }

    // XML content: parse attributes from img element
    const thumbUrl = parseAttr(content, 'cdnthumburl')
    const midUrl = parseAttr(content, 'cdnmidimgurl')
    const widthStr = parseAttr(content, 'cdnthumbwidth')
    const heightStr = parseAttr(content, 'cdnthumbheight')

    const media_url = thumbUrl ?? midUrl
    const media_width = parseIntOrNull(widthStr)
    const media_height = parseIntOrNull(heightStr)

    // Try to extract a file path from the XML (look for path-like attribute or text)
    const pathMatch = /media_file_path="([^"]+)"/.exec(content)
    const media_file_path = pathMatch ? pathMatch[1] : null

    // If nothing useful was found at all, return all-null
    if (media_url === null && media_file_path === null && media_width === null && media_height === null) {
      return { ...NULL_META }
    }

    return { media_file_path, media_url, media_width, media_height }
  } catch {
    return { ...NULL_META }
  }
}
