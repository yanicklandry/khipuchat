import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { NewMessage } from 'telegram/events'
import { config, saveSessionString, type Config } from './config'
import { initDb, upsertChat, insertMessage, getLastSyncedId, type Chat, type Message, type MessageType } from './db'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PromptFn = (question: string) => Promise<string>

export interface WizardConfig {
  sessionString: string
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// ── Entity helpers ────────────────────────────────────────────────────────────

interface EntityLike {
  className: string
  id: bigint
  firstName?: string
  lastName?: string | null
  username?: string | null
  title?: string
  broadcast?: boolean
  bot?: boolean
}

function entityToChat(entity: EntityLike): Chat | null {
  if (entity.className === 'User') {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ') || 'Unknown'
    return { id: Number(entity.id), name, type: 'user', username: entity.username ?? null }
  }
  if (entity.className === 'Chat') {
    return { id: Number(entity.id), name: entity.title ?? 'Unknown', type: 'group', username: null }
  }
  if (entity.className === 'Channel') {
    if (entity.broadcast) return null
    return { id: Number(entity.id), name: entity.title ?? 'Unknown', type: 'group', username: entity.username ?? null }
  }
  return null
}

// ── Message helpers ───────────────────────────────────────────────────────────

interface MsgLike {
  className: string
  id: number
  message?: string
  date: number
  fromId?: { className: string; userId?: bigint }
  peerId?: { className: string; userId?: bigint; chatId?: bigint; channelId?: bigint }
  media?: unknown
  replyTo?: { replyToMsgId?: number }
  out?: boolean
}

function detectType(msg: MsgLike): MessageType {
  if (!msg.media) return 'text'
  const m = msg.media as Record<string, unknown>
  if (m['className'] === 'MessageMediaDocument') {
    const doc = m['document'] as Record<string, unknown> | undefined
    const attrs = (doc?.['attributes'] as Array<Record<string, unknown>>) ?? []
    if (attrs.some(a => a['className'] === 'DocumentAttributeAudio' && a['voice'])) return 'voice'
    if (attrs.some(a => a['className'] === 'DocumentAttributeVideo')) return 'video'
    if (attrs.some(a => a['className'] === 'DocumentAttributeSticker')) return 'sticker'
  }
  if (m['className'] === 'MessageMediaPhoto') return 'image'
  return 'notice'
}

function getPeerChatId(peer: MsgLike['peerId']): number | null {
  if (!peer) return null
  if (peer.className === 'PeerUser' && peer.userId !== undefined) return Number(peer.userId)
  if (peer.className === 'PeerChat' && peer.chatId !== undefined) return Number(peer.chatId)
  if (peer.className === 'PeerChannel' && peer.channelId !== undefined) return Number(peer.channelId)
  return null
}

function msgToRow(msg: MsgLike, chatId: number): Message | null {
  if (msg.className !== 'Message') return null
  return {
    telegram_id: String(msg.id),
    chat_id: chatId,
    sender_id: msg.fromId?.userId !== undefined ? String(msg.fromId.userId) : null,
    sender_name: null,
    text: msg.message ?? null,
    type: detectType(msg),
    timestamp: msg.date,
    is_sender: msg.out ? 1 : 0,
    reply_to_telegram_id: msg.replyTo?.replyToMsgId !== undefined
      ? String(msg.replyTo.replyToMsgId) : null,
  }
}

// ── Auth wizard ───────────────────────────────────────────────────────────────

export async function runAuthWizard(
  client: TelegramClient,
  promptFn: PromptFn,
  cfg: WizardConfig = config,
  envPath?: string,
): Promise<void> {
  if (cfg.sessionString) {
    await client.connect()
    return
  }
  await client.start({
    phoneNumber: () => promptFn('Phone number: '),
    phoneCode: () => promptFn('Enter OTP: '),
    password: () => promptFn('2FA password: '),
    onError: (err: Error) => { console.error('Auth error:', err.message) },
  })
  const sessionStr = client.session.save() as unknown as string
  saveSessionString(sessionStr, envPath)
  console.log('Auth saved')
}

// ── Backfill ──────────────────────────────────────────────────────────────────

export async function runBackfill(
  client: TelegramClient,
  sleep: (ms: number) => Promise<void> = DEFAULT_SLEEP,
  pageSize = 100,
): Promise<void> {
  const dialogs = await client.getDialogs({ limit: 500 }) as Array<{ entity: EntityLike }>

  for (let i = 0; i < dialogs.length; i++) {
    const chat = entityToChat(dialogs[i].entity)
    if (!chat) continue

    upsertChat(chat)

    const lastId = getLastSyncedId(chat.id)
    let offsetId = lastId !== null ? parseInt(lastId, 10) : 0
    let synced = 0

    while (true) {
      const msgs = await client.getMessages(dialogs[i].entity, {
        limit: pageSize,
        offsetId,
        reverse: true,
      }) as MsgLike[]

      for (const msg of msgs) {
        const row = msgToRow(msg, chat.id)
        if (row) { insertMessage(row); synced++ }
      }

      if (msgs.length < pageSize) break
      offsetId = msgs[msgs.length - 1].id
    }

    console.log(`[${chat.name}] synced ${synced} messages`)
    if (i < dialogs.length - 1) await sleep(1000)
  }
}

// ── Real-time listener ────────────────────────────────────────────────────────

export function startListener(client: TelegramClient): void {
  client.addEventHandler(async (event: NewMessage.Event) => {
    const msg = event.message as unknown as MsgLike
    const chatId = getPeerChatId(msg.peerId)
    if (chatId === null) return
    const row = msgToRow(msg, chatId)
    if (row) {
      insertMessage(row)
      console.log(`New message in chat ${chatId}`)
    }
  }, new NewMessage({}))
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const readline = await import('readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const promptFn: PromptFn = (q) => new Promise((resolve) => rl.question(q, resolve))
  const session = new StringSession(config.sessionString)
  const client = new TelegramClient(session, config.apiId, config.apiHash, { connectionRetries: 5 })
  try {
    await runAuthWizard(client, promptFn)
    initDb('./telegram.db')
    await runBackfill(client)
    startListener(client)
    console.log('Listening for new messages…')
  } finally {
    rl.close()
  }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
