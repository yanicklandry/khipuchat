import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initDb, getChats, getDb } from '../src/db'
import {
  hashStr,
  tableNameToChatId,
  mapChat,
  mapMessage,
  runBackfillImpl,
  openWechatDb,
  discoverMessageDbs,
  findUserDir,
  buildSenderIdMap,
  extractSelfWxid,
  type WechatMessageRow,
  type MessageMapOpts,
} from '../src/platforms/wechat/sync'
import { buildWechatContactMap } from '../src/platforms/wechat/contacts'

// ── Mock DB factories ─────────────────────────────────────────────────────────

/** Create an in-memory SQLite DB with a Msg_<tableName> table containing rows. */
function makeMockChatDb(tableName: string, rows: WechatMessageRow[]): Database.Database {
  const db = new Database(':memory:')
  const table = `Msg_${tableName}`
  db.exec(`
    CREATE TABLE "${table}" (
      msgSvrID   INTEGER,
      CreateTime INTEGER,
      Message    TEXT,
      Des        INTEGER,
      Type       INTEGER DEFAULT 1
    )
  `)
  const insert = db.prepare(
    `INSERT INTO "${table}" (msgSvrID, CreateTime, Message, Des, Type) VALUES (@msgSvrID, @CreateTime, @Message, @Des, @Type)`,
  )
  for (const row of rows) {
    insert.run({
      msgSvrID: row.msgSvrID ?? row.MesSvrID ?? 0,
      CreateTime: row.CreateTime,
      Message: row.Message ?? row.strContent ?? null,
      Des: row.Des ?? row.isSend ?? 0,
      Type: row.Type ?? row.MsgType ?? 1,
    })
  }
  return db
}

function makeMockContactDb(entries: { m_nsUsrName: string; m_nsNickName: string }[]): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE WCContact (m_nsUsrName TEXT, m_nsNickName TEXT)')
  const insert = db.prepare('INSERT INTO WCContact VALUES (@m_nsUsrName, @m_nsNickName)')
  for (const e of entries) insert.run(e)
  return db
}

function makeMockContactDbWithRemark(
  entries: { m_nsUsrName: string; m_nsNickName: string; m_nsRemark: string }[],
): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE WCContact (m_nsUsrName TEXT, m_nsNickName TEXT, m_nsRemark TEXT)')
  const insert = db.prepare('INSERT INTO WCContact VALUES (@m_nsUsrName, @m_nsNickName, @m_nsRemark)')
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
    expect(hashStr('')).toBeGreaterThan(0)
  })
})

// ── tableNameToChatId ─────────────────────────────────────────────────────────

describe('tableNameToChatId', () => {
  it('returns a positive number for any table name', () => {
    expect(tableNameToChatId('Chat_a3f4b7')).toBeGreaterThan(0)
  })

  it('is deterministic', () => {
    const t = 'Chat_deadbeef'
    expect(tableNameToChatId(t)).toBe(tableNameToChatId(t))
  })
})

// ── mapChat ───────────────────────────────────────────────────────────────────

describe('mapChat', () => {
  it('sets platform to wechat', () => {
    expect(mapChat('Chat_abc', 'Alice').platform).toBe('wechat')
  })

  it('sets type to private for non-chatroom names', () => {
    expect(mapChat('Chat_wxid_alice', 'Alice').type).toBe('private')
  })

  it('sets type to group when displayName contains @chatroom', () => {
    expect(mapChat('Chat_room1', 'room1@chatroom').type).toBe('group')
  })

  it('uses tableNameToChatId for id', () => {
    const tableName = 'Chat_test123'
    expect(mapChat(tableName, 'Test').id).toBe(tableNameToChatId(tableName))
  })

  it('sets username to null', () => {
    expect(mapChat('Chat_abc', 'Alice').username).toBeNull()
  })

  it('uses provided displayName', () => {
    expect(mapChat('Chat_abc', 'Alice Smith').name).toBe('Alice Smith')
  })
})

// ── mapMessage ────────────────────────────────────────────────────────────────

describe('mapMessage', () => {
  const baseRow: WechatMessageRow = {
    msgSvrID: 99001, CreateTime: 1700000000, Message: 'Hello', Des: 1,
  }

  it('sets platform to wechat', () => {
    expect(mapMessage(baseRow, 1).platform).toBe('wechat')
  })

  it('sets external_id from msgSvrID', () => {
    expect(mapMessage(baseRow, 1).external_id).toBe('99001')
  })

  it('falls back to MesSvrID when msgSvrID absent', () => {
    const row: WechatMessageRow = { MesSvrID: 777, CreateTime: 1700000000, Message: 'Hi', Des: 1 }
    expect(mapMessage(row, 1).external_id).toBe('777')
  })

  it('sets is_sender=0 when Des=1 (received)', () => {
    expect(mapMessage(baseRow, 1).is_sender).toBe(0)
  })

  it('sets is_sender=1 when Des=0 (sent by me)', () => {
    expect(mapMessage({ ...baseRow, Des: 0 }, 1).is_sender).toBe(1)
  })

  it('sets type to text when Message is non-null', () => {
    expect(mapMessage(baseRow, 1).type).toBe('text')
  })

  it('sets type to other when Message is null', () => {
    expect(mapMessage({ ...baseRow, Message: null }, 1).type).toBe('other')
  })

  it('uses CreateTime directly as timestamp', () => {
    expect(mapMessage(baseRow, 1).timestamp).toBe(1700000000)
  })

  it('handles strContent column alias', () => {
    const row: WechatMessageRow = { msgSvrID: 1, CreateTime: 0, strContent: 'hi', Des: 0 }
    expect(mapMessage(row, 1).text).toBe('hi')
    expect(mapMessage(row, 1).type).toBe('text')
  })

  it('sets reply_to_external_id to null', () => {
    expect(mapMessage(baseRow, 1).reply_to_external_id).toBeNull()
  })

  // WeChat 4.x (V4) schema — real_sender_id is a Name2Id rowid
  const v4SenderMap = new Map([[2, 'wxid_self123'], [5, 'shanchuanzhezi']])
  const v4Opts: MessageMapOpts = { selfWxid: 'wxid_self123', senderIdMap: v4SenderMap }

  const v4Row: WechatMessageRow = {
    server_id: 12345, create_time: 1710000000, message_content: 'Hey V4', local_type: 1,
    WCDB_CT_message_content: 0, real_sender_id: 2,  // rowid 2 → 'wxid_self123'
  }

  it('V4: detects is_sender=1 when real_sender_id resolves to selfWxid', () => {
    expect(mapMessage(v4Row, 2, v4Opts).is_sender).toBe(1)
  })

  it('V4: detects is_sender=0 when real_sender_id resolves to counterparty', () => {
    expect(mapMessage({ ...v4Row, real_sender_id: 5 }, 2, v4Opts).is_sender).toBe(0)
  })

  it('V4: defaults is_sender=0 when opts not provided', () => {
    expect(mapMessage(v4Row, 2).is_sender).toBe(0)
  })

  it('V4: uses server_id as external_id', () => {
    expect(mapMessage(v4Row, 2, v4Opts).external_id).toBe('12345')
  })

  it('V4: uses create_time as timestamp', () => {
    expect(mapMessage(v4Row, 2, v4Opts).timestamp).toBe(1710000000)
  })

  it('V4: extracts text from message_content string', () => {
    expect(mapMessage(v4Row, 2, v4Opts).text).toBe('Hey V4')
    expect(mapMessage(v4Row, 2, v4Opts).type).toBe('text')
  })
})

// ── buildWechatContactMap ─────────────────────────────────────────────────────

describe('buildWechatContactMap', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-contact-test-'))
  })

  it('WeChat 4.x: reads from contact table with username/nick_name columns', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE contact (username TEXT, nick_name TEXT)')
    db.prepare('INSERT INTO contact VALUES (?, ?)').run('wxid_alice', 'Alice')
    db.prepare('INSERT INTO contact VALUES (?, ?)').run('shanchuanzhezi', '山川哲子')
    const dbPath = path.join(tmpDir, 'contact.db')
    fs.writeFileSync(dbPath, db.serialize())
    db.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('wxid_alice')).toBe('Alice')
    expect(map.get('shanchuanzhezi')).toBe('山川哲子')
  })

  it('WeChat 4.x: prefers remark over nick_name when remark is set', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE contact (username TEXT, nick_name TEXT, remark TEXT)')
    db.prepare('INSERT INTO contact VALUES (?, ?, ?)').run('shanchuanzhezi', '山川哲子', 'Gabryl Duke')
    db.prepare('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_noremark', 'NickOnly', '')
    const dbPath = path.join(tmpDir, 'contact.db')
    fs.writeFileSync(dbPath, db.serialize())
    db.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('shanchuanzhezi')).toBe('Gabryl Duke')
    expect(map.get('wxid_noremark')).toBe('NickOnly')
  })

  it('returns correct mappings from contact.db (legacy WCContact schema)', () => {
    const contactDb = makeMockContactDb([
      { m_nsUsrName: 'wxid_alice', m_nsNickName: 'Alice' },
      { m_nsUsrName: 'wxid_bob', m_nsNickName: 'Bob' },
    ])
    const dbPath = path.join(tmpDir, 'contact.db')
    fs.writeFileSync(dbPath, contactDb.serialize())
    contactDb.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('wxid_alice')).toBe('Alice')
    expect(map.get('wxid_bob')).toBe('Bob')
  })

  it('returns correct mappings from WCDB_Contact.db (old format fallback)', () => {
    const contactDb = makeMockContactDb([
      { m_nsUsrName: 'wxid_carol', m_nsNickName: 'Carol' },
    ])
    const dbPath = path.join(tmpDir, 'WCDB_Contact.db')
    fs.writeFileSync(dbPath, contactDb.serialize())
    contactDb.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('wxid_carol')).toBe('Carol')
  })

  it('returns empty map when no contact database found', () => {
    const map = buildWechatContactMap(tmpDir)
    expect(map.size).toBe(0)
  })

  it('returns empty map without throwing for inaccessible directory', () => {
    expect(() => buildWechatContactMap('/nonexistent/path/xyz')).not.toThrow()
    expect(buildWechatContactMap('/nonexistent/path/xyz').size).toBe(0)
  })

  it('prefers m_nsRemark over m_nsNickName when remark is non-empty', () => {
    const contactDb = makeMockContactDbWithRemark([
      { m_nsUsrName: 'shanchuanzhezi', m_nsNickName: '山川哲子', m_nsRemark: 'Gabryl Duke' },
    ])
    const dbPath = path.join(tmpDir, 'contact.db')
    fs.writeFileSync(dbPath, contactDb.serialize())
    contactDb.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('shanchuanzhezi')).toBe('Gabryl Duke')
  })

  it('falls back to m_nsNickName when m_nsRemark is empty', () => {
    const contactDb = makeMockContactDbWithRemark([
      { m_nsUsrName: 'wxid_someone', m_nsNickName: 'Someone', m_nsRemark: '' },
    ])
    const dbPath = path.join(tmpDir, 'contact.db')
    fs.writeFileSync(dbPath, contactDb.serialize())
    contactDb.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('wxid_someone')).toBe('Someone')
  })

  it('falls back to m_nsNickName when m_nsRemark is whitespace only', () => {
    const contactDb = makeMockContactDbWithRemark([
      { m_nsUsrName: 'wxid_ws', m_nsNickName: 'Nickname', m_nsRemark: '   ' },
    ])
    const dbPath = path.join(tmpDir, 'contact.db')
    fs.writeFileSync(dbPath, contactDb.serialize())
    contactDb.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('wxid_ws')).toBe('Nickname')
  })

  it('works correctly with old-format DB that has no m_nsRemark column', () => {
    // makeMockContactDb creates a table WITHOUT m_nsRemark — must still work.
    const contactDb = makeMockContactDb([
      { m_nsUsrName: 'wxid_legacy', m_nsNickName: 'Legacy User' },
    ])
    const dbPath = path.join(tmpDir, 'contact.db')
    fs.writeFileSync(dbPath, contactDb.serialize())
    contactDb.close()

    const map = buildWechatContactMap(tmpDir)
    expect(map.get('wxid_legacy')).toBe('Legacy User')
  })
})

// ── buildSenderIdMap ──────────────────────────────────────────────────────────

describe('buildSenderIdMap', () => {
  it('builds rowid → username map from Name2Id', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE Name2Id (user_name TEXT, is_session INTEGER)')
    db.prepare('INSERT INTO Name2Id VALUES (?, ?)').run('wxid_self', 0)
    db.prepare('INSERT INTO Name2Id VALUES (?, ?)').run('shanchuanzhezi', 1)

    const map = buildSenderIdMap(db)
    expect(map.size).toBe(2)
    // rowid 1 → first inserted row
    expect(map.get(1)).toBe('wxid_self')
    expect(map.get(2)).toBe('shanchuanzhezi')
    db.close()
  })

  it('returns empty map when Name2Id table is absent', () => {
    const db = new Database(':memory:')
    const map = buildSenderIdMap(db)
    expect(map.size).toBe(0)
    db.close()
  })
})

// ── extractSelfWxid ───────────────────────────────────────────────────────────

describe('extractSelfWxid', () => {
  it('strips 4-hex suffix from directory name', () => {
    expect(extractSelfWxid('/path/to/wxid_ojfwi5f52hio12_d1f6')).toBe('wxid_ojfwi5f52hio12')
  })

  it('returns name unchanged when no 4-hex suffix is present', () => {
    expect(extractSelfWxid('/path/to/wxid_abc123')).toBe('wxid_abc123')
  })

  it('handles uppercase hex suffix', () => {
    expect(extractSelfWxid('/path/to/wxid_abc123_A1B2')).toBe('wxid_abc123')
  })
})

// ── discoverMessageDbs ────────────────────────────────────────────────────────

describe('discoverMessageDbs', () => {
  it('returns empty array when db_storage/message dir does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-discover-'))
    expect(discoverMessageDbs(tmpDir)).toEqual([])
    fs.rmdirSync(tmpDir)
  })

  it('discovers message_N.db files that exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-discover2-'))
    const msgDir = path.join(tmpDir, 'db_storage', 'message')
    fs.mkdirSync(msgDir, { recursive: true })
    fs.writeFileSync(path.join(msgDir, 'message_0.db'), '')
    fs.writeFileSync(path.join(msgDir, 'message_3.db'), '')
    fs.writeFileSync(path.join(msgDir, 'message_11.db'), '')
    fs.writeFileSync(path.join(msgDir, 'contact.db'), '')  // should not match

    const found = discoverMessageDbs(tmpDir)
    expect(found).toHaveLength(3)
    expect(found.some(p => p.endsWith('message_0.db'))).toBe(true)
    expect(found.some(p => p.endsWith('message_3.db'))).toBe(true)
    expect(found.some(p => p.endsWith('message_11.db'))).toBe(true)
    fs.rmSync(tmpDir, { recursive: true })
  })
})

// ── findUserDir ───────────────────────────────────────────────────────────────

describe('findUserDir', () => {
  it('returns null when directory does not exist', () => {
    expect(findUserDir('/nonexistent/path')).toBeNull()
  })

  it('returns null when no wxid_ directory exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-userdir-'))
    fs.mkdirSync(path.join(tmpDir, 'all_users'))
    expect(findUserDir(tmpDir)).toBeNull()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('returns the first wxid_ directory found', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-userdir2-'))
    fs.mkdirSync(path.join(tmpDir, 'wxid_test123'))
    const result = findUserDir(tmpDir)
    expect(result).toContain('wxid_test123')
    fs.rmSync(tmpDir, { recursive: true })
  })
})

// ── openWechatDb ──────────────────────────────────────────────────────────────

describe('openWechatDb', () => {
  it('returns null for a non-SQLite file without throwing', () => {
    const tmp = path.join(os.tmpdir(), 'fake_wechat.db')
    fs.writeFileSync(tmp, 'this is not a sqlite database at all')
    expect(() => openWechatDb(tmp, '')).not.toThrow()
    expect(openWechatDb(tmp, '')).toBeNull()
    fs.unlinkSync(tmp)
  })

  it('returns null for a non-existent file without throwing', () => {
    expect(() => openWechatDb('/nonexistent/message_0.db', '')).not.toThrow()
    expect(openWechatDb('/nonexistent/message_0.db', '')).toBeNull()
  })

  it('opens a valid unencrypted SQLite database', () => {
    const tmp = path.join(os.tmpdir(), 'valid_wechat.db')
    const testDb = new Database(tmp)
    testDb.exec('CREATE TABLE test (id INTEGER)')
    testDb.close()

    const result = openWechatDb(tmp, '')
    expect(result).not.toBeNull()
    result?.close()
    fs.unlinkSync(tmp)
  })
})

// ── runBackfillImpl integration ───────────────────────────────────────────────

describe('runBackfillImpl integration', () => {
  beforeEach(() => { initDb(':memory:') })

  it('imports chats and messages from two mock message DB files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-backfill-'))
    const rows1: WechatMessageRow[] = [
      { msgSvrID: 1001, CreateTime: 1700000001, Message: 'Hi', Des: 1 },
      { msgSvrID: 1002, CreateTime: 1700000002, Message: null, Des: 0 },
    ]
    const rows2: WechatMessageRow[] = [
      { msgSvrID: 2001, CreateTime: 1700000003, Message: 'Group msg', Des: 1 },
    ]

    // Create mock message_N.db files with Chat_* tables
    const db1 = makeMockChatDb('wxid_alice', rows1)
    const db2 = makeMockChatDb('room1_chatroom', rows2)

    const path1 = path.join(tmpDir, 'message_0.db')
    const path2 = path.join(tmpDir, 'message_1.db')
    fs.writeFileSync(path1, db1.serialize())
    fs.writeFileSync(path2, db2.serialize())
    db1.close()
    db2.close()

    const contactMap = new Map([
      ['Msg_wxid_alice', 'Alice'],
      ['Msg_room1_chatroom', 'Group Chat'],
    ])
    await runBackfillImpl([path1, path2], contactMap, new Map())

    const chats = getChats()
    expect(chats).toHaveLength(2)
    expect(chats.every(c => c.platform === 'wechat')).toBe(true)

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('is idempotent — running twice yields same chat count', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-idem-'))
    const rows: WechatMessageRow[] = [
      { msgSvrID: 3001, CreateTime: 1700000010, Message: 'Hey', Des: 1 },
    ]
    const db = makeMockChatDb('wxid_carol', rows)
    const dbPath = path.join(tmpDir, 'message_0.db')
    fs.writeFileSync(dbPath, db.serialize())
    db.close()

    await runBackfillImpl([dbPath], new Map(), new Map())
    await runBackfillImpl([dbPath], new Map(), new Map())

    expect(getChats()).toHaveLength(1)
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('handles non-existent DB path gracefully (skips it)', async () => {
    await expect(runBackfillImpl(['/nonexistent/message_0.db'], new Map(), new Map())).resolves.not.toThrow()
  })

  it('skips tables with unknown schema without crashing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-schema-'))
    const db = new Database(':memory:')
    // Table with non-standard columns
    db.exec(`CREATE TABLE Chat_weird (colA TEXT, colB INTEGER)`)
    db.exec(`INSERT INTO Chat_weird VALUES ('hello', 42)`)
    const dbPath = path.join(tmpDir, 'message_0.db')
    fs.writeFileSync(dbPath, db.serialize())
    db.close()

    // Missing CreateTime column causes error → should be caught gracefully
    await expect(runBackfillImpl([dbPath], new Map(), new Map())).resolves.not.toThrow()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('incremental sync: only imports messages newer than last_synced_at', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-incremental-'))
    const syncTime = 1700000010
    const rows: WechatMessageRow[] = [
      { msgSvrID: 4001, CreateTime: syncTime - 100, Message: 'Old msg', Des: 1 },
      { msgSvrID: 4002, CreateTime: syncTime + 100, Message: 'New msg', Des: 0 },
    ]
    const db = makeMockChatDb('wxid_frank', rows)
    const dbPath = path.join(tmpDir, 'message_0.db')
    fs.writeFileSync(dbPath, db.serialize())
    db.close()

    // Seed last_synced_at so incremental mode activates
    const chatId = tableNameToChatId('Msg_wxid_frank')
    getDb().prepare(
      "INSERT INTO chats (id, name, type, username, platform, last_synced_at, message_count) VALUES (?, 'Frank', 'private', NULL, 'wechat', ?, 0)",
    ).run(chatId, syncTime)

    await runBackfillImpl([dbPath], new Map(), new Map())

    const msgs = getDb().prepare('SELECT external_id FROM messages WHERE chat_id = ?').all(chatId) as { external_id: string }[]
    const ids = msgs.map(m => m.external_id)
    expect(ids).not.toContain('4001')
    expect(ids).toContain('4002')

    fs.rmSync(tmpDir, { recursive: true })
  })
})
