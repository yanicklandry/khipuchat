import { describe, it, expect } from 'vitest'
import { buildPlatformIconMap } from '../src/web/icons'

describe('buildPlatformIconMap', () => {
  const map = buildPlatformIconMap()

  it('includes an icon for each known platform', () => {
    for (const platform of ['telegram', 'wechat', 'discord', 'whatsapp', 'imessage', 'email']) {
      expect(map[platform], `missing icon for ${platform}`).toBeTruthy()
    }
  })

  it('does not include platforms without a known icon (caller renders letter fallback)', () => {
    // slack and signal have no simple-icons entry wired in KNOWN
    expect(map['slack']).toBeUndefined()
    expect(map['signal']).toBeUndefined()
  })

  it('renders each icon as a 16px inline SVG using currentColor', () => {
    for (const svg of Object.values(map)) {
      expect(svg).toContain('<svg ')
      expect(svg).toContain('width="16"')
      expect(svg).toContain('height="16"')
      expect(svg).toContain('fill="currentColor"')
    }
  })

  it('strips the xmlns attribute (not needed for inline HTML5 SVG)', () => {
    for (const svg of Object.values(map)) {
      expect(svg).not.toContain('xmlns=')
    }
  })

  it('produces a JSON-serialisable map (safe to embed as PLATFORM_ICONS)', () => {
    expect(() => JSON.parse(JSON.stringify(map))).not.toThrow()
  })
})
