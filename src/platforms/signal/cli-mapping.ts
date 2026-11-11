/**
 * Pure envelope -> Chat/Message mapping for the signal-cli backend.
 *
 * No I/O, no DB, no clock beyond values carried in the envelope. Emits the SAME
 * shared field set as every other adapter so query surfaces cannot tell which
 * Signal backend produced a row. Defensive on every optional field, because the
 * exact signal-cli envelope sub-field names vary across daemon versions.
 */

import type { Message, Platform } from '../../db'
import type { SignalEnvelope, SignalAttachment } from './cli-client'

export interface MappedChat {
  external_id: string
  name: string
  type: 'private' | 'group'
}

export type GroupNameLookup = (groupId: string) => string | undefined
export type ContactNameLookup = (peerId: string) => string | undefined

const SIGNAL: Platform = 'signal'

/** Direct-chat peer identity: destination for own-sends, source for receives. */
function peerId(env: SignalEnvelope): string | undefined {
  const sent = env.syncMessage?.sentMessage
  if (sent) return sent.destinationUuid ?? sent.destination ?? sent.destinationNumber
  return env.sourceUuid ?? env.sourceNumber ?? env.source
}

/**
 * Resolve the chat a message belongs to. Group => `group.<groupId>`; one-to-one
 * => the peer id. Returns null when no chat identity can be derived.
 */
export function resolveChat(
  env: SignalEnvelope,
  groupName: GroupNameLookup,
  contactName: ContactNameLookup,
): MappedChat | null {
  const groupId = env.dataMessage?.groupInfo?.groupId ?? env.syncMessage?.sentMessage?.groupInfo?.groupId
  if (groupId) {
    return { external_id: `group.${groupId}`, name: groupName(groupId) ?? groupId, type: 'group' }
  }
  const peer = peerId(env)
  if (!peer) return null
  return { external_id: peer, name: contactName(peer) ?? env.sourceName ?? peer, type: 'private' }
}

/**
 * Map an envelope to a Message plus its image attachments. Returns null for
 * envelopes with no ingestable content (receipts, typing, empty).
 */
export function mapEnvelope(
  env: SignalEnvelope,
  chatId: number,
): { message: Message; imageAttachments: SignalAttachment[] } | null {
  const sent = env.syncMessage?.sentMessage
  const data = env.dataMessage
  if (!sent && !data) return null

  const text = (sent?.message ?? data?.message) ?? null
  const attachments = sent?.attachments ?? data?.attachments ?? []
  if ((text === null || text.length === 0) && attachments.length === 0) return null

  const isSender: 0 | 1 = sent ? 1 : 0
  const tsMs = sent?.timestamp ?? env.timestamp
  const imageAttachments = attachments.filter((a) => (a.contentType ?? '').startsWith('image/'))
  const type: Message['type'] = imageAttachments.length > 0 ? 'image' : text && text.length > 0 ? 'text' : 'other'
  const senderKey = sent ? 'self' : env.sourceUuid ?? env.sourceNumber ?? env.source ?? 'unknown'

  const quote = sent?.quote ?? data?.quote
  const replyTo =
    quote?.id !== undefined ? (quote.author ? `${quote.author}.${quote.id}` : String(quote.id)) : null

  const message: Message = {
    external_id: `${senderKey}.${tsMs}`,
    chat_id: chatId,
    sender_id: env.sourceUuid ?? env.sourceNumber ?? null,
    sender_name: env.sourceName ?? null,
    text,
    type,
    timestamp: Math.floor(tsMs / 1000),
    is_sender: isSender,
    reply_to_external_id: replyTo,
    platform: SIGNAL,
    media_file_path: null,
    media_url: null,
    media_width: null,
    media_height: null,
    ocr_text: null,
  }
  return { message, imageAttachments }
}
