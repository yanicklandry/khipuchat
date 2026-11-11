import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('qrcode-terminal', () => ({ generate: vi.fn() }))

import { generate as generateQr } from 'qrcode-terminal'
import { linkSignalCli } from '../src/platforms/signal/cli-link'
import type { SignalCliClient } from '../src/platforms/signal/cli-client'

interface Handlers {
  startLink?: () => Promise<unknown>
  finishLink?: () => Promise<unknown>
}

function makeClient(h: Handlers): SignalCliClient {
  return {
    async request<T>(method: string): Promise<T> {
      if (method === 'startLink') return (await (h.startLink?.() ?? Promise.resolve({ deviceLinkUri: 'sgnl://linkdevice?x=1' }))) as T
      if (method === 'finishLink') return (await (h.finishLink?.() ?? Promise.resolve({}))) as T
      return undefined as T
    },
    onReceive() {},
    close() {},
  }
}

beforeEach(() => vi.clearAllMocks())

describe('linkSignalCli', () => {
  it('renders the QR + URI and returns linked on approval', async () => {
    const client = makeClient({ finishLink: () => Promise.resolve({ account: '+1' }) })
    const outcome = await linkSignalCli(client, 'MyDevice')
    expect(outcome).toEqual({ status: 'linked', deviceName: 'MyDevice' })
    expect(generateQr).toHaveBeenCalledWith('sgnl://linkdevice?x=1', { small: true })
  })

  it('returns timeout when finishLink does not resolve within the window', async () => {
    const client = makeClient({ finishLink: () => new Promise(() => {}) }) // never resolves
    const outcome = await linkSignalCli(client, 'MyDevice', 20)
    expect(outcome).toEqual({ status: 'timeout' })
    expect(generateQr).toHaveBeenCalled()
  })

  it('returns failed when startLink yields no device-link URI', async () => {
    const client = makeClient({ startLink: () => Promise.resolve({}) })
    const outcome = await linkSignalCli(client)
    expect(outcome.status).toBe('failed')
  })

  it('returns already_linked when finishLink reports an existing link', async () => {
    const client = makeClient({ finishLink: () => Promise.reject(new Error('Device already linked')) })
    const outcome = await linkSignalCli(client)
    expect(outcome.status).toBe('already_linked')
  })

  it('returns failed on a generic finishLink error', async () => {
    const client = makeClient({ finishLink: () => Promise.reject(new Error('provisioning rejected')) })
    const outcome = await linkSignalCli(client)
    expect(outcome).toEqual({ status: 'failed', message: 'provisioning rejected' })
  })
})
