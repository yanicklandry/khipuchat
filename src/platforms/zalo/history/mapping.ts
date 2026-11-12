// Pure mapping from Zalo PC renderer-store records to archive records.
// Identity fields come from zalo-sync's own mappers so imported history and
// live-captured messages share external ids and merge without duplicates
// (msgId parity confirmed on macOS in task 1.3).
import type { Chat, Message, MessageType } from '../../../db'
import { mapChat, mapMessage } from '../sync'
import { ZaloThreadType } from '../client'
import type { ZaloPcConversation, ZaloPcRow } from './types'

/** msgType values with a dedicated archive type. 2/7/18 are from ZaloBackup (Windows), unobserved on macOS. */
const TYPE_BY_MSGTYPE: Readonly<Record<number, MessageType>> = { 2: 'image', 7: 'sticker', 18: 'video' }

/** A multi-device copy has a "_NNN" suffix on its msgId. */
const DEVICE_SUFFIX = /_\d+$/

export function isDmConversation(c: ZaloPcConversation): boolean {
  return c.isGroup !== true && !c.uid.startsWith('g') && !c.isOfficialAccount
}

export function classifyType(msgType: number, message: ZaloPcRow['message']): MessageType {
  if (typeof message === 'string' && message.length > 0) return 'text'
  return TYPE_BY_MSGTYPE[msgType] ?? 'other'
}

/** Caption of a non-text message: title, then description, then desc. */
export function captionOf(message: ZaloPcRow['message']): string | null {
  if (typeof message !== 'object' || message === null) return null
  for (const key of ['title', 'description', 'desc']) {
    const v = message[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/** Order for picking the copy to keep: unsuffixed first, then later serverTime, then larger msgId. */
function preferred(a: ZaloPcRow, b: ZaloPcRow): ZaloPcRow {
  const aPlain = !DEVICE_SUFFIX.test(a.msgId)
  const bPlain = !DEVICE_SUFFIX.test(b.msgId)
  if (aPlain !== bPlain) return aPlain ? a : b
  const at = Number(a.serverTime ?? 0)
  const bt = Number(b.serverTime ?? 0)
  if (at !== bt) return at > bt ? a : b
  return a.msgId.localeCompare(b.msgId, undefined, { numeric: true }) >= 0 ? a : b
}

/** Collapses multi-device copies (same cliMsgId) into one row, keeping first-seen order. */
export function collapseDuplicates(rows: ZaloPcRow[]): ZaloPcRow[] {
  const kept = new Map<string, ZaloPcRow>()
  for (const r of rows) {
    const prev = kept.get(r.cliMsgId)
    kept.set(r.cliMsgId, prev ? preferred(prev, r) : r)
  }
  return [...kept.values()]
}

export function toChat(c: ZaloPcConversation, account: string): Chat {
  return mapChat({ threadId: c.uid, name: c.name }, account)
}

export function toMessage(row: ZaloPcRow, chatId: number, ownUid: string, peerName: string): Message {
  const isSelf = row.fromUid === '0' || row.fromUid === ownUid
  const base = mapMessage({
    msgId: row.msgId,
    threadId: row.toUid,
    threadType: ZaloThreadType.User,
    isSelf,
    senderId: row.fromUid,
    senderName: row.dName || peerName,
    content: typeof row.message === 'string' ? row.message : null,
    ts: Number(row.sendDttm),
  }, chatId)
  const type = classifyType(row.msgType, row.message)
  return typeof row.message === 'string' ? { ...base, type } : { ...base, type, text: captionOf(row.message) }
}
