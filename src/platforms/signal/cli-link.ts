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

/**
 * CLI orchestration for `khipu sync signal --link`: connect to the signal-cli
 * daemon, run the link flow, print the outcome, and set the process exit code.
 * Extracted out of signal/sync.ts's main() to keep that file under the
 * project's 200-line-per-file convention.
 */
export async function runLinkCommand(): Promise<void> {
  const { connectSignalCli } = await import('./cli-client')
  const socketPath = process.env['SIGNAL_CLI_SOCKET']
  const conn = await connectSignalCli(socketPath ? { socketPath } : {})
  if (!conn.ok) {
    process.stderr.write(`[signal] ${conn.message}\n`)
    process.exit(1)
    return
  }
  try {
    const outcome = await linkSignalCli(conn.client)
    if (outcome.status === 'linked') {
      console.log(`[signal] Linked as "${outcome.deviceName}". Run \`SIGNAL_BACKEND=cli khipu sync signal\` to ingest.`)
    } else if (outcome.status === 'already_linked') {
      console.log('[signal] Already linked. Run a normal sync to ingest.')
    } else if (outcome.status === 'timeout') {
      process.stderr.write('[signal] Linking timed out before the QR was approved. Nothing was ingested.\n')
      process.exit(1)
    } else {
      process.stderr.write(`[signal] Linking failed: ${outcome.message}\n`)
      process.exit(1)
    }
  } finally {
    conn.client.close()
  }
}
