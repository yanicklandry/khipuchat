export interface WAChat {
  id: { _serialized: string }
  name: string
  isGroup: boolean
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

export async function createWhatsAppClient(sessionDataPath?: string): Promise<WhatsAppClient> {
  // Dynamic import so tests can mock the module without requiring Puppeteer
  const { Client, LocalAuth } = await import('whatsapp-web.js')
  const qrcode = await import('qrcode-terminal')

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDataPath }),
    puppeteer: { args: ['--no-sandbox'] },
  })

  return new Promise((resolve, reject) => {
    client.on('qr', (qr: string) => {
      qrcode.generate(qr, { small: true })
      console.log('Scan the QR code above with WhatsApp on your phone.')
    })

    client.on('ready', () => {
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

    client.on('auth_failure', (msg: string) => {
      reject(new Error(
        `WhatsApp authentication failed: ${msg}. Delete the session data and re-run to scan a new QR code. ` +
        'See https://github.com/pedroslopez/whatsapp-web.js for details.',
      ))
    })

    client.initialize().catch(reject)
  })
}
