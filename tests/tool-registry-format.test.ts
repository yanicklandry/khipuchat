import { describe, it, expect } from 'vitest'
import { toToolContent } from '../src/tool-registry'

// The previous inline wrapping in src/mcp.ts CallTool handler.
const previousInline = (result: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] })

describe('toToolContent', () => {
  const samples: unknown[] = [
    [{ id: 1, name: 'Tony Lin', platform: 'telegram' }],
    { error: 'Unknown tool: nope' },
    { text: 'héllo 你好 😀', nested: { a: [1, 2, null] } },
    [],
    'plain string',
    42,
    null,
  ]

  it.each(samples.map((s) => [s]))('matches the previous inline shape for %j', (result) => {
    expect(toToolContent(result)).toEqual(previousInline(result))
  })

  it('returns a single text content item holding the JSON-serialized result', () => {
    const out = toToolContent({ ok: true })
    expect(out.content).toHaveLength(1)
    expect(out.content[0]?.type).toBe('text')
    expect(JSON.parse(out.content[0]?.text ?? '')).toEqual({ ok: true })
  })
})
