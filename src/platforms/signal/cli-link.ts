/**
 * Secondary-device linking flow for the signal-cli backend.
 *
 * Links KhipuChat to the operator's EXISTING Signal account as a secondary
 * device (no phone-number registration). `startLink` yields a `sgnl://linkdevice`
 * URI which we print and render as a terminal QR; `finishLink` blocks until the
 * primary phone approves. This flow never ingests messages.
 *
 * `qrcode-terminal` is already a project dependency (used by the whatsapp
 * adapter); types resolve from the installed `@types/qrcode-terminal`.
 */

import type { SignalCliClient } from './cli-client'

// qrcode-terminal is CJS; under tsx dynamic import its exports live on .default.
// `generate` must be called as a method (it reads `this.error`) — destructuring
// it and calling it standalone loses that binding and crashes.
type QrcodeTerminal = { generate(text: string, opts?: { small?: boolean }): void }

export type LinkOutcome =
  | { status: 'linked'; deviceName: string }
  | { status: 'timeout' }
  | { status: 'failed'; message: string }
  | { status: 'already_linked' }

interface StartLinkResult {
  deviceLinkUri?: string
}

const DEFAULT_LINK_TIMEOUT_MS = 120_000

/**
 * Run the link flow. Resolves to a linked/timeout/failed/already_linked outcome.
 * Presents the URI + QR before awaiting primary approval within a bounded window.
 */
export async function linkSignalCli(
  client: SignalCliClient,
  deviceName = 'KhipuChat',
  timeoutMs = DEFAULT_LINK_TIMEOUT_MS,
): Promise<LinkOutcome> {
  let start: StartLinkResult
  try {
    start = await client.request<StartLinkResult>('startLink', {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/already.*(linked|registered)/i.test(msg)) return { status: 'already_linked' }
    return { status: 'failed', message: msg }
  }

  const uri = start?.deviceLinkUri
  if (!uri) return { status: 'failed', message: 'signal-cli did not return a device-link URI' }

  console.log('\nScan this QR with Signal on your phone (Settings -> Linked devices -> Link new device):\n')
  const qrcodeRaw = await import('qrcode-terminal') as unknown
  const qrGen = ((qrcodeRaw as { default?: QrcodeTerminal }).default
    ?? (qrcodeRaw as QrcodeTerminal))
  qrGen.generate(uri, { small: true })
  console.log(`\nOr open this link on the phone:\n${uri}\n`)

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref()
  })

  try {
    const result = await Promise.race([
      client.request<unknown>('finishLink', { deviceLinkUri: uri, deviceName }).then(() => 'ok' as const),
      timeout,
    ])
    if (result === 'timeout') return { status: 'timeout' }
    return { status: 'linked', deviceName }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/already.*(linked|registered)/i.test(msg)) return { status: 'already_linked' }
    return { status: 'failed', message: msg }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
