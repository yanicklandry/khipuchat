export interface WAChat {
  id: { _serialized: string }
  name: string
  isGroup: boolean
  /** Unix seconds of the last message in this chat (0 if empty). */
  timestamp?: number
}

export interface WAMessage {
  id: { _serialized: string }
  body: string
  from: string
  fromMe: boolean
  author?: string
  timestamp: number
  type: string
}

export interface WhatsAppClient {
  getChats(): Promise<WAChat[]>
  fetchMessages(chatId: string, limit?: number): Promise<WAMessage[]>
  getContactName(contactId: string): Promise<string>
  destroy(): Promise<void>
}

export interface CreateClientOptions {
  sessionDataPath?: string
  debug?: boolean
}

// qrcode-terminal is CJS; under tsx dynamic import its exports live on .default
type QrcodeTerminal = { generate(text: string, opts?: { small?: boolean }): void }

function renderStartupProgress(totalMs: number): () => void {
  const cols = process.stdout.columns ?? 60
  const barWidth = Math.max(10, Math.min(40, cols - 30))
  const startTime = Date.now()
  let done = false

  const draw = () => {
    if (done) return
    const elapsed = Date.now() - startTime
    const pct = Math.min(1, elapsed / totalMs)
    const filled = Math.round(barWidth * pct)
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
    const pctStr = String(Math.round(pct * 100)).padStart(3)
    process.stdout.write(`\r[whatsapp] Browser starting… [${bar}] ${pctStr}%   `)
  }

  draw()
  const timer = setInterval(draw, 250)

  return () => {
    done = true
    clearInterval(timer)
    process.stdout.write('\r' + ' '.repeat(barWidth + 35) + '\r')
  }
}

export async function createWhatsAppClient(opts: CreateClientOptions = {}): Promise<WhatsAppClient> {
  const { sessionDataPath, debug = false } = opts
  const dbg = (...args: unknown[]) => {
    if (debug) process.stderr.write(`[whatsapp:debug] ${args.join(' ')}\n`)
  }

  // Dynamic import so tests can mock the module without requiring Puppeteer.
  // whatsapp-web.js is ESM; when imported from a CJS project its exports live on .default.
  const wwjs = await import('whatsapp-web.js')
  const { Client, LocalAuth } = (wwjs.default ?? wwjs) as typeof wwjs

  // qrcode-terminal exports live on .default when dynamically imported from CJS
  const qrcodeRaw = await import('qrcode-terminal') as unknown
  const qrGen = ((qrcodeRaw as { default?: QrcodeTerminal }).default
    ?? (qrcodeRaw as QrcodeTerminal))

  dbg('creating Client...')
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDataPath }),
    puppeteer: { args: ['--no-sandbox'], dumpio: debug },
  })

  // Show a 30-second animated progress bar while the browser starts up.
  const stopProgress = renderStartupProgress(30_000)

  return new Promise((resolve, reject) => {
    const fail = (err: unknown) => {
      stopProgress()
      dbg('fail:', (err as Error).message)
      client.destroy().catch(() => {}).finally(() => reject(err))
    }

    client.on('qr', (qr: string) => {
      stopProgress()
      process.stdout.write('\n')
      qrGen.generate(qr, { small: true })
      console.log('Scan the QR code above with WhatsApp on your phone.')
      dbg('event: qr — waiting for scan')
    })

    client.on('loading_screen', (percent: number, message: string) => {
      stopProgress()
      process.stdout.write(`\r[whatsapp] Loading WhatsApp Web… ${percent}%   `)
      if (percent === 100) process.stdout.write('\n')
      dbg(`event: loading_screen ${percent}% — ${message}`)
    })

    client.on('authenticated', () => {
      stopProgress()
      console.log('[whatsapp] Authenticated.')
      dbg('event: authenticated')
    })

    client.on('auth_failure', (msg: string) => {
      dbg('event: auth_failure', msg)
      fail(new Error(
        `WhatsApp authentication failed: ${msg}. Delete the session data and re-run to scan a new QR code.`,
      ))
    })

    client.on('disconnected', (reason: string) => {
      dbg('event: disconnected', reason)
    })

    client.on('ready', () => {
      stopProgress()
      dbg('event: ready')
      const wrapper: WhatsAppClient = {
        getChats: () => client.getChats() as Promise<WAChat[]>,
        fetchMessages: (chatId, limit = 1000) => {
          const chat = (client as unknown as { getChatById(id: string): Promise<{ fetchMessages(opts: { limit: number }): Promise<WAMessage[]> }> }).getChatById(chatId)
          return chat.then(c => c.fetchMessages({ limit }))
        },
        getContactName: async (contactId) => {
          try {
            const contact = await (client as unknown as { getContactById(id: string): Promise<{ pushname?: string; name?: string; number: string }> }).getContactById(contactId)
            return contact.pushname || contact.name || contact.number
          } catch {
            return contactId
          }
        },
        destroy: () => client.destroy(),
      }
      resolve(wrapper)
    })

    dbg('calling initialize()...')
    client.initialize().catch(fail)
  })
}
