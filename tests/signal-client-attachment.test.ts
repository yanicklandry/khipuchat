import { describe, it, expect, vi } from 'vitest'
import { createSignalAttachmentFetcher } from '../src/platforms/signal/image-sync'

// ── fetchAttachmentBuffer (owned by signal-image-sync) ────────────────────────

vi.mock('@beeper/desktop-api', () => {
  const mockBeeper = {
    assets: {
      serve: vi.fn(),
    },
  }

  const BeeperDesktop = vi.fn().mockReturnValue(mockBeeper)
  class APIConnectionError extends Error {}
  class AuthenticationError extends Error {}

  return { BeeperDesktop, APIConnectionError, AuthenticationError, _mockBeeper: mockBeeper }
})

describe('createSignalAttachmentFetcher.fetchAttachmentBuffer', () => {
  it('is exposed on the fetcher', () => {
    const fetcher = createSignalAttachmentFetcher('fake-token')
    expect(typeof fetcher.fetchAttachmentBuffer).toBe('function')
  })

  it('returns a Buffer when assets.serve returns a response with body', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    const fakeData = Buffer.from('fake-image-data')
    const fakeResponse = {
      arrayBuffer: vi.fn().mockResolvedValue(fakeData.buffer.slice(fakeData.byteOffset, fakeData.byteOffset + fakeData.byteLength)),
    }
    _mockBeeper.assets.serve.mockResolvedValue(fakeResponse)

    const fetcher = createSignalAttachmentFetcher('fake-token')
    const result = await fetcher.fetchAttachmentBuffer('beeper://some/asset/url')

    expect(_mockBeeper.assets.serve).toHaveBeenCalledWith({ url: 'beeper://some/asset/url' })
    expect(result).toBeInstanceOf(Buffer)
    expect(result!.length).toBeGreaterThan(0)
  })

  it('returns null when assets.serve throws', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.assets.serve.mockRejectedValue(new Error('Network error'))

    const fetcher = createSignalAttachmentFetcher('fake-token')
    const result = await fetcher.fetchAttachmentBuffer('beeper://invalid/url')

    expect(result).toBeNull()
  })

  it('does not throw when assets.serve throws', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.assets.serve.mockRejectedValue(new Error('Network error'))

    const fetcher = createSignalAttachmentFetcher('fake-token')
    await expect(fetcher.fetchAttachmentBuffer('beeper://invalid/url')).resolves.toBeNull()
  })

  it('returns null when response body is empty (zero-length)', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    const emptyResponse = {
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    }
    _mockBeeper.assets.serve.mockResolvedValue(emptyResponse)

    const fetcher = createSignalAttachmentFetcher('fake-token')
    const result = await fetcher.fetchAttachmentBuffer('beeper://empty/asset')

    expect(result).toBeNull()
  })

  it('returns null when arrayBuffer() throws', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    const badResponse = {
      arrayBuffer: vi.fn().mockRejectedValue(new Error('Read error')),
    }
    _mockBeeper.assets.serve.mockResolvedValue(badResponse)

    const fetcher = createSignalAttachmentFetcher('fake-token')
    const result = await fetcher.fetchAttachmentBuffer('beeper://bad/body')

    expect(result).toBeNull()
  })
})
