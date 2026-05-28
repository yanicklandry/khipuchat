export interface SlackConversation {
  id: string
  name: string | null
  is_im: boolean
  is_mpim: boolean
  is_archived: boolean
  user?: string
}

export interface SlackMessage {
  ts: string
  user?: string
  text: string
  subtype?: string
}

export interface SlackClient {
  listConversations(): AsyncGenerator<SlackConversation>
  fetchHistory(channelId: string, oldest?: string): AsyncGenerator<SlackMessage>
  getUserName(userId: string): Promise<string>
}

type SlackResponse = {
  ok: boolean
  error?: string
  channels?: SlackConversation[]
  messages?: SlackMessage[]
  response_metadata?: { next_cursor?: string }
  user?: { profile?: { display_name?: string; real_name?: string } }
}

async function slackFetch(url: string, token: string): Promise<SlackResponse> {
  await new Promise(r => setTimeout(r, 1200))
  const res = await globalThis.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 429) {
    const after = parseFloat(res.headers.get('Retry-After') ?? '1')
    await new Promise(r => setTimeout(r, after * 1000))
    const retry = await globalThis.fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    return retry.json() as Promise<SlackResponse>
  }
  return res.json() as Promise<SlackResponse>
}

export function createSlackClient(token: string): SlackClient {
  const BASE = 'https://slack.com/api'
  const nameCache = new Map<string, string>()

  return {
    async *listConversations() {
      let cursor = ''
      while (true) {
        const url = `${BASE}/conversations.list?types=public_channel,private_channel,im,mpim&exclude_archived=true&limit=200${cursor ? `&cursor=${cursor}` : ''}`
        const data = await slackFetch(url, token)
        if (!data.ok) throw new Error(`Slack conversations.list error: ${data.error ?? ''}`)
        for (const ch of data.channels ?? []) {
          yield ch
        }
        cursor = data.response_metadata?.next_cursor ?? ''
        if (!cursor) break
      }
    },

    async *fetchHistory(channelId, oldest?) {
      let cursor = ''
      while (true) {
        const params = new URLSearchParams({ channel: channelId, limit: '200' })
        if (cursor) params.set('cursor', cursor)
        if (oldest) params.set('oldest', oldest)
        const url = `${BASE}/conversations.history?${params.toString()}`
        const data = await slackFetch(url, token)
        if (!data.ok) throw new Error(`Slack conversations.history error: ${data.error ?? ''}`)
        for (const msg of data.messages ?? []) {
          yield msg
        }
        cursor = data.response_metadata?.next_cursor ?? ''
        if (!cursor) break
      }
    },

    async getUserName(userId) {
      if (nameCache.has(userId)) return nameCache.get(userId)!
      try {
        const url = `${BASE}/users.info?user=${userId}`
        const data = await slackFetch(url, token)
        const name = data.user?.profile?.display_name || data.user?.profile?.real_name || userId
        nameCache.set(userId, name)
        return name
      } catch {
        nameCache.set(userId, userId)
        return userId
      }
    },
  }
}
