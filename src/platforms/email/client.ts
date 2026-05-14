import { ImapFlow } from 'imapflow'

export interface RawEmailMessage {
  messageId: string
  inReplyTo: string | null
  from: string
  subject: string
  date: Date
  text: string | null
}

export interface EmailSearchCriteria {
  since?: Date
}

export interface EmailClient {
  fetchFolder(folder: string, criteria?: EmailSearchCriteria): AsyncGenerator<RawEmailMessage>
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

    async *fetchFolder(folder, criteria?) {
      const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false })
      await client.connect()
      try {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true })
        if (mailbox.exists === 0) return

        // If search criteria provided, use IMAP SEARCH to narrow results
        let uids: number[] | undefined
        if (criteria?.since) {
          const searchResult = await (client as unknown as {
            search(criteria: Record<string, unknown>, opts: Record<string, unknown>): Promise<number[]>
          }).search({ since: criteria.since }, { uid: true })
          if (searchResult.length === 0) return
          uids = searchResult
        }

        const fetchRange = uids ? uids.join(',') : `1:${mailbox.exists}`
        const fetchOpts = uids ? { uid: true } : {}
        const total = uids ? uids.length : mailbox.exists

        if (total === 0) return

        const BATCH = 200
        // For UID-based fetch, process in batches differently
        if (uids) {
          for (let i = 0; i < uids.length; i += BATCH) {
            const batchUids = uids.slice(i, i + BATCH).join(',')
            for await (const msg of client.fetch(batchUids, {
              envelope: true,
              bodyParts: ['text'],
              bodyStructure: false,
            }, { uid: true })) {
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
          return
        }

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
