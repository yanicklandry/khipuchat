import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { extractImageMeta, type ImageMeta } from '../src/platforms/wechat/image-meta'
import type { WechatMessageRow } from '../src/platforms/wechat/sync'
import { initDb, insertMessage, getMessages, type Message } from '../src/db'
import { runMigrations } from '../src/db-migrations'

const NULL_META: ImageMeta = {
  media_file_path: null,
  media_url: null,
  media_width: null,
  media_height: null,
}

describe('extractImageMeta', () => {
  describe('Legacy schema (isV4=false)', () => {
    it('returns non-null media_file_path for a bare file path in strContent', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1001,
        CreateTime: 1700000000,
        strContent: '/Users/user/Library/Containers/com.tencent.xinWeChat/Data/image.jpg',
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta.media_file_path).toBe('/Users/user/Library/Containers/com.tencent.xinWeChat/Data/image.jpg')
      expect(meta.media_url).toBeNull()
      expect(meta.media_width).toBeNull()
      expect(meta.media_height).toBeNull()
    })

    it('returns non-null media_file_path for a bare file path in Message when strContent is absent', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1002,
        CreateTime: 1700000001,
        Message: '/some/path/to/image.png',
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta.media_file_path).toBe('/some/path/to/image.png')
    })

    it('returns non-null media_url from cdnthumburl attribute in XML content', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1003,
        CreateTime: 1700000002,
        strContent: '<msg><img cdnthumburl="http://cdn.example.com/thumb.jpg" cdnthumbwidth="120" cdnthumbheight="90" cdnmidimgurl="http://cdn.example.com/mid.jpg" /></msg>',
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta.media_url).toBe('http://cdn.example.com/thumb.jpg')
      expect(meta.media_width).toBe(120)
      expect(meta.media_height).toBe(90)
    })

    it('falls back to cdnmidimgurl when cdnthumburl is absent', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1004,
        CreateTime: 1700000003,
        strContent: '<msg><img cdnmidimgurl="http://cdn.example.com/mid.jpg" cdnthumbwidth="200" cdnthumbheight="150" /></msg>',
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta.media_url).toBe('http://cdn.example.com/mid.jpg')
    })

    it('returns null fields when XML has no matching attributes', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1005,
        CreateTime: 1700000004,
        strContent: '<msg><img /></msg>',
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta).toEqual(NULL_META)
    })

    it('returns all-null for null strContent', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1006,
        CreateTime: 1700000005,
        strContent: null,
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta).toEqual(NULL_META)
    })

    it('returns all-null for undefined content (both strContent and Message absent)', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1007,
        CreateTime: 1700000006,
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta).toEqual(NULL_META)
    })

    it('parses width/height as finite integers', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1008,
        CreateTime: 1700000007,
        strContent: '<msg><img cdnthumburl="http://example.com/t.jpg" cdnthumbwidth="640" cdnthumbheight="480" /></msg>',
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(Number.isFinite(meta.media_width)).toBe(true)
      expect(Number.isFinite(meta.media_height)).toBe(true)
      expect(meta.media_width).toBe(640)
      expect(meta.media_height).toBe(480)
    })

    it('returns null for width/height when they are non-numeric', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1009,
        CreateTime: 1700000008,
        strContent: '<msg><img cdnthumburl="http://example.com/t.jpg" cdnthumbwidth="NaN" cdnthumbheight="abc" /></msg>',
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta.media_width).toBeNull()
      expect(meta.media_height).toBeNull()
    })

    it('prefers strContent over Message', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1010,
        CreateTime: 1700000009,
        strContent: '/path/from/strContent.jpg',
        Message: '/path/from/Message.jpg',
        Type: 4,
        Des: 1,
      }

      const meta = extractImageMeta(row, false)
      expect(meta.media_file_path).toBe('/path/from/strContent.jpg')
    })
  })

  describe('V4 schema (isV4=true)', () => {
    it('returns non-null media_file_path for bare file path in message_content', () => {
      const row: WechatMessageRow = {
        server_id: 2001,
        create_time: 1700000010,
        message_content: '/Users/user/Library/WeChat/Images/photo.jpg',
        WCDB_CT_message_content: 0,
        local_type: 4,
      }

      const meta = extractImageMeta(row, true)
      expect(meta.media_file_path).toBe('/Users/user/Library/WeChat/Images/photo.jpg')
    })

    it('returns non-null media_url from XML in message_content', () => {
      const row: WechatMessageRow = {
        server_id: 2002,
        create_time: 1700000011,
        message_content: '<msg><img cdnthumburl="http://cdn.example.com/v4thumb.jpg" cdnthumbwidth="320" cdnthumbheight="240" /></msg>',
        WCDB_CT_message_content: 0,
        local_type: 4,
      }

      const meta = extractImageMeta(row, true)
      expect(meta.media_url).toBe('http://cdn.example.com/v4thumb.jpg')
      expect(meta.media_width).toBe(320)
      expect(meta.media_height).toBe(240)
    })

    it('returns all-null for Buffer content (zstd blob, WCDB_CT_message_content=4) without throwing', () => {
      const row: WechatMessageRow = {
        server_id: 2003,
        create_time: 1700000012,
        message_content: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
        WCDB_CT_message_content: 4,
        local_type: 4,
      }

      let meta: ImageMeta | undefined
      expect(() => {
        meta = extractImageMeta(row, true)
      }).not.toThrow()
      expect(meta).toEqual(NULL_META)
    })

    it('returns all-null for null message_content', () => {
      const row: WechatMessageRow = {
        server_id: 2004,
        create_time: 1700000013,
        message_content: null,
        WCDB_CT_message_content: 0,
        local_type: 4,
      }

      const meta = extractImageMeta(row, true)
      expect(meta).toEqual(NULL_META)
    })

    it('returns all-null for undefined message_content', () => {
      const row: WechatMessageRow = {
        server_id: 2005,
        create_time: 1700000014,
        WCDB_CT_message_content: 0,
        local_type: 4,
      }

      const meta = extractImageMeta(row, true)
      expect(meta).toEqual(NULL_META)
    })
  })

  describe('Legacy vs V4 schema parity (Req 3.3)', () => {
    it('produces the same ImageMeta shape from equivalent legacy and V4 rows', () => {
      const xml = '<msg><img cdnthumburl="http://cdn.example.com/img.jpg" cdnthumbwidth="100" cdnthumbheight="80" /></msg>'

      const legacyRow: WechatMessageRow = {
        msgSvrID: 3001,
        CreateTime: 1700000020,
        strContent: xml,
        Type: 4,
        Des: 1,
      }

      const v4Row: WechatMessageRow = {
        server_id: 3001,
        create_time: 1700000020,
        message_content: xml,
        WCDB_CT_message_content: 0,
        local_type: 4,
      }

      const legacyMeta = extractImageMeta(legacyRow, false)
      const v4Meta = extractImageMeta(v4Row, true)

      expect(legacyMeta).toEqual(v4Meta)
    })
  })

  describe('Never throws', () => {
    it('does not throw on any valid WechatMessageRow input', () => {
      const rows: WechatMessageRow[] = [
        {},
        { strContent: null },
        { message_content: null },
        { message_content: Buffer.alloc(0) },
        { strContent: 'invalid <xml unclosed' },
        { strContent: '<msg><img /></msg>' },
        { strContent: '/path/to/file' },
        { message_content: '/v4/path/to/file' },
      ]

      for (const row of rows) {
        expect(() => extractImageMeta(row, false)).not.toThrow()
        expect(() => extractImageMeta(row, true)).not.toThrow()
      }
    })
  })
})

// ── DB integration tests ──────────────────────────────────────────────────────

describe('DB integration — wechat image metadata persistence', () => {
  beforeEach(() => {
    initDb(':memory:')
  })

  it('round-trip: WeChat image Message with all four media fields persists and is returned by getMessages (Req 2.1-2.4)', () => {
    const msg: Message = {
      external_id: 'wechat-img-001',
      chat_id: 1,
      sender_id: 'user_alice',
      sender_name: 'Alice',
      text: null,
      type: 'image',
      timestamp: 1700000100,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'wechat',
      media_file_path: '/path/to/image.jpg',
      media_url: 'http://cdn.example.com/thumb.jpg',
      media_width: 640,
      media_height: 480,
    }

    insertMessage(msg)
    const rows = getMessages(1, 10)

    expect(rows).toHaveLength(1)
    const saved = rows[0]
    expect(saved.external_id).toBe('wechat-img-001')
    expect(saved.media_file_path).toBe('/path/to/image.jpg')
    expect(saved.media_url).toBe('http://cdn.example.com/thumb.jpg')
    expect(saved.media_width).toBe(640)
    expect(saved.media_height).toBe(480)
  })

  it('regression guard: non-WeChat Message with no media keys inserts with four media columns NULL (Req 4.1, 4.2)', () => {
    const msg: Message = {
      external_id: 'tg-text-001',
      chat_id: 2,
      sender_id: 'user_bob',
      sender_name: 'Bob',
      text: 'Hello world',
      type: 'text',
      timestamp: 1700000200,
      is_sender: 1,
      reply_to_external_id: null,
      platform: 'telegram',
    }

    expect(() => insertMessage(msg)).not.toThrow()

    const rows = getMessages(2, 10)
    expect(rows).toHaveLength(1)
    const saved = rows[0]
    expect(saved.external_id).toBe('tg-text-001')
    expect(saved.media_file_path).toBeNull()
    expect(saved.media_url).toBeNull()
    expect(saved.media_width).toBeNull()
    expect(saved.media_height).toBeNull()
  })
})

describe('DB integration — migration idempotency for media columns', () => {
  // Helper: create the pre-feature schema (messages without media columns, plus chats and sync_state)
  function makePreFeatureDb(): Database.Database {
    const rawDb = new Database(':memory:')
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id             INTEGER PRIMARY KEY,
        name           TEXT    NOT NULL,
        type           TEXT    NOT NULL,
        username       TEXT,
        platform       TEXT    NOT NULL DEFAULT 'telegram',
        last_synced_at INTEGER,
        message_count  INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        is_sender INTEGER NOT NULL,
        reply_to_external_id TEXT,
        platform TEXT NOT NULL,
        UNIQUE(external_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS sync_state (
        platform       TEXT    NOT NULL PRIMARY KEY,
        last_synced_at INTEGER NOT NULL
      );
    `)
    return rawDb
  }

  it('adds all four media columns when migrating a pre-feature schema (no media columns)', () => {
    const rawDb = makePreFeatureDb()

    const colsBefore = (rawDb.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(colsBefore).not.toContain('media_file_path')
    expect(colsBefore).not.toContain('media_url')
    expect(colsBefore).not.toContain('media_width')
    expect(colsBefore).not.toContain('media_height')

    runMigrations(rawDb)

    const colsAfter = (rawDb.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(colsAfter).toContain('media_file_path')
    expect(colsAfter).toContain('media_url')
    expect(colsAfter).toContain('media_width')
    expect(colsAfter).toContain('media_height')
  })

  it('re-running runMigrations on an already-migrated schema is a no-op (does not throw)', () => {
    const rawDb = makePreFeatureDb()

    runMigrations(rawDb)
    expect(() => runMigrations(rawDb)).not.toThrow()

    const cols = (rawDb.pragma('table_info(messages)') as { name: string }[]).map(r => r.name)
    expect(cols).toContain('media_file_path')
    expect(cols).toContain('media_url')
    expect(cols).toContain('media_width')
    expect(cols).toContain('media_height')
  })
})
