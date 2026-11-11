/**
 * signal-cli JSON-RPC wire types (the signal-cli envelope shape) plus the pure
 * envelope-extraction helper. Split out of cli-client.ts to keep each source
 * file under the project's 200-line ceiling; the runtime transport logic lives
 * in cli-client.ts and re-exports these names for backward compatibility.
 */

export type JsonRpcParams = Record<string, unknown>

// ── Wire types (signal-cli envelope shape) ────────────────────────────────────

export interface SignalAttachment {
  id: string
  contentType?: string
  filename?: string
  size?: number
  width?: number
  height?: number
}

export interface SignalQuote {
  id?: number
  author?: string
}

export interface SignalDataMessage {
  message?: string
  groupInfo?: { groupId: string }
  attachments?: SignalAttachment[]
  quote?: SignalQuote
}

export interface SignalSentMessage {
  destination?: string
  destinationNumber?: string
  destinationUuid?: string
  message?: string
  groupInfo?: { groupId: string }
  attachments?: SignalAttachment[]
  quote?: SignalQuote
  timestamp?: number
}

export interface SignalEnvelope {
  source?: string
  sourceNumber?: string
  sourceUuid?: string
  sourceName?: string
  timestamp: number
  dataMessage?: SignalDataMessage
  syncMessage?: { sentMessage?: SignalSentMessage }
  receiptMessage?: unknown
  typingMessage?: unknown
}

export type ReceiveHandler = (envelope: SignalEnvelope) => void

export interface SignalCliClient {
  request<T>(method: string, params?: JsonRpcParams): Promise<T>
  onReceive(handler: ReceiveHandler): void
  close(): void
}

export type ConnectResult =
  | { ok: true; client: SignalCliClient }
  | { ok: false; reason: 'unreachable' | 'not_installed'; message: string }

export interface SignalCliConnectOptions {
  socketPath?: string
  tcp?: { host: string; port: number }
}

/** Minimal duplex surface; net.Socket satisfies it and tests supply a fake. */
export interface RpcSocket {
  write(data: string): void
  on(event: string, listener: (...args: unknown[]) => void): void
  destroy(): void
}

/** Extract an envelope from a `receive` notification param or a queued item. */
export function extractEnvelope(item: unknown): SignalEnvelope | null {
  if (typeof item !== 'object' || item === null) return null
  const obj = item as Record<string, unknown>
  const env = (obj['envelope'] ?? obj) as Record<string, unknown>
  if (typeof env['timestamp'] === 'number') return env as unknown as SignalEnvelope
  return null
}
