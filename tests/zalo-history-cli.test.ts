import { describe, it, expect } from 'vitest'
import {
  parseArgs, resolveAccount, exitCodeFor, errorMessage, run, DISCLOSURE, SHAPE_HINT, type CliIo,
} from '../src/platforms/zalo/history/cli'
import type { ImportError, ImportSummary, Result } from '../src/platforms/zalo/history/types'

const SUMMARY: ImportSummary = { conversations: 3, added: 10, alreadyPresent: 2, skipped: 1, failed: [] }

describe('parseArgs', () => {
  it('parses --account, --app-path, and --help', () => {
    expect(parseArgs([])).toEqual({ account: null, appPath: null, help: false })
    expect(parseArgs(['--account', 'work', '--app-path', '/opt/Zalo.app'])).toEqual({ account: 'work', appPath: '/opt/Zalo.app', help: false })
    expect(parseArgs(['--account=work'])).toEqual({ account: 'work', appPath: null, help: false })
    expect(parseArgs(['-h'])).toMatchObject({ help: true })
    expect(parseArgs(['--help'])).toMatchObject({ help: true })
  })

  it('rejects a missing value and unknown flags', () => {
    expect(parseArgs(['--account'])).toEqual({ error: expect.stringMatching(/--account/) })
    expect(parseArgs(['--app-path', '--help'])).toEqual({ error: expect.stringMatching(/--app-path/) })
    expect(parseArgs(['--since', '2020'])).toEqual({ error: expect.stringMatching(/--since/) })
  })
})

describe('resolveAccount', () => {
  it('explicit listed account', () => {
    expect(resolveAccount('work', ['default', 'work'])).toEqual({ account: 'work' })
  })
  it('explicit account that is not listed is an error naming the choices', () => {
    expect(resolveAccount('nope', ['default', 'work'])).toEqual({ error: expect.stringMatching(/nope.*default, work/) })
  })
  it('default when listed', () => {
    expect(resolveAccount(null, ['work', 'default'])).toEqual({ account: 'default' })
  })
  it('the only account', () => {
    expect(resolveAccount(null, ['work'])).toEqual({ account: 'work' })
  })
  it('several accounts and no default is an error listing them', () => {
    expect(resolveAccount(null, ['work', 'personal'])).toEqual({ error: expect.stringMatching(/--account.*work, personal/) })
  })
  it('no accounts at all is an error', () => {
    expect(resolveAccount(null, [])).toEqual({ error: expect.stringMatching(/no zalo account.*khipu\.config\.json/i) })
  })
})

describe('exitCodeFor', () => {
  it('0 on full success, 1 on an error or any failed conversation', () => {
    expect(exitCodeFor({ ok: true, value: SUMMARY })).toBe(0)
    expect(exitCodeFor({ ok: true, value: { ...SUMMARY, failed: [{ name: 'An', reason: 'x' }] } })).toBe(1)
    expect(exitCodeFor({ ok: false, error: { kind: 'not_logged_in', step: 'login' } })).toBe(1)
  })
})

describe('errorMessage', () => {
  const cases: Array<[ImportError, RegExp]> = [
    [{ kind: 'not_installed', step: 'locate', searched: ['/a', '/b'] }, /Zalo PC not found\. Looked in: \/a, \/b\. Pass --app-path/],
    [{ kind: 'launch_failed', step: 'launch', message: 'boom' }, /Could not start or attach to Zalo PC: boom/],
    [{ kind: 'attach_failed', step: 'attach', message: 'boom' }, /Could not start or attach to Zalo PC: boom/],
    [{ kind: 'not_logged_in', step: 'login' }, /Log in to Zalo PC, then re-run/],
    [{ kind: 'shape_unrecognised', step: 'shape', detail: 'missing X', zaloVersion: '27.1' }, /version \(27\.1\) is not supported.*missing X.*needs updating/],
    [{ kind: 'account_mismatch', step: 'account', expectedUid: 'U1', actualUid: 'U2' }, /logged in as U2, but account work expects U1\. Nothing was imported/],
    [{ kind: 'account_mismatch', step: 'account', expectedUid: null, actualUid: 'U2', boundAccount: 'personal' }, /logged in as U2.*already linked to account personal, not work.*Nothing was imported/],
    [{ kind: 'uid_store_invalid', step: 'account', path: '/x/.zalo_uids.json' }, /^The Zalo account link file \/x\/\.zalo_uids\.json is corrupt\. Fix or delete it, then re-run\.$/],
    [{ kind: 'connection_lost', step: 'read', conversationsDone: 4 }, /Lost connection to Zalo PC after 4 conversations\. Re-run to continue; nothing is duplicated/],
  ]
  for (const [err, re] of cases) {
    it(err.kind + ('boundAccount' in err ? ' (bound elsewhere)' : ''), () => expect(errorMessage(err, 'work')).toMatch(re))
  }
})

function harness(result: Result<ImportSummary>, accounts: string[] = ['default'], fields: Record<string, string> = {}) {
  const out: string[] = []
  const calls: Array<{ account: string; appPath: string | null; configuredUid: string | null }> = []
  const io: CliIo = {
    out: (l) => out.push(`out:${l}`),
    err: (l) => out.push(`err:${l}`),
    listAccounts: () => accounts,
    fieldsFor: () => fields,
    openArchive: () => { out.push('archive') },
    runImport: async (opts) => {
      calls.push(opts)
      opts.reporter.info('Found 3 DM conversations.')
      return result
    },
  }
  return { io, out, calls }
}

describe('run', () => {
  it('prints the disclosure before anything else, then the summary, and exits 0', async () => {
    const h = harness({ ok: true, value: SUMMARY })
    expect(await run([], h.io)).toBe(0)
    expect(h.out[0]).toBe(`out:${DISCLOSURE}`)
    expect(DISCLOSURE).toMatch(/only history already synced.*undocumented.*restarted/is)
    expect(h.out[1]).toBe('archive')
    expect(h.out[2]).toBe('out:Found 3 DM conversations.')
    expect(h.out.at(-1)).toMatch(/3 conversations, 10 messages added, 2 already present, 1 skipped, 0 failed/)
  })

  it('passes the account, app path, and configured Zalo uid to the importer', async () => {
    const h = harness({ ok: true, value: SUMMARY }, ['default', 'work'], { ZALO_UID: '42' })
    await run(['--account', 'work', '--app-path', '/opt/Zalo.app'], h.io)
    expect(h.calls).toEqual([{ account: 'work', appPath: '/opt/Zalo.app', configuredUid: '42', reporter: expect.anything() }])
  })

  it('an empty ZALO_UID counts as not configured', async () => {
    const h = harness({ ok: true, value: SUMMARY }, ['default'], { ZALO_UID: '' })
    await run([], h.io)
    expect(h.calls[0]?.configuredUid).toBeNull()
  })

  it('exits 1 with the operator message on an error', async () => {
    const h = harness({ ok: false, error: { kind: 'not_logged_in', step: 'login' } })
    expect(await run([], h.io)).toBe(1)
    expect(h.out.at(-1)).toMatch(/^err:Zalo PC is not logged in/)
  })

  it('exits 1 after the summary when a conversation failed, listing it', async () => {
    const h = harness({ ok: true, value: { ...SUMMARY, failed: [{ name: 'An', reason: 'shape_unrecognised: x' }] } })
    expect(await run([], h.io)).toBe(1)
    expect(h.out.join('\n')).toMatch(/1 failed[\s\S]*An: shape_unrecognised: x/)
  })

  it('adds the importer-may-need-updating hint when a conversation failed on an unrecognised shape', async () => {
    const shape = harness({ ok: true, value: { ...SUMMARY, failed: [{ name: 'An', reason: 'shape_unrecognised: x' }] } })
    await run([], shape.io)
    expect(shape.out.at(-1)).toBe(`err:${SHAPE_HINT}`)
    const other = harness({ ok: true, value: { ...SUMMARY, failed: [{ name: 'An', reason: 'attach_failed: timed out' }] } })
    await run([], other.io)
    expect(other.out).not.toContain(`err:${SHAPE_HINT}`)
  })

  it('--help prints usage, exits 0, and never imports', async () => {
    const h = harness({ ok: true, value: SUMMARY })
    expect(await run(['--help'], h.io)).toBe(0)
    expect(h.out.join('\n')).toMatch(/Usage: khipu import zalo-history/)
    expect(h.calls).toEqual([])
    expect(h.out).not.toContain('archive')
  })

  it('bad args or an unresolvable account exit 1 without importing', async () => {
    const bad = harness({ ok: true, value: SUMMARY })
    expect(await run(['--bogus'], bad.io)).toBe(1)
    const ambiguous = harness({ ok: true, value: SUMMARY }, ['work', 'personal'])
    expect(await run([], ambiguous.io)).toBe(1)
    expect(bad.calls.length + ambiguous.calls.length).toBe(0)
  })
})
