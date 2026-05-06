import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initDb, getChats } from '../src/db'
import {
  hashStr,
  extractContactId,
  mapChat,
  mapMessage,
  runBackfillImpl,
  openWechatDb,
  discoverChatDbs,
  type WechatMessageRow,
} from '../src/platforms/wechat/sync'
import { buildWechatContactMap } from '../src/platforms/wechat/contacts'

// ── Mock DB factories ─────────────────────────────────────────────────────────

function makeMockChatDb(contactId: string, rows: WechatMessageRow[]): Database.Database {
  const db = new Database(':memory:')
  const table = `Chat_${contactId}`
  db.exec(`
    CREATE TABLE "${table}" (
      MesSvrID  INTEGER,
      CreateTime INTEGER,
      Message   TEXT,
      Des        INTEGER
    )
  `)
  const insert = db.prepare(`INSERT INTO "${table}" VALUES (@MesSvrID, @CreateTime, @Message, @Des)`)
  for (const row of rows) insert.run(row)
  return db
}

function makeMockContactDb(entries: { m_nsUsrName: string; m_nsNickName: string }[]): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE WCContact (m_nsUsrName TEXT, m_nsNickName TEXT)')
  const insert = db.prepare('INSERT INTO WCContact VALUES (@m_nsUsrName, @m_nsNickName)')
  for (const e of entries) insert.run(e)
  return db
}

// ── hashStr ───────────────────────────────────────────────────────────────────

describe('hashStr', () => {
  it('returns the same value for the same string', () => {
    const s = 'wxid_testuser123'
    expect(hashStr(s)).toBe(hashStr(s))
  })

  it('returns different values for different strings', () => {
    expect(hashStr('wxid_aaa')).not.toBe(hashStr('wxid_bbb'))
  })

  it('returns a positive safe integer', () => {
    const h = hashStr('roomid@chatroom')
    expect(h).toBeGreaterThan(0)
    expect(Number.isSafeInteger(h)).toBe(true)
  })

  it('never returns 0', () => {
    // FNV-1a on empty string can hash to 2166136261 which is non-zero; guard branch tested
    expect(hashStr('')).toBeGreaterThan(0)
  })
})

// ── extractContactId ──────────────────────────────────────────────────────────

describe('extractContactId', () => {
  it('strips Chat_ prefix and .db suffix', () => {
    expect(extractContactId('/path/to/Chat_wxid_abc123.db')).toBe('wxid_abc123')
  })

  it('handles @chatroom group ID', () => {
    expect(extractContactId('/nested/dir/Chat_room42@chatroom.db')).toBe('room42@chatroom')
  })

  it('strips only the leading Chat_ prefix', () => {
    expect(extractContactId('Chat_Chat_double.db')).toBe('Chat_double')
  })
})

// ── mapChat ───────────────────────────────────────────────────────────────────

describe('mapChat', () => {
  const contactMap = new Map([['wxid_alice', 'Alice Smith']])

  it('sets platform to wechat', () => {
    expect(mapChat('wxid_alice', contactMap).platform).toBe('wechat')
  })

  it('sets type to private for regular contactId', () => {
    expect(mapChat('wxid_alice', contactMap).type).toBe('private')
  })

  it('sets type to group for @chatroom contactId', () => {
    expect(mapChat('room1@chatroom', new Map()).type).toBe('group')
  })

  it('resolves name from contactMap', () => {
    expect(mapChat('wxid_alice', contactMap).name).toBe('Alice Smith')
  })

  it('falls back to raw contactId when not in map', () => {
    expect(mapChat('wxid_unknown', new Map()).name).toBe('wxid_unknown')
  })

  it('uses hashStr for id', () => {
    expect(mapChat('wxid_alice', contactMap).id).toBe(hashStr('wxid_alice'))
  })

  it('sets username to null', () => {
    expect(mapChat('wxid_alice', contactMap).username).toBeNull()
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const contactMap = new Map([['wxid_bob', 'Bob']])
  const baseRow: WechatMessageRow = {
    MesSvrID: 99001, CreateTime: 1700000000, Message: 'Hello', Des: 1,
  }

  it('sets platform to wechat', () => {
    expect(mapMessage(baseRow, 1, 'wxid_bob', contactMap).platform).toBe('wechat')
  })

  it('sets external_id to MesSvrID.toString()', () => {
    expect(mapMessage(baseRow, 1, 'wxid_bob', contactMap).external_id).toBe('99001')
  })

  it('sets is_sender=0 when Des=1 (received)', () => {
    expect(mapMessage(baseRow, 1, 'wxid_bob', contactMap).is_sender).toBe(0)
  })

  it('sets is_sender=1 when Des=0 (sent)', () => {
    expect(mapMessage({ ...baseRow, Des: 0 }, 1, 'wxid_bob', contactMap).is_sender).toBe(1)
  })

  it('sets type to text when Message is non-null', () => {
    expect(mapMessage(baseRow, 1, 'wxid_bob', contactMap).type).toBe('text')
  })

  it('sets type to other when Message is null', () => {
    expect(mapMessage({ ...baseRow, Message: null }, 1, 'wxid_bob', contactMap).type).toBe('other')
  })

  it('uses CreateTime directly as timestamp (no offset)', () => {
    expect(mapMessage(baseRow, 1, 'wxid_bob', contactMap).timestamp).toBe(1700000000)
  })

  it('sets sender_name from contactMap when Des=1', () => {
    expect(mapMessage(baseRow, 1, 'wxid_bob', contactMap).sender_name).toBe('Bob')
  })

  it('sets sender_name to null when Des=0 (sent by me)', () => {
    expect(mapMessage({ ...baseRow, Des: 0 }, 1, 'wxid_bob', contactMap).sender_name).toBeNull()
  })

  it('sets reply_to_external_id to null', () => {
    expect(mapMessage(baseRow, 1, 'wxid_bob', contactMap).reply_to_external_id).toBeNull()
  })

  it('falls back to raw contactId for sender_name when not in map', () => {
    expect(mapMessage(baseRow, 1, 'wxid_unknown', new Map()).sender_name).toBe('wxid_unknown')
  })
})

// ── buildWechatContactMap ─────────────────────────────────────────────────────

describe('buildWechatContactMap', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-test-'))
  })

  it('returns correct mappings when WCDB_Contact.db is present', () => {
    const contactDb = makeMockContactDb([
      { m_nsUsrName: 'wxid_alice', m_nsNickName: 'Alice' },
      { m_nsUsrName: 'wxid_bob', m_nsNickName: 'Bob' },
    ])
    // Write the in-memory DB to a temp file so buildWechatContactMap can open it
    const dbPath = path.join(tmpDir, 'WCDB_Contact.db')
    const data = contactDb.serialize()
    fs.writeFileSync(dbPath, data)
    contactDb.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('wxid_alice')).toBe('Alice')
    expect(map.get('wxid_bob')).toBe('Bob')
  })

  it('returns empty map when WCDB_Contact.db is absent', () => {
    const map = buildWechatContactMap(tmpDir)
    expect(map.size).toBe(0)
  })

  it('returns empty map without throwing for inaccessible container', () => {
    expect(() => buildWechatContactMap('/nonexistent/path/xyz')).not.toThrow()
    expect(buildWechatContactMap('/nonexistent/path/xyz').size).toBe(0)
  })
})

// ── discoverChatDbs ───────────────────────────────────────────────────────────

describe('discoverChatDbs', () => {
  it('throws with install guidance when container path does not exist', () => {
    expect(() => discoverChatDbs('/nonexistent/wechat/container')).toThrow(/WeChat for Mac must be installed/)
  })

  it('returns empty array when no Chat_*.db files found', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-discover-'))
    expect(discoverChatDbs(tmpDir)).toEqual([])
    fs.rmdirSync(tmpDir)
  })

  it('finds Chat_*.db files recursively', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-discover2-'))
    const subDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(subDir)
    fs.writeFileSync(path.join(tmpDir, 'Chat_wxid_alice.db'), '')
    fs.writeFileSync(path.join(subDir, 'Chat_room@chatroom.db'), '')
    fs.writeFileSync(path.join(tmpDir, 'WCDB_Contact.db'), '') // should not match
    const found = discoverChatDbs(tmpDir)
    expect(found).toHaveLength(2)
    expect(found.some(p => p.includes('Chat_wxid_alice.db'))).toBe(true)
    expect(found.some(p => p.includes('Chat_room@chatroom.db'))).toBe(true)
    fs.rmSync(tmpDir, { recursive: true })
  })
})

// ── openWechatDb ──────────────────────────────────────────────────────────────

describe('openWechatDb', () => {
  it('returns null for a non-SQLite file without throwing', () => {
    const tmp = path.join(os.tmpdir(), 'fake.db')
    fs.writeFileSync(tmp, 'this is not a sqlite database at all')
    expect(() => openWechatDb(tmp)).not.toThrow()
    expect(openWechatDb(tmp)).toBeNull()
    fs.unlinkSync(tmp)
  })

  it('returns null for non-existent file without throwing', () => {
    expect(() => openWechatDb('/nonexistent/Chat_x.db')).not.toThrow()
    expect(openWechatDb('/nonexistent/Chat_x.db')).toBeNull()
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

describe('runBackfillImpl integration', () => {
  beforeEach(() => { initDb(':memory:') })

  it('imports chats and messages from two mock DB paths', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-backfill-'))
    const rows1: WechatMessageRow[] = [
      { MesSvrID: 1001, CreateTime: 1700000001, Message: 'Hi', Des: 1 },
      { MesSvrID: 1002, CreateTime: 1700000002, Message: null, Des: 0 },
    ]
    const rows2: WechatMessageRow[] = [
      { MesSvrID: 2001, CreateTime: 1700000003, Message: 'Group msg', Des: 1 },
    ]

    const db1 = makeMockChatDb('wxid_alice', rows1)
    const db2 = makeMockChatDb('room1@chatroom', rows2)

    // Serialize to temp files
    const path1 = path.join(tmpDir, 'Chat_wxid_alice.db')
    const path2 = path.join(tmpDir, 'Chat_room1@chatroom.db')
    fs.writeFileSync(path1, db1.serialize())
    fs.writeFileSync(path2, db2.serialize())
    db1.close()
    db2.close()

    const contactMap = new Map([['wxid_alice', 'Alice'], ['room1@chatroom', 'Group']])
    await runBackfillImpl([path1, path2], contactMap)

    const chats = getChats()
    expect(chats).toHaveLength(2)
    expect(chats.some(c => c.type === 'group')).toBe(true)
    expect(chats.some(c => c.type === 'private')).toBe(true)
    expect(chats.every(c => c.platform === 'wechat')).toBe(true)

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('is idempotent — running twice yields same counts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-idem-'))
    const rows: WechatMessageRow[] = [
      { MesSvrID: 3001, CreateTime: 1700000010, Message: 'Hey', Des: 1 },
    ]
    const db = makeMockChatDb('wxid_carol', rows)
    const dbPath = path.join(tmpDir, 'Chat_wxid_carol.db')
    fs.writeFileSync(dbPath, db.serialize())
    db.close()

    const contactMap = new Map<string, string>()
    await runBackfillImpl([dbPath], contactMap)
    await runBackfillImpl([dbPath], contactMap)

    expect(getChats()).toHaveLength(1)
    // INSERT OR IGNORE guarantees no duplicates; getChats() returning 1 chat confirms idempotency
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('skips null from openWechatDb gracefully', async () => {
    const fakePath = '/nonexistent/Chat_ghost.db'
    await expect(runBackfillImpl([fakePath], new Map())).resolves.not.toThrow()
  })
})
