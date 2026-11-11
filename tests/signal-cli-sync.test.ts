import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mock only the transport connect; keep real types/helpers (extractEnvelope).
vi.mock('../src/platforms/signal/cli-client', async (importActual) => {
  const actual = await importActual<typeof import('../src/platforms/signal/cli-client')>()
  return { ...actual, connectSignalCli: vi.fn() }
})
// Mock the shared media/OCR pipeline (assert reuse without touching real deps).
vi.mock('../src/media-storage', () => ({ storeMedia: vi.fn().mockReturnValue('/media/signal/stored.jpg') }))
vi.mock('../src/ocr', () => ({ extractText: vi.fn().mockResolvedValue('ocr text') }))

import { initDb, getDb, rebuildFtsIndex, searchMessages } from '../src/db'
import { handleListChats } from '../src/query-handlers'
import { connectSignalCli, type SignalCliClient, type SignalEnvelope, type ConnectResult } from '../src/platforms/signal/cli-client'
import { createSignalCliAdapter } from '../src/platforms/signal/cli-sync'
import { storeMedia } from '../src/media-storage'

// ── Fake client ───────────────────────────────────────────────────────────────

interface FakeConfig {
  accounts?: unknown
  groups?: unknown[]
  contacts?: unknown[]
  queued?: SignalEnvelope[]
}

interface FakeClient extends SignalCliClient {
  closed: boolean
}

function makeFakeClient(cfg: FakeConfig): FakeClient {
  const receivers: Array<(env: SignalEnvelope) => void> = []
  return {
    closed: false,
    async request<T>(method: string): Promise<T> {
      if (method === 'listAccounts') return (cfg.accounts ?? [{ number: '+1555' }]) as T
      if (method === 'listGroups') return (cfg.groups ?? []) as T
      if (method === 'listContacts') return (cfg.contacts ?? []) as T
      if (method === 'receive') {
        for (const env of cfg.queued ?? []) for (const h of receivers) h(env)
        return undefined as T
      }
      return undefined as T
    },
    onReceive(h) {
      receivers.push(h)
    },
    close() {
      this.closed = true
    },
  }
}

let createdClients: FakeClient[] = []
function mockConnect(cfg: FakeConfig): void {
  vi.mocked(connectSignalCli).mockImplementation(async (): Promise<ConnectResult> => {
    const client = makeFakeClient(cfg)
    createdClients.push(client)
    return { ok: true, client }
  })
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const T = 1_700_000_000_000
function textEnv(over: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return { sourceUuid: 'u-alice', sourceName: 'Alice', timestamp: T, dataMessage: { message: 'hello world' }, ...over }
}

let attachDir: string

beforeEach(() => {
  initDb(':memory:')
  createdClients = []
  attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigcli-att-'))
  process.env['SIGNAL_CLI_ATTACHMENTS_DIR'] = attachDir
  vi.clearAllMocks()
  vi.mocked(storeMedia).mockReturnValue('/media/signal/stored.jpg')
})

afterEach(() => {
  delete process.env['SIGNAL_CLI_ATTACHMENTS_DIR']
  fs.rmSync(attachDir, { recursive: true, force: true })
})

function msgCount(): number {
  return getDb().prepare('SELECT COUNT(*) FROM messages').pluck().get() as number
}

// ── Drain + dedup ─────────────────────────────────────────────────────────────

describe('signal-cli adapter — drain and dedup', () => {
  it('ingests queued chats and messages once into the DB', async () => {
    mockConnect({
      groups: [{ id: 'G1', name: 'Family' }],
      queued: [
        textEnv(),
        textEnv({ dataMessage: { message: 'group hi', groupInfo: { groupId: 'G1' } }, timestamp: T + 1 }),
        { sourceUuid: 'u-me', sourceName: 'Me', timestamp: T + 2, syncMessage: { sentMessage: { destination: 'u-bob', message: 'sent one' } } },
      ],
    })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await adapter.runBackfill(getDb())

    expect(msgCount()).toBe(3)
    const chats = handleListChats({ platform: 'signal' })
    const names = chats.map((c) => c.name).sort()
    expect(names).toContain('Family')
    expect(names).toContain('Alice')
    // own-send is attributed is_sender = 1
    const sentRow = getDb().prepare("SELECT is_sender FROM messages WHERE text = 'sent one'").pluck().get()
    expect(sentRow).toBe(1)
  })

  it('creates no duplicate rows when the same envelopes are re-drained', async () => {
    mockConnect({ queued: [textEnv()] })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await adapter.runBackfill(getDb())
    expect(msgCount()).toBe(1)
    await adapter.syncIncremental!(getDb(), new Date(T))
    expect(msgCount()).toBe(1)
  })

  it('releases the socket after a drain', async () => {
    mockConnect({ queued: [textEnv()] })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await adapter.runBackfill(getDb())
    expect(createdClients.every((c) => c.closed)).toBe(true)
  })

  it('is queryable through the shared query surfaces with the signal platform', async () => {
    mockConnect({ queued: [textEnv()] })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await adapter.runBackfill(getDb())
    rebuildFtsIndex()
    const hits = searchMessages('hello', { platform: 'signal' })
    expect(hits.length).toBe(1)
    expect(hits[0]?.platform).toBe('signal')
  })
})

// ── Image ingestion ─────────────────────────────────────────────────────────

describe('signal-cli adapter — image attachments', () => {
  it('stores + OCRs an image whose decrypted file exists', async () => {
    fs.writeFileSync(path.join(attachDir, 'att-img'), Buffer.from('fake-image-bytes'))
    mockConnect({
      queued: [
        textEnv({ dataMessage: { message: 'pic', attachments: [{ id: 'att-img', contentType: 'image/jpeg', width: 100, height: 80 }] } }),
      ],
    })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await adapter.runBackfill(getDb())

    expect(storeMedia).toHaveBeenCalledTimes(1)
    const row = getDb().prepare('SELECT media_file_path, ocr_text FROM messages LIMIT 1').get() as {
      media_file_path: string | null
      ocr_text: string | null
    }
    expect(row.media_file_path).toBe('/media/signal/stored.jpg')
    expect(row.ocr_text).toBe('ocr text')
  })

  it('archives the message without media when the decrypted file is missing (expired), no crash', async () => {
    mockConnect({
      queued: [
        textEnv({ dataMessage: { attachments: [{ id: 'att-missing', contentType: 'image/jpeg' }] } }),
      ],
    })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await expect(adapter.runBackfill(getDb())).resolves.toBeUndefined()
    expect(msgCount()).toBe(1)
    const row = getDb().prepare('SELECT media_file_path FROM messages LIMIT 1').get() as { media_file_path: string | null }
    expect(row.media_file_path).toBeNull()
    expect(storeMedia).not.toHaveBeenCalled()
  })
})

// ── Graceful degradation ──────────────────────────────────────────────────────

describe('signal-cli adapter — graceful degradation', () => {
  it('throws a typed error when the daemon is unreachable', async () => {
    vi.mocked(connectSignalCli).mockResolvedValue({ ok: false, reason: 'unreachable', message: 'daemon down' })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await expect(adapter.runBackfill(getDb())).rejects.toThrow(/signal-cli daemon unavailable/)
    expect(msgCount()).toBe(0)
  })

  it('writes nothing and does not throw when the device is not linked', async () => {
    mockConnect({ accounts: [], queued: [textEnv()] })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await expect(adapter.runBackfill(getDb())).resolves.toBeUndefined()
    expect(msgCount()).toBe(0)
  })

  it('completes as a clean no-op when nothing is queued', async () => {
    mockConnect({ queued: [] })
    const adapter = createSignalCliAdapter('default', { name: 'default', fields: {} })
    await expect(adapter.runBackfill(getDb())).resolves.toBeUndefined()
    expect(msgCount()).toBe(0)
  })
})
