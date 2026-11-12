import { describe, it, expect } from 'vitest'
import { createStoreReader, CALL } from '../src/platforms/zalo/history/store-reader'
import type { CdpSession } from '../src/platforms/zalo/history/cdp'
import type { Result } from '../src/platforms/zalo/history/types'

type Answer = Result<unknown> | (() => Result<unknown>)

/** Fake session: answers by the call marker embedded in each expression. */
function fakeSession(answers: Partial<Record<keyof typeof CALL, Answer | Answer[]>>) {
  const seen: string[] = []
  const queues = new Map<string, Answer[]>()
  for (const [k, v] of Object.entries(answers)) queues.set(k, Array.isArray(v) ? [...v] : [v as Answer])
  const session: CdpSession = {
    async evaluate<T>(expression: string): Promise<Result<T>> {
      const key = (Object.keys(CALL) as Array<keyof typeof CALL>).find((k) => expression.includes(CALL[k]))
      if (!key) throw new Error('unknown expression')
      seen.push(expression)
      const q = queues.get(key) ?? []
      const a = q.length > 1 ? q.shift()! : q[0]
      if (!a) throw new Error(`no answer for ${key}`)
      return (typeof a === 'function' ? a() : a) as Result<T>
    },
    onClose() {},
    close() {},
  }
  return { session, seen }
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fast = { sleep: async () => {}, readyTries: 3 }

const GOOD_ROW = {
  msgId: '8481248414744', cliMsgId: '1794483366795', fromUid: '1017560865672061899', toUid: '1017560865672061899',
  sendDttm: '1794483366878', serverTime: '1794483366900', msgType: 1, message: 'hello', dName: 'Linh',
}

describe('probeStore', () => {
  it('succeeds when the store and all read functions exist', async () => {
    const { session } = fakeSession({ probe: ok({ jsonp: true, store: true, missing: [] }) })
    expect(await createStoreReader(session, '26.11.10', fast).probeStore()).toEqual({ ok: true, value: true })
  })

  it('reports unrecognised shape naming the missing pieces and the Zalo version', async () => {
    const { session } = fakeSession({ probe: ok({ jsonp: true, store: true, missing: ['getConversations'] }) })
    expect(await createStoreReader(session, '27.1.0', fast).probeStore()).toEqual({
      ok: false,
      error: { kind: 'shape_unrecognised', step: 'shape', detail: 'missing store functions: getConversations', zaloVersion: '27.1.0' },
    })
  })

  it('retries while the renderer is still loading, then fails when the store module never resolves', async () => {
    const { session, seen } = fakeSession({ probe: ok({ jsonp: false, store: false, missing: [] }) })
    const r = await createStoreReader(session, '26.11.10', fast).probeStore()
    expect(r).toMatchObject({ ok: false, error: { kind: 'shape_unrecognised', detail: expect.stringMatching(/XS0u|webpackJsonp/) } })
    expect(seen.length).toBe(3)
  })
})

describe('getMe', () => {
  it('returns the logged-in user', async () => {
    const { session } = fakeSession({ me: ok({ uid: '283886062958706980', name: 'Yanick' }) })
    expect(await createStoreReader(session, null, fast).getMe()).toEqual(ok({ uid: '283886062958706980', name: 'Yanick' }))
  })

  it('polls until the uid appears', async () => {
    const { session } = fakeSession({ me: [ok({ uid: '', name: '' }), ok({ uid: '42', name: 'Y' })] })
    expect(await createStoreReader(session, null, fast).getMe()).toEqual(ok({ uid: '42', name: 'Y' }))
  })

  it('returns null (not logged in) when the uid stays empty', async () => {
    const { session } = fakeSession({ me: ok({ uid: '', name: '' }) })
    expect(await createStoreReader(session, null, fast).getMe()).toEqual(ok(null))
  })
})

describe('getMe when logged out', () => {
  it('checks the uid before calling getMe(), so a logged-out store is not_logged_in, not a shape error', async () => {
    const { session, seen } = fakeSession({ me: ok({ uid: '', name: '' }) })
    expect(await createStoreReader(session, null, fast).getMe()).toEqual(ok(null))
    const expr = seen[0]!
    expect(expr.indexOf('getUserId()')).toBeLessThan(expr.indexOf('getMe()'))
    expect(expr).toMatch(/if \(!uid\) return/)
  })
})

describe('listConversations', () => {
  it('returns validated conversations', async () => {
    const convs = [
      { uid: '1017560865672061899', name: 'Linh', isGroup: false, isOfficialAccount: false },
      { uid: 'g99', name: 'Team', isGroup: true, isOfficialAccount: false },
    ]
    const { session } = fakeSession({ conversations: ok(convs) })
    expect(await createStoreReader(session, null, fast).listConversations()).toEqual(ok(convs))
  })

  it('rejects a malformed conversation as unrecognised shape', async () => {
    const { session } = fakeSession({ conversations: ok([{ uid: 5, name: 'x', isGroup: false, isOfficialAccount: false }]) })
    expect(await createStoreReader(session, '26.11.10', fast).listConversations())
      .toMatchObject({ ok: false, error: { kind: 'shape_unrecognised', detail: expect.stringMatching(/conversation/) } })
  })
})

describe('getMessagePage', () => {
  it('returns validated rows and passes uid, limit, and cursor into the renderer call', async () => {
    const { session, seen } = fakeSession({ page: ok([GOOD_ROW]) })
    const r = await createStoreReader(session, null, fast)
      .getMessagePage('1017560865672061899', { sendDttm: '1794483366878', msgId: '8481248414744' }, 500)
    expect(r).toEqual(ok([GOOD_ROW]))
    expect(seen[0]).toContain('"1017560865672061899"')
    expect(seen[0]).toContain('"sendDttm":"1794483366878"')
    expect(seen[0]).toContain('500')
  })

  it('normalizes numeric ids to strings and missing optional fields to null', async () => {
    const { session } = fakeSession({ page: ok([{ ...GOOD_ROW, msgId: 8481248414744, serverTime: undefined, dName: undefined }]) })
    const r = await createStoreReader(session, null, fast).getMessagePage('u', null, 500)
    expect(r).toEqual(ok([{ ...GOOD_ROW, msgId: '8481248414744', serverTime: null, dName: null }]))
  })

  it('keeps object messages (media/location) as objects', async () => {
    const loc = { ...GOOD_ROW, msgType: 17, message: { title: 'Café', desc: 'HN' } }
    const { session } = fakeSession({ page: ok([loc]) })
    expect(await createStoreReader(session, null, fast).getMessagePage('u', null, 500)).toEqual(ok([loc]))
  })

  it('one malformed row fails the whole page', async () => {
    const { session } = fakeSession({ page: ok([GOOD_ROW, { ...GOOD_ROW, sendDttm: null }]) })
    expect(await createStoreReader(session, '26.11.10', fast).getMessagePage('u', null, 500))
      .toMatchObject({ ok: false, error: { kind: 'shape_unrecognised', detail: expect.stringMatching(/sendDttm/) } })
  })

  it('a null page from Zalo PC is a shape error, never an empty page (end of history)', async () => {
    const { session } = fakeSession({ page: ok(null) })
    expect(await createStoreReader(session, null, fast).getMessagePage('u', null, 500))
      .toMatchObject({ ok: false, error: { kind: 'shape_unrecognised' } })
  })

  it('a timeout stays an attach error instead of blaming the Zalo version', async () => {
    const { session } = fakeSession({ page: { ok: false, error: { kind: 'attach_failed', step: 'attach', message: 'renderer call timed out after 60000ms' } } })
    expect(await createStoreReader(session, null, fast).getMessagePage('u', null, 500))
      .toMatchObject({ ok: false, error: { kind: 'attach_failed', message: expect.stringMatching(/timed out/) } })
  })

  it('maps a renderer exception to unrecognised shape, but passes a lost connection through', async () => {
    const thrown = fakeSession({ page: { ok: false, error: { kind: 'attach_failed', step: 'attach', message: 'TypeError: x is not a function' } } })
    expect(await createStoreReader(thrown.session, '26.11.10', fast).getMessagePage('u', null, 500))
      .toMatchObject({ ok: false, error: { kind: 'shape_unrecognised', detail: expect.stringMatching(/TypeError/) } })
    const lost = fakeSession({ page: { ok: false, error: { kind: 'connection_lost', step: 'read', conversationsDone: 0 } } })
    expect(await createStoreReader(lost.session, null, fast).getMessagePage('u', null, 500))
      .toMatchObject({ ok: false, error: { kind: 'connection_lost' } })
  })
})

describe('read-only guarantee', () => {
  it('never calls network, decryption, or write modules', async () => {
    const { session, seen } = fakeSession({
      probe: ok({ jsonp: true, store: true, missing: [] }),
      me: ok({ uid: '1', name: 'a' }),
      conversations: ok([]),
      page: ok([]),
    })
    const r = createStoreReader(session, null, fast)
    await r.probeStore(); await r.getMe(); await r.listConversations(); await r.getMessagePage('u', null, 5)
    const all = seen.join('\n')
    expect(all).not.toMatch(/fBUP|z0WU|decode|fetch\(|XMLHttpRequest|\.(delete|remove|update|insert|save|send|set|put|clear)\w*\(/i)
  })
})
