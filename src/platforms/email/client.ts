import { ImapFlow } from 'imapflow'

export interface RawEmailMessage {
  messageId: string
  inReplyTo: string | null
  from: string
  subject: string
  date: Date
  text: string | null
}

export interface EmailClient {
  fetchFolder(folder: string): AsyncGenerator<RawEmailMessage>
  listSpecialFolder(use: '\\Sent'): Promise<string | null>
}

function parseHeader(raw: string | undefined): string {
  return raw?.trim() ?? ''
}

function stripAngles(id: string): string {
  return id.replace(/^<|>$/g, '').trim()
}

export function createEmailClient(host: string, user: string, pass: string): EmailClient {
  async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false })
    await client.connect()
    try {
      return await fn(client)
    } finally {
      await client.logout()
    }
  }

  return {
    async listSpecialFolder(use) {
      return withClient(async (client) => {
        const list = await client.list()
        const sent = list.find(mb =>
          mb.specialUse === use ||
          mb.name === 'Sent' ||
          mb.name === 'Sent Items' ||
          mb.name === 'Sent Messages',
        )
        return sent?.path ?? null
      })
    },

    async *fetchFolder(folder) {
      const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false })
      await client.connect()
      try {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true })
        const total = mailbox.exists
        if (total === 0) return

        const BATCH = 200
        for (let start = 1; start <= total; start += BATCH) {
          const end = Math.min(start + BATCH - 1, total)
          for await (const msg of client.fetch(`${start}:${end}`, {
            envelope: true,
            bodyParts: ['text'],
            bodyStructure: false,
          })) {
            const env = msg.envelope
            if (!env?.messageId) continue
            let text: string | null = null
            for (const [, part] of (msg.bodyParts ?? new Map())) {
              text = (part as Buffer).toString('utf8').trim() || null
              break
            }
            yield {
              messageId: stripAngles(parseHeader(env.messageId)),
              inReplyTo: env.inReplyTo ? stripAngles(parseHeader(env.inReplyTo)) : null,
              from: env.from?.[0] ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`.trim() : '',
              subject: parseHeader(env.subject),
              date: env.date ?? new Date(),
              text,
            }
          }
        }
      } finally {
        await client.logout()
      }
    },
  }
}
