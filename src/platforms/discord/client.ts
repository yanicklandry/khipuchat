export interface DiscordChannel {
  id: string
  type: number
  name: string | null
  recipients?: Array<{ id: string; username: string }>
}

export interface DiscordMessage {
  id: string
  content: string
  author: { id: string; username: string }
  timestamp: string
  message_reference?: { message_id: string }
  type: number
}

export interface DiscordClient {
  getGuilds(): Promise<Array<{ id: string }>>
  getGuildChannels(guildId: string): Promise<DiscordChannel[]>
  getDirectMessageChannels(): Promise<DiscordChannel[]>
  getMessages(channelId: string, before?: string): Promise<DiscordMessage[]>
}

type DiscordErrorBody = { message?: string }

async function discordFetch(url: string, token: string): Promise<unknown> {
  const res = await globalThis.fetch(url, {
    headers: { Authorization: `Bot ${token}` },
  })
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') ?? '1')
    await new Promise(r => setTimeout(r, retryAfter * 1000))
    const retry = await globalThis.fetch(url, { headers: { Authorization: `Bot ${token}` } })
    if (!retry.ok) {
      const body = await retry.json() as DiscordErrorBody
      throw new Error(`Discord API ${retry.status} at ${url}: ${body.message ?? ''}`)
    }
    return retry.json()
  }
  if (!res.ok) {
    const body = await res.json() as DiscordErrorBody
    throw new Error(`Discord API ${res.status} at ${url}: ${body.message ?? ''}`)
  }
  return res.json()
}

export function createDiscordClient(token: string): DiscordClient {
  const BASE = 'https://discord.com/api/v10'
  return {
    getGuilds: () => discordFetch(`${BASE}/users/@me/guilds`, token) as Promise<Array<{ id: string }>>,
    getGuildChannels: (guildId) => discordFetch(`${BASE}/guilds/${guildId}/channels`, token) as Promise<DiscordChannel[]>,
    getDirectMessageChannels: () => discordFetch(`${BASE}/users/@me/channels`, token) as Promise<DiscordChannel[]>,
    getMessages: (channelId, before?) => {
      const qs = before ? `?before=${before}&limit=100` : '?limit=100'
      return discordFetch(`${BASE}/channels/${channelId}/messages${qs}`, token) as Promise<DiscordMessage[]>
    },
  }
}
