/**
 * Signal backend selector.
 *
 * Chooses which Signal `AdapterFactory` is active via the `SIGNAL_BACKEND` env
 * var: `beeper` (DEFAULT — existing behavior, byte-for-byte preserved) or `cli`
 * (the new signal-cli backend). Both factories emit `platform: 'signal'`, so
 * query surfaces are unaffected. Selecting `cli` must not require
 * `BEEPER_ACCESS_TOKEN`; selecting `beeper` must not require signal-cli.
 */

import type { AdapterFactory } from '../types'
import { createSignalAdapter } from './sync'
import { createSignalCliAdapter } from './cli-sync'

export type SignalBackend = 'beeper' | 'cli'

export function selectedSignalBackend(env: NodeJS.ProcessEnv = process.env): SignalBackend {
  return (env['SIGNAL_BACKEND'] ?? '').toLowerCase() === 'cli' ? 'cli' : 'beeper'
}

export function resolveSignalFactory(env: NodeJS.ProcessEnv = process.env): AdapterFactory {
  return selectedSignalBackend(env) === 'cli' ? createSignalCliAdapter : createSignalAdapter
}

/** True when the signal-cli backend is selected (its configuration probe). */
export function signalCliConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return selectedSignalBackend(env) === 'cli'
}
