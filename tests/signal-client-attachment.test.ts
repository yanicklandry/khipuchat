import { describe, it, expect, vi } from 'vitest'
import { createBeeperSignalClient } from '../src/platforms/signal/client'
import type { BeeperSignalClient } from '../src/platforms/signal/client'

// ── fetchAttachmentBuffer ─────────────────────────────────────────────────────

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

describe('BeeperSignalClient.fetchAttachmentBuffer', () => {
  it('is exposed on the client interface', () => {
    const client: BeeperSignalClient = createBeeperSignalClient('fake-token')
    expect(typeof client.fetchAttachmentBuffer).toBe('function')
  })

  it('returns a Buffer when assets.serve returns a response with body', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    const fakeData = Buffer.from('fake-image-data')
    const fakeResponse = {
      arrayBuffer: vi.fn().mockResolvedValue(fakeData.buffer.slice(fakeData.byteOffset, fakeData.byteOffset + fakeData.byteLength)),
    }
    _mockBeeper.assets.serve.mockResolvedValue(fakeResponse)

    const client = createBeeperSignalClient('fake-token')
    const result = await client.fetchAttachmentBuffer('beeper://some/asset/url')

    expect(_mockBeeper.assets.serve).toHaveBeenCalledWith({ url: 'beeper://some/asset/url' })
    expect(result).toBeInstanceOf(Buffer)
    expect(result!.length).toBeGreaterThan(0)
  })

  it('returns null when assets.serve throws', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.assets.serve.mockRejectedValue(new Error('Network error'))

    const client = createBeeperSignalClient('fake-token')
    const result = await client.fetchAttachmentBuffer('beeper://invalid/url')

    expect(result).toBeNull()
  })

  it('does not throw when assets.serve throws', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    _mockBeeper.assets.serve.mockRejectedValue(new Error('Network error'))

    const client = createBeeperSignalClient('fake-token')
    await expect(client.fetchAttachmentBuffer('beeper://invalid/url')).resolves.toBeNull()
  })

  it('returns null when response body is empty (zero-length)', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    const emptyResponse = {
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    }
    _mockBeeper.assets.serve.mockResolvedValue(emptyResponse)

    const client = createBeeperSignalClient('fake-token')
    const result = await client.fetchAttachmentBuffer('beeper://empty/asset')

    expect(result).toBeNull()
  })

  it('returns null when arrayBuffer() throws', async () => {
    const { _mockBeeper } = await import('@beeper/desktop-api') as any
    const badResponse = {
      arrayBuffer: vi.fn().mockRejectedValue(new Error('Read error')),
    }
    _mockBeeper.assets.serve.mockResolvedValue(badResponse)

    const client = createBeeperSignalClient('fake-token')
    const result = await client.fetchAttachmentBuffer('beeper://bad/body')

    expect(result).toBeNull()
  })
})
