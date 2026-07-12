/**
 * E2E tests for Signal image sync pipeline.
 *
 * Three integration scenarios:
 *   1. runBackfillImpl with a mixed chat (text + image) verifies DB row insertion,
 *      image sync dispatch, log output, and text-row resilience.
 *   2. handleGetImage returns file_available: true after an image is stored.
 *   3. OCR text stored on an image message appears in FTS search results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initDb, upsertChat, insertMessage, rebuildFtsIndex, getDb } from '../src/db'
import { handleGetImage } from '../src/image-handlers'
import { handleSearchMessages } from '../src/query-handlers'
import type { BeeperChat, BeeperMessage, BeeperSignalClient } from '../src/platforms/signal/client'
import * as fs from 'fs'

// Mock fs so handleGetImage can simulate a file on disk without hitting the filesystem.
vi.mock('fs')

// Mock the image-sync module so runBackfillImpl does not need real Beeper access.
vi.mock('../src/platforms/signal/image-sync', () => ({
  processSignalImageMessages: vi.fn().mockResolvedValue({ stored: 0, failed: 0 }),
}))

// Mock vec-db so isIndexed() always returns false (no embedding side-effects in E2E tests).
// importOriginal is required so loadVecExtension and createVecSchema remain real (called by initDb).
vi.mock('../src/vec-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vec-db')>()
  return {
    ...actual,
    isIndexed: vi.fn().mockReturnValue(false),
  }
})

const T = 1_700_000_000

// ── helpers ───────────────────────────────────────────────────────────────────

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

function makeSignalChat(overrides: Partial<BeeperChat> = {}): BeeperChat {
  return {
    id: 'chat-e2e-1',
    accountID: 'signal-acct-1',
    network: 'signal',
    title: 'E2E Chat',
    type: 'single',
    unreadCount: 0,
    participants: { hasMore: false, items: [], total: 1 },
    ...overrides,
  }
}

function makeSignalMessage(overrides: Partial<BeeperMessage> = {}): BeeperMessage {
  return {
    id: 'msg-e2e-text',
    accountID: 'signal-acct-1',
    chatID: 'chat-e2e-1',
    senderID: '@alice:signal',
    sortKey: '1000',
    timestamp: new Date(T * 1000).toISOString(),
    senderName: 'Alice',
    isSender: false,
    type: 'TEXT',
    text: 'hello world',
    ...overrides,
  }
}

function makeMockClient(
  chats: BeeperChat[],
  messagesByChat: Map<string, BeeperMessage[]>,
): BeeperSignalClient {
  return {
    signalAccountIds: vi.fn().mockResolvedValue(['signal-acct-1']),
    listChats: vi.fn(() => asyncGen(chats)),
    listChatMessages: vi.fn((chatId: string) => asyncGen(messagesByChat.get(chatId) ?? [])),
    listNewChatMessages: vi.fn(() => asyncGen([])),
    fetchAttachmentBuffer: vi.fn().mockResolvedValue(null),
  }
}

// ── Test 1: runBackfillImpl with mixed chat ───────────────────────────────────

describe('runBackfillImpl — mixed chat (text + image)', () => {
  beforeEach(async () => {
    initDb(':memory:')
    vi.clearAllMocks()
    const { processSignalImageMessages } = await import('../src/platforms/signal/image-sync')
    vi.mocked(processSignalImageMessages).mockResolvedValue({ stored: 1, failed: 0 })
  })

  it('inserts both text and image rows, dispatches image sync, and logs the image count', async () => {
    const { runBackfillImpl } = await import('../src/platforms/signal/sync')
    const { processSignalImageMessages } = await import('../src/platforms/signal/image-sync')

    const chat = makeSignalChat({ id: 'chat-mixed', title: 'Mixed Chat' })
    const textMsg = makeSignalMessage({ id: 'msg-text-e2e', chatID: 'chat-mixed', type: 'TEXT', text: 'hello' })
    const imageMsg = makeSignalMessage({
      id: 'msg-img-e2e',
      chatID: 'chat-mixed',
      type: 'IMAGE',
      text: undefined,
      attachments: [{ type: 'img', srcURL: 'beeper://signal/img/msg-img-e2e', mimeType: 'image/jpeg' }],
    } as Partial<BeeperMessage>)

    const msgMap = new Map([['chat-mixed', [textMsg, imageMsg]]])
    const client = makeMockClient([chat], msgMap)

    const consoleSpy = vi.spyOn(console, 'log')

    await runBackfillImpl(client, 'test-account')

    // Both rows were inserted into the DB.
    const allRows = getDb()
      .prepare('SELECT external_id, type FROM messages ORDER BY external_id ASC')
      .all() as { external_id: string; type: string }[]
    expect(allRows).toHaveLength(2)
    const externalIds = allRows.map(r => r.external_id)
    expect(externalIds).toContain('msg-text-e2e')
    expect(externalIds).toContain('msg-img-e2e')

    // The text row survives even when image fetch may fail.
    const textRow = allRows.find(r => r.external_id === 'msg-text-e2e')!
    expect(textRow.type).toBe('text')

    // processSignalImageMessages was called with only the IMAGE message.
    expect(processSignalImageMessages).toHaveBeenCalledOnce()
    const [, , imageMsgsArg] = vi.mocked(processSignalImageMessages).mock.calls[0]!
    expect(imageMsgsArg).toHaveLength(1)
    expect(imageMsgsArg[0]!.id).toBe('msg-img-e2e')

    // Completion log line includes "images: 1 stored, 0 failed".
    const logCall = consoleSpy.mock.calls.find(c => String(c[0]).includes('Sync complete'))
    expect(logCall).toBeDefined()
    expect(String(logCall![0])).toMatch(/images: 1 stored, 0 failed/)

    consoleSpy.mockRestore()
  })
})

// ── Test 2: handleGetImage returns file_available: true ───────────────────────

describe('handleGetImage — returns file_available: true after image is stored', () => {
  let messageId: number

  beforeEach(() => {
    initDb(':memory:')
    vi.clearAllMocks()

    const chatId = upsertChat({
      external_id: 'chat-gi-1',
      account: 'default',
      name: 'Image Chat',
      type: 'private',
      username: null,
      platform: 'signal',
    })

    insertMessage({
      external_id: 'msg-gi-1',
      chat_id: chatId,
      sender_id: null,
      sender_name: 'Alice',
      text: null,
      type: 'image',
      timestamp: T,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'signal',
      media_file_path: '/stored/signal/image.jpg',
      media_url: null,
      media_width: 800,
      media_height: 600,
      ocr_text: 'hello from ocr',
    })

    const row = getDb()
      .prepare('SELECT id FROM messages WHERE external_id = ? AND chat_id = ?')
      .get('msg-gi-1', chatId) as { id: number }
    messageId = row.id
  })

  it('returns file_available: true with base64 content when media_file_path is set and file exists', async () => {
    // Simulate the stored file being readable on disk.
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from('signal-image-bytes'))

    const result = await handleGetImage(messageId)

    expect(result.file_available).toBe(true)
    if (!result.file_available) throw new Error('expected file_available: true')

    expect(result.message_id).toBe(messageId)
    expect(result.type).toBe('image')
    expect(result.file_path).toBe('/stored/signal/image.jpg')
    expect(result.content_base64).toBe(Buffer.from('signal-image-bytes').toString('base64'))
    expect(result.ocr_text).toBe('hello from ocr')
    expect(result.ocr_available).toBe(true)
  })
})

// ── Test 3: OCR text is searchable via FTS ────────────────────────────────────

describe('FTS searchability — OCR text appears in handleSearchMessages results', () => {
  beforeEach(() => {
    initDb(':memory:')
  })

  it('finds a Signal image message by its ocr_text after FTS rebuild', () => {
    const chatId = upsertChat({
      external_id: 'chat-fts-1',
      account: 'default',
      name: 'OCR Chat',
      type: 'private',
      username: null,
      platform: 'signal',
    })

    // Insert a Signal image message with unique OCR text.
    insertMessage({
      external_id: 'msg-fts-ocr',
      chat_id: chatId,
      sender_id: null,
      sender_name: 'Bob',
      text: null,
      type: 'image',
      timestamp: T,
      is_sender: 0,
      reply_to_external_id: null,
      platform: 'signal',
      media_file_path: '/stored/signal/fts-image.jpg',
      media_url: null,
      media_width: null,
      media_height: null,
      ocr_text: 'uniqueocrtermxyz',
    })

    // Rebuild the FTS index to ensure the newly inserted row is indexed.
    rebuildFtsIndex()

    // Search for the unique OCR term.
    const results = handleSearchMessages('uniqueocrtermxyz')

    expect(results.length).toBeGreaterThan(0)
    const found = results.find(r => r.platform === 'signal')
    expect(found).toBeDefined()
  })
})
