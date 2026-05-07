import {
  siTelegram,
  siWechat,
  siDiscord,
  siWhatsapp,
  siImessage,
  siGmail,
} from 'simple-icons'

const KNOWN: Record<string, { svg: string }> = {
  telegram: siTelegram,
  wechat: siWechat,
  discord: siDiscord,
  whatsapp: siWhatsapp,
  imessage: siImessage,
  email: siGmail,
}

/** Resize a simple-icons SVG string to the given pixel size and use currentColor fill. */
function resizeSvg(svg: string, size: number): string {
  return svg.replace(
    '<svg ',
    `<svg width="${size}" height="${size}" fill="currentColor" `,
  )
}

/**
 * Returns a JSON-serialisable map of platform → SVG HTML string (16 px, currentColor).
 * Platforms without a known icon are not included; the caller renders a letter fallback.
 */
export function buildPlatformIconMap(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [platform, icon] of Object.entries(KNOWN)) {
    result[platform] = resizeSvg(icon.svg, 16)
  }
  return result
}
