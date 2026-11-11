/**
 * Chat-seeding for the signal-cli adapter: enumerate the daemon's groups and
 * contacts, upsert a Chat row for each, and return name-lookup closures used to
 * label incoming envelopes. Split out of cli-sync.ts to keep each source file
 * under the project's 200-line ceiling; behavior is unchanged.
 */

import { upsertChat, type Chat, type Platform } from '../../db'
import type { SignalCliClient } from './cli-client'
import type { GroupNameLookup, ContactNameLookup } from './cli-mapping'

const SIGNAL: Platform = 'signal'

/** Seed chats from group/contact enumeration and build name lookups. */
export async function seedChats(
  client: SignalCliClient,
  account: string,
): Promise<{ groupName: GroupNameLookup; contactName: ContactNameLookup; seeded: number }> {
  const groups = new Map<string, string>()
  const contacts = new Map<string, string>()
  let seeded = 0

  const chat = (external_id: string, name: string, type: Chat['type']): void => {
    upsertChat({ external_id, account, name, type, username: null, platform: SIGNAL })
    seeded++
  }

  const rawGroups = await client.request<unknown>('listGroups', {}).catch(() => [])
  if (Array.isArray(rawGroups)) {
    for (const g of rawGroups) {
      const o = g as Record<string, unknown>
      const id = (o['id'] ?? o['groupId']) as string | undefined
      const name = (o['name'] ?? o['title']) as string | undefined
      if (!id) continue
      if (name) groups.set(id, name)
      chat(`group.${id}`, name ?? id, 'group')
    }
  }

  const rawContacts = await client.request<unknown>('listContacts', {}).catch(() => [])
  if (Array.isArray(rawContacts)) {
    for (const c of rawContacts) {
      const o = c as Record<string, unknown>
      const uuid = o['uuid'] as string | undefined
      const number = o['number'] as string | undefined
      const name = (o['name'] ?? o['profileName'] ?? o['username']) as string | undefined
      const key = uuid ?? number
      if (!key) continue
      if (name) {
        contacts.set(key, name)
        if (uuid) contacts.set(uuid, name)
        if (number) contacts.set(number, name)
      }
      chat(key, name ?? key, 'private')
    }
  }

  return {
    groupName: (id) => groups.get(id),
    contactName: (id) => contacts.get(id),
    seeded,
  }
}
