import { describe, it, expect } from 'vitest'
import {
  selectedSignalBackend,
  resolveSignalFactory,
  signalCliConfigured,
} from '../src/platforms/signal/backend'
import { createSignalAdapter } from '../src/platforms/signal/sync'
import { createSignalCliAdapter } from '../src/platforms/signal/cli-sync'
import { loadRegistry } from '../src/account-registry'

const NO_CONFIG = '/nonexistent/khipu.config.json'

describe('selectedSignalBackend', () => {
  it('defaults to beeper when SIGNAL_BACKEND is unset', () => {
    expect(selectedSignalBackend({})).toBe('beeper')
  })
  it('defaults to beeper for any unrecognized value', () => {
    expect(selectedSignalBackend({ SIGNAL_BACKEND: 'other' })).toBe('beeper')
  })
  it('selects cli for SIGNAL_BACKEND=cli (case-insensitive)', () => {
    expect(selectedSignalBackend({ SIGNAL_BACKEND: 'CLI' })).toBe('cli')
  })
})

describe('resolveSignalFactory', () => {
  it('returns the Beeper factory by default', () => {
    expect(resolveSignalFactory({})).toBe(createSignalAdapter)
  })
  it('returns the signal-cli factory when cli is selected, without a Beeper token', () => {
    expect(resolveSignalFactory({ SIGNAL_BACKEND: 'cli' })).toBe(createSignalCliAdapter)
  })
  it('cli factory builds an adapter with platform signal and a no-op startListener', () => {
    const factory = resolveSignalFactory({ SIGNAL_BACKEND: 'cli' })
    const adapter = factory('default', { name: 'default', fields: {} })
    expect(adapter.platform).toBe('signal')
    // startListener is a no-op — calling it must not throw and must return void.
    expect(adapter.startListener(undefined as never)).toBeUndefined()
    expect(typeof adapter.syncIncremental).toBe('function')
  })
})

describe('signalCliConfigured', () => {
  it('is false by default (beeper)', () => {
    expect(signalCliConfigured({})).toBe(false)
  })
  it('is true when SIGNAL_BACKEND=cli', () => {
    expect(signalCliConfigured({ SIGNAL_BACKEND: 'cli' })).toBe(true)
  })
})

describe('account-registry — signal-cli synthesis', () => {
  it('synthesizes a default signal account for cli without BEEPER_ACCESS_TOKEN', () => {
    const reg = loadRegistry(NO_CONFIG, { SIGNAL_BACKEND: 'cli' })
    expect(reg.listAccounts('signal')).toEqual(['default'])
    expect(reg.credentialsFor('signal', 'default').fields).toEqual({})
  })

  it('carries SIGNAL_CLI_SOCKET into the synthesized account fields', () => {
    const reg = loadRegistry(NO_CONFIG, { SIGNAL_BACKEND: 'cli', SIGNAL_CLI_SOCKET: '/run/sig.sock' })
    expect(reg.credentialsFor('signal', 'default').fields).toEqual({ SIGNAL_CLI_SOCKET: '/run/sig.sock' })
  })

  it('does not synthesize a signal account when the backend is beeper (no token)', () => {
    const reg = loadRegistry(NO_CONFIG, {})
    expect(reg.listAccounts('signal')).toEqual([])
  })

  it('keeps the Beeper-token account when a token is present (cli synthesis is additive)', () => {
    const reg = loadRegistry(NO_CONFIG, { SIGNAL_BACKEND: 'cli', BEEPER_ACCESS_TOKEN: 'tok' })
    expect(reg.listAccounts('signal')).toEqual(['default'])
    expect(reg.credentialsFor('signal', 'default').fields).toEqual({ BEEPER_ACCESS_TOKEN: 'tok' })
  })
})
