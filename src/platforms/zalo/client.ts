/**
 * ZaloClient: a narrow, mockable port over the unofficial `zca-js` library.
 *
 * Owns QR login, local session persistence (write/read cookie+imei+userAgent),
 * reconnect-from-session, friend enumeration, and the message listener lifecycle.
 * `zca-js` is dynamically imported so tests never load or log into the real
 * library. Session credentials are stored only on the local machine and are
 * never transmitted anywhere except Zalo.
 *
 * Confirmed against zca-js@2.2.0 (see tasks.md ## Implementation Notes).
 */
import { readSession, writeSession, resolveSessionPath, type SavedSession } from './session'

export enum ZaloThreadType {
  User = 0,
  Group = 1,
}

export interface ZaloThread {
  threadId: string
  name: string
}

export interface ZaloMessage {
  msgId: string
  threadId: string
  threadType: ZaloThreadType
  isSelf: boolean
  senderId: string | null
  senderName: string | null
  /** Raw content: string for text messages, non-string for rich/attachment content. */
  content: unknown
  /** Epoch milliseconds. */
  ts: number
}

export interface ZaloClient {
  /** Enumerate DM contacts/threads to seed chat metadata (best-effort; may be empty). */
  getFriends(): Promise<ZaloThread[]>
  /** Register a handler for incoming message events. */
  onMessage(handler: (msg: ZaloMessage) => void): void
  /** Begin listening (idempotent). */
  start(): void
  /** Stop the listener and release the session connection. */
  stop(): Promise<void>
}

export interface CreateZaloClientOptions {
  /** Session credential file location; defaults to a local path when omitted. */
  sessionPath?: string
  debug?: boolean
}

// ── Confirmed zca-js@2.2.0 shapes (only the fields this adapter reads) ──────────

interface RawUser { userId: string; displayName?: string; zaloName?: string }

interface RawTMessage {
  msgId: string
  uidFrom: string
  dName: string
  ts: string
  content: unknown
}

interface RawMessage {
  type: number // ThreadType: User=0, Group=1
  threadId: string
  isSelf: boolean
  data: RawTMessage
}

interface RawListener {
  on(event: 'message', cb: (m: RawMessage) => void): void
  start(opts?: { retryOnClose?: boolean }): void
  stop(): void
}

interface RawApi {
  listener: RawListener
  getAllFriends(count?: number, page?: number): Promise<RawUser[]>
}

// LoginQRCallbackEventType (zca-js): QRCodeGenerated=0, QRCodeScanned=2, GotLoginInfo=4
const QR_GENERATED = 0
const QR_SCANNED = 2
const GOT_LOGIN_INFO = 4

interface RawQrEvent {
  type: number
  data: { code?: string; imei?: string; userAgent?: string; cookie?: unknown } | null
}

interface RawZalo {
  login(creds: SavedSession): Promise<RawApi>
  loginQR(
    options?: { userAgent?: string; language?: string; qrPath?: string },
    callback?: (event: RawQrEvent) => void,
  ): Promise<RawApi>
}

interface ZaloModule {
  Zalo: new (options?: Record<string, unknown>) => RawZalo
}

type QrcodeTerminal = { generate(text: string, opts?: { small?: boolean }): void }

function normalize(m: RawMessage): ZaloMessage {
  return {
    msgId: m.data.msgId,
    threadId: m.threadId,
    threadType: m.type === ZaloThreadType.Group ? ZaloThreadType.Group : ZaloThreadType.User,
    isSelf: Boolean(m.isSelf),
    senderId: m.data.uidFrom || null,
    senderName: m.data.dName || null,
    content: m.data.content,
    ts: Number(m.data.ts) || 0,
  }
}

function wrapApi(api: RawApi): ZaloClient {
  return {
    async getFriends(): Promise<ZaloThread[]> {
      const users = await api.getAllFriends().catch(() => [] as RawUser[])
      return users.map((u) => ({ threadId: u.userId, name: u.displayName || u.zaloName || u.userId }))
    },
    onMessage(handler): void {
      api.listener.on('message', (m) => handler(normalize(m)))
    },
    start(): void {
      api.listener.start()
    },
    async stop(): Promise<void> {
      api.listener.stop()
    },
  }
}

async function loginWithQr(zalo: RawZalo, sessionPath: string): Promise<RawApi> {
  const raw = (await import('qrcode-terminal')) as unknown
  const qrGen = ((raw as { default?: QrcodeTerminal }).default ?? (raw as QrcodeTerminal))
  return zalo.loginQR({}, (event) => {
    if (event.type === QR_GENERATED && event.data?.code) {
      process.stdout.write('\n')
      qrGen.generate(event.data.code, { small: true })
      console.log('[zalo] Scan the QR code above with the Zalo mobile app.')
    } else if (event.type === QR_SCANNED) {
      console.log('[zalo] QR scanned — finishing login…')
    } else if (event.type === GOT_LOGIN_INFO && event.data?.imei && event.data.userAgent) {
      writeSession(sessionPath, { imei: event.data.imei, cookie: event.data.cookie, userAgent: event.data.userAgent })
      console.log(`[zalo] Session saved to ${sessionPath}. Later syncs reconnect without a QR scan.`)
    }
  })
}

/** Logs in (saved session or QR) and resolves a connected client. */
export async function createZaloClient(opts: CreateZaloClientOptions = {}): Promise<ZaloClient> {
  const { debug = false } = opts
  const sessionPath = resolveSessionPath(opts.sessionPath)

  // Dynamic import so tests mock zca-js without touching the network.
  const mod = (await import('zca-js')) as unknown as ZaloModule
  // selfListen:true so outgoing (isSelf) DMs are captured too, for a full archive.
  const zalo = new mod.Zalo({ selfListen: true, logging: debug, checkUpdate: false })

  const saved = readSession(sessionPath)
  if (saved) {
    try {
      return wrapApi(await zalo.login(saved))
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Saved Zalo session at ${sessionPath} was rejected (${m}). Remove that file and re-run to scan a new QR code. ` +
          'zca-js is an unofficial client and carries account-lock risk.',
      )
    }
  }

  try {
    return wrapApi(await loginWithQr(zalo, sessionPath))
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    throw new Error(`Zalo QR login failed (${m}). zca-js is an unofficial client and carries account-lock risk.`)
  }
}
