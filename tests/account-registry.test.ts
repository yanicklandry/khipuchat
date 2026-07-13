import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { loadRegistry } from '../src/account-registry'

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeTmpConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khipu-reg-'))
  const file = path.join(dir, 'khipu.config.json')
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8')
  return file
}

// ── 1. Absent config file (legacy fallback) ──────────────────────────────────

describe('loadRegistry — absent config file', () => {
  it('returns default account for telegram when env vars are set', () => {
    const env = {
      TG_API_ID: '12345',
      TG_API_HASH: 'abcdef',
      TG_PHONE: '+1234567890',
    }
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    expect(reg.listAccounts('telegram')).toEqual(['default'])
  })

  it('returns credentials from env vars for the default telegram account', () => {
    const env = {
      TG_API_ID: '12345',
      TG_API_HASH: 'abc',
      TG_PHONE: '+1',
    }
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    const creds = reg.credentialsFor('telegram', 'default')
    expect(creds.name).toBe('default')
    expect(creds.fields).toEqual({
      TG_API_ID: '12345',
      TG_API_HASH: 'abc',
      TG_PHONE: '+1',
    })
  })

  it('returns empty list for telegram when no env vars are set', () => {
    const env: NodeJS.ProcessEnv = {}
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    expect(reg.listAccounts('telegram')).toEqual([])
  })

  it('returns default account for discord when DISCORD_TOKEN is set', () => {
    const env = { DISCORD_TOKEN: 'tok123' }
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    expect(reg.listAccounts('discord')).toEqual(['default'])
    const creds = reg.credentialsFor('discord', 'default')
    expect(creds.fields).toEqual({ DISCORD_TOKEN: 'tok123' })
  })

  it('returns default account for slack when SLACK_USER_TOKEN is set', () => {
    const env = { SLACK_USER_TOKEN: 'xoxp-abc' }
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    expect(reg.listAccounts('slack')).toEqual(['default'])
  })

  it('returns default account for email when EMAIL_IMAP_HOST and other vars are set', () => {
    const env = { EMAIL_IMAP_HOST: 'mail.example.com', EMAIL_IMAP_USER: 'user', EMAIL_IMAP_PASS: 'pass' }
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    expect(reg.listAccounts('email')).toEqual(['default'])
    const creds = reg.credentialsFor('email', 'default')
    expect(creds.fields).toEqual({ EMAIL_IMAP_HOST: 'mail.example.com', EMAIL_IMAP_USER: 'user', EMAIL_IMAP_PASS: 'pass' })
  })

  it('returns empty list for imessage (no env vars)', () => {
    const env: NodeJS.ProcessEnv = {}
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    // imessage uses local system, no env vars, so always returns ['default']
    expect(reg.listAccounts('imessage')).toEqual(['default'])
  })

  it('returns empty list for wechat (no env vars)', () => {
    const env: NodeJS.ProcessEnv = {}
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    // wechat uses local DB, no env vars, so always returns ['default']
    expect(reg.listAccounts('wechat')).toEqual(['default'])
  })

  it('returns empty list for whatsapp (no env vars)', () => {
    const env: NodeJS.ProcessEnv = {}
    const reg = loadRegistry('/nonexistent/khipu.config.json', env)
    // whatsapp uses local session, no env vars, so always returns ['default']
    expect(reg.listAccounts('whatsapp')).toEqual(['default'])
  })
})

// ── 2. Config file present ────────────────────────────────────────────────────

describe('loadRegistry — config file present', () => {
  it('listAccounts returns names in config-declared order', () => {
    const configPath = writeTmpConfig({
      slack: [
        { name: 'work', userToken: 'tok-work' },
        { name: 'personal', userToken: 'tok-personal' },
        { name: 'oss', userToken: 'tok-oss' },
      ],
    })
    const reg = loadRegistry(configPath, {})
    expect(reg.listAccounts('slack')).toEqual(['work', 'personal', 'oss'])
  })

  it('listAccounts returns empty array for platform not in config', () => {
    const configPath = writeTmpConfig({ slack: [{ name: 'work', userToken: 'tok' }] })
    const reg = loadRegistry(configPath, {})
    expect(reg.listAccounts('telegram')).toEqual([])
  })

  it('credentialsFor returns fields from config (raw values)', () => {
    const configPath = writeTmpConfig({
      slack: [
        { name: 'work', userToken: 'xoxp-direct' },
      ],
    })
    const reg = loadRegistry(configPath, {})
    const creds = reg.credentialsFor('slack', 'work')
    expect(creds.name).toBe('work')
    expect(creds.fields['userToken']).toBe('xoxp-direct')
  })

  it('credentialsFor resolves $VAR references using the provided env', () => {
    const configPath = writeTmpConfig({
      slack: [
        { name: 'work', userToken: '$SLACK_WORK_TOKEN' },
      ],
    })
    const env = { SLACK_WORK_TOKEN: 'xoxp-resolved' }
    const reg = loadRegistry(configPath, env)
    const creds = reg.credentialsFor('slack', 'work')
    expect(creds.fields['userToken']).toBe('xoxp-resolved')
  })

  it('telegram config with multiple accounts returns names in order', () => {
    const configPath = writeTmpConfig({
      telegram: [
        { name: 'personal', apiId: '111', apiHash: 'aaa', phoneNumber: '+1' },
        { name: 'work', apiId: '222', apiHash: 'bbb', phoneNumber: '+2' },
      ],
    })
    const reg = loadRegistry(configPath, {})
    expect(reg.listAccounts('telegram')).toEqual(['personal', 'work'])
  })

  it('empty config file results in legacy fallback for env-configured platforms', () => {
    const configPath = writeTmpConfig({})
    const env = { TG_API_ID: '1', TG_API_HASH: 'h', TG_PHONE: '+1' }
    const reg = loadRegistry(configPath, env)
    expect(reg.listAccounts('telegram')).toEqual(['default'])
  })
})

// ── 3. credentialsFor edge cases ─────────────────────────────────────────────

describe('credentialsFor', () => {
  it('throws for unknown account', () => {
    const configPath = writeTmpConfig({ slack: [{ name: 'work', userToken: 'tok' }] })
    const reg = loadRegistry(configPath, {})
    expect(() => reg.credentialsFor('slack', 'unknown')).toThrow()
  })

  it('throws for platform not in registry', () => {
    const configPath = writeTmpConfig({ slack: [{ name: 'work', userToken: 'tok' }] })
    const reg = loadRegistry(configPath, {})
    expect(() => reg.credentialsFor('discord', 'default')).toThrow()
  })
})

// ── 4. Validation errors ──────────────────────────────────────────────────────

describe('loadRegistry — validation errors', () => {
  it('throws missing_env when a $VAR field references an absent environment variable', () => {
    const configPath = writeTmpConfig({
      slack: [
        { name: 'work', userToken: '$MISSING_VAR' },
      ],
    })
    const env: NodeJS.ProcessEnv = {}
    let caught: unknown
    try {
      loadRegistry(configPath, env)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { kind: string }).kind).toBe('missing_env')
    expect((caught as { variable: string }).variable).toBe('MISSING_VAR')
    expect((caught as { account: string }).account).toBe('work')
  })

  it('throws duplicate_name when two accounts on the same platform share a name', () => {
    const configPath = writeTmpConfig({
      slack: [
        { name: 'work', userToken: 'tok-1' },
        { name: 'work', userToken: 'tok-2' },
      ],
    })
    let caught: unknown
    try {
      loadRegistry(configPath, {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { kind: string }).kind).toBe('duplicate_name')
    expect((caught as { platform: string }).platform).toBe('slack')
    expect((caught as { name: string }).name).toBe('work')
  })

  it('throws empty_name when an account entry has an empty name', () => {
    const configPath = writeTmpConfig({
      slack: [
        { name: '', userToken: 'tok' },
      ],
    })
    let caught: unknown
    try {
      loadRegistry(configPath, {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { kind: string }).kind).toBe('empty_name')
  })

  it('throws wechat_multi_account when wechat config contains more than one account', () => {
    const configPath = writeTmpConfig({
      wechat: [
        { name: 'personal' },
        { name: 'work' },
      ],
    })
    let caught: unknown
    try {
      loadRegistry(configPath, {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { kind: string }).kind).toBe('wechat_multi_account')
  })

  it('treats account names case-sensitively — Work and work are distinct, not duplicates', () => {
    const configPath = writeTmpConfig({
      slack: [
        { name: 'Work', userToken: 'tok-Work' },
        { name: 'work', userToken: 'tok-work' },
      ],
    })
    const reg = loadRegistry(configPath, {})
    expect(reg.listAccounts('slack')).toEqual(['Work', 'work'])
    expect(reg.credentialsFor('slack', 'Work').fields['userToken']).toBe('tok-Work')
    expect(reg.credentialsFor('slack', 'work').fields['userToken']).toBe('tok-work')
  })
})
