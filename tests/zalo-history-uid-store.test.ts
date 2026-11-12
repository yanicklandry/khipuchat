import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createUidStore } from '../src/platforms/zalo/history/uid-store'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'zalo-uids-'))
  file = path.join(dir, '.zalo_uids.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('checkBinding', () => {
  it('first run when nothing is bound and no uid is configured', () => {
    expect(createUidStore(file).checkBinding('default', 'U1', null)).toEqual({ ok: true, value: { firstRun: true } })
  })

  it('a configured uid wins over the file and is compared to the logged-in uid', () => {
    writeFileSync(file, JSON.stringify({ default: 'U-OTHER' }))
    const s = createUidStore(file)
    expect(s.checkBinding('default', 'U1', 'U1')).toEqual({ ok: true, value: { firstRun: false } })
    expect(s.checkBinding('default', 'U2', 'U1')).toEqual({
      ok: false, error: { kind: 'account_mismatch', step: 'account', expectedUid: 'U1', actualUid: 'U2' },
    })
  })

  it('a configured uid that is already linked to another account is a mismatch naming that account', () => {
    writeFileSync(file, JSON.stringify({ default: 'U1' }))
    expect(createUidStore(file).checkBinding('work', 'U1', 'U1')).toEqual({
      ok: false,
      error: { kind: 'account_mismatch', step: 'account', expectedUid: null, actualUid: 'U1', boundAccount: 'default' },
    })
  })

  it('a configured uid still refuses a corrupt link file', () => {
    writeFileSync(file, '{broken')
    expect(createUidStore(file).checkBinding('default', 'U1', 'U1')).toMatchObject({ ok: false, error: { kind: 'uid_store_invalid' } })
  })

  it('bound account: same uid passes, a different uid is a mismatch', () => {
    writeFileSync(file, JSON.stringify({ work: 'U1' }))
    const s = createUidStore(file)
    expect(s.checkBinding('work', 'U1', null)).toEqual({ ok: true, value: { firstRun: false } })
    expect(s.checkBinding('work', 'U9', null)).toMatchObject({
      ok: false, error: { kind: 'account_mismatch', expectedUid: 'U1', actualUid: 'U9' },
    })
  })

  it('a uid already bound to another account is a mismatch naming that account', () => {
    writeFileSync(file, JSON.stringify({ personal: 'U1' }))
    expect(createUidStore(file).checkBinding('work', 'U1', null)).toEqual({
      ok: false,
      error: { kind: 'account_mismatch', step: 'account', expectedUid: null, actualUid: 'U1', boundAccount: 'personal' },
    })
  })

  it('a malformed file stops with uid_store_invalid naming the file', () => {
    writeFileSync(file, '{not json')
    expect(createUidStore(file).checkBinding('default', 'U1', null)).toEqual({
      ok: false, error: { kind: 'uid_store_invalid', step: 'account', path: file },
    })
    writeFileSync(file, JSON.stringify({ default: 42 }))
    expect(createUidStore(file).checkBinding('default', 'U1', null)).toMatchObject({ ok: false, error: { kind: 'uid_store_invalid' } })
    writeFileSync(file, JSON.stringify(['U1']))
    expect(createUidStore(file).checkBinding('default', 'U1', null)).toMatchObject({ ok: false, error: { kind: 'uid_store_invalid' } })
  })
})

describe('bind', () => {
  it('first run then bind: later runs are checked against the binding', () => {
    const s = createUidStore(file)
    expect(s.bind('default', 'U1')).toEqual({ ok: true, value: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ default: 'U1' })
    expect(s.checkBinding('default', 'U1', null)).toEqual({ ok: true, value: { firstRun: false } })
    expect(s.checkBinding('default', 'U2', null)).toMatchObject({ ok: false, error: { kind: 'account_mismatch' } })
  })

  it('keeps other accounts when adding one', () => {
    writeFileSync(file, JSON.stringify({ personal: 'U1' }))
    createUidStore(file).bind('work', 'U2')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ personal: 'U1', work: 'U2' })
  })

  it('writes atomically (no temp file left) with owner-only permissions', () => {
    createUidStore(file).bind('default', 'U1')
    expect(readdirSync(dir)).toEqual(['.zalo_uids.json'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('refuses to overwrite a malformed file', () => {
    writeFileSync(file, '{not json')
    expect(createUidStore(file).bind('default', 'U1')).toMatchObject({ ok: false, error: { kind: 'uid_store_invalid' } })
    expect(readFileSync(file, 'utf8')).toBe('{not json')
  })
})

describe('gitignore', () => {
  it('.zalo_uids.json is listed in .gitignore', () => {
    const lines = readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
    expect(lines).toContain('.zalo_uids.json')
  })
})
