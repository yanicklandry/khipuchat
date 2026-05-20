import { describe, it, expect, afterAll } from 'vitest'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { initDb, upsertChat, insertMessage } from '../src/db'
import { isIndexed } from '../src/vec-db'

const ROOT = path.join(__dirname, '..')
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')
const CLI = path.join(ROOT, 'src', 'index-embeddings.ts')

// Unique temp file per test run so parallel runs don't collide
const tmpDb = path.join(os.tmpdir(), `khipuchat-e2e-${Date.now()}.db`)

describe('E2E: index:embeddings CLI', () => {
  afterAll(() => {
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + ext) } catch { /* ignore */ }
    }
  })

  it('first run: exits 0, stdout contains Done. Indexed, embedding_meta has rows for messages and chats', () => {
    // Seed a file-based DB — initDb creates the full schema including vec tables
    initDb(tmpDb)
    upsertChat({ id: 1, name: 'Alice', type: 'user', username: null, platform: 'telegram', last_synced_at: null, message_count: 1 })
    upsertChat({ id: 2, name: 'Bob', type: 'user', username: null, platform: 'imessage', last_synced_at: null, message_count: 1 })
    insertMessage({ external_id: 'm1', chat_id: 1, sender_id: null, sender_name: 'Alice', text: 'Hello from Shanghai', type: 'text', timestamp: 1000, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
    insertMessage({ external_id: 'm2', chat_id: 2, sender_id: null, sender_name: 'Bob', text: 'iMessage content here', type: 'text', timestamp: 2000, is_sender: 0, reply_to_external_id: null, platform: 'imessage' })

    // Run the CLI in a subprocess — KHIPUCHAT_EMBED_MOCK skips the 90 MB model download
    const stdout = execSync(`${TSX} ${CLI} --db ${tmpDb}`, {
      env: { ...process.env, KHIPUCHAT_EMBED_MOCK: '1' },
      encoding: 'utf8',
    })

    expect(stdout).toContain('Done. Indexed')
    // In-process connection sees CLI's committed writes via WAL mode
    expect(isIndexed('messages')).toBe(true)
    expect(isIndexed('chats')).toBe(true)
  })

  it('second run: skips already-indexed records and prints Done. Indexed 0 messages, 0 chats.', () => {
    // Re-run on same DB — all records already indexed
    const stdout = execSync(`${TSX} ${CLI} --db ${tmpDb}`, {
      env: { ...process.env, KHIPUCHAT_EMBED_MOCK: '1' },
      encoding: 'utf8',
    })

    expect(stdout).toContain('Done. Indexed 0 messages, 0 chats.')
  })
})
