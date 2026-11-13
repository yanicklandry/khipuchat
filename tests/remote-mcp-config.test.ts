import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  parseRemoteMcpConfig,
  formatConfigError,
  isLoopbackHost,
  type RemoteMcpConfig,
  type RemoteMcpConfigError,
} from '../src/remote-mcp/config'

const TOOLS = ['list_chats', 'search_messages', 'get_image'] as const
const TOKEN_A = 'a'.repeat(32)
const TOKEN_B = 'b'.repeat(40)

const digest = (t: string): Buffer => createHash('sha256').update(t).digest()

function ok(env: NodeJS.ProcessEnv): RemoteMcpConfig {
  const result = parseRemoteMcpConfig(env, TOOLS)
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.config
}

function err(env: NodeJS.ProcessEnv): RemoteMcpConfigError {
  const result = parseRemoteMcpConfig(env, TOOLS)
  if (result.ok) throw new Error('expected an error')
  return result.error
}

describe('parseRemoteMcpConfig: clients and defaults', () => {
  it('discovers a client, lowercases its name, keeps only a digest, applies defaults (2.1, 1.4, 4.1)', () => {
    const config = ok({ MCP_TOKEN_MUSE: TOKEN_A })
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3335)
    expect(config.allowedOrigins.size).toBe(0)
    expect(config.clients).toHaveLength(1)
    const [client] = config.clients
    expect(client.name).toBe('muse')
    expect(client.setting).toBe('MCP_TOKEN_MUSE')
    expect(client.tokenDigest.equals(digest(TOKEN_A))).toBe(true)
    expect(client.allowlisted).toBe(false)
    expect([...client.tools].sort()).toEqual([...TOOLS].sort())
    expect(JSON.stringify(config)).not.toContain(TOKEN_A)
    expect(Object.values(client)).not.toContain(TOKEN_A)
  })

  it('accepts digits and underscores and a 32-character suffix', () => {
    const suffix = 'A1_'.repeat(10) + 'ZZ'
    const config = ok({ [`MCP_TOKEN_${suffix}`]: TOKEN_A, MCP_TOKEN_CLAUDE_2: TOKEN_B })
    expect(config.clients.map((c) => c.name).sort()).toEqual(['claude_2', suffix.toLowerCase()].sort())
  })

  it('honors MCP_HTTP_HOST, MCP_HTTP_PORT and MCP_ALLOWED_ORIGINS (normalized)', () => {
    const config = ok({
      MCP_TOKEN_MUSE: TOKEN_A,
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_HTTP_PORT: '8080',
      MCP_ALLOWED_ORIGINS: ' https://Claude.AI/ ,https://example.com//, ',
    })
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(8080)
    expect([...config.allowedOrigins].sort()).toEqual(['https://claude.ai', 'https://example.com'])
  })

  it('MCP_SECRET alone yields no clients and is never used as a token (2.7)', () => {
    expect(err({ MCP_SECRET: TOKEN_A })).toEqual({ kind: 'no-clients' })
    const config = ok({ MCP_SECRET: TOKEN_B, MCP_TOKEN_MUSE: TOKEN_A })
    expect(config.clients).toHaveLength(1)
    expect(config.clients[0].tokenDigest.equals(digest(TOKEN_B))).toBe(false)
  })

  it('a removed token is no longer present after re-parse (2.6)', () => {
    const before = ok({ MCP_TOKEN_MUSE: TOKEN_A, MCP_TOKEN_BOT: TOKEN_B })
    expect(before.clients.some((c) => c.tokenDigest.equals(digest(TOKEN_B)))).toBe(true)
    const after = ok({ MCP_TOKEN_MUSE: TOKEN_A })
    expect(after.clients.map((c) => c.name)).toEqual(['muse'])
    expect(after.clients.some((c) => c.tokenDigest.equals(digest(TOKEN_B)))).toBe(false)
  })
})

describe('parseRemoteMcpConfig: _FILE rules (2.5)', () => {
  it('never treats a key ending in _FILE as a client', () => {
    const config = ok({ MCP_TOKEN_MUSE: TOKEN_A, MCP_TOKEN_MUSE_FILE: '/run/secrets/muse' })
    expect(config.clients.map((c) => c.name)).toEqual(['muse'])
  })

  it('reports unresolved-secret-file when the file setting exists but the value does not', () => {
    expect(err({ MCP_TOKEN_MUSE_FILE: '/run/secrets/muse' })).toEqual({
      kind: 'unresolved-secret-file',
      setting: 'MCP_TOKEN_MUSE_FILE',
    })
    expect(err({ MCP_TOKEN_BOT: TOKEN_B, MCP_TOKEN_MUSE: '', MCP_TOKEN_MUSE_FILE: '/x' })).toEqual({
      kind: 'unresolved-secret-file',
      setting: 'MCP_TOKEN_MUSE_FILE',
    })
  })
})

describe('parseRemoteMcpConfig: error kinds', () => {
  it('no-clients when nothing is configured (2.2)', () => {
    expect(err({})).toEqual({ kind: 'no-clients' })
  })

  it.each([['MCP_TOKEN_muse'], ['MCP_TOKEN_'], ['MCP_TOKEN_A-B'], [`MCP_TOKEN_${'A'.repeat(33)}`]])(
    'invalid-client-name for %s',
    (setting) => {
      expect(err({ [setting]: TOKEN_A })).toEqual({ kind: 'invalid-client-name', setting })
    },
  )

  it('token-too-short names the setting (2.3)', () => {
    expect(err({ MCP_TOKEN_MUSE: 'x'.repeat(31) })).toEqual({ kind: 'token-too-short', setting: 'MCP_TOKEN_MUSE' })
  })

  it('duplicate-token names both settings (2.4)', () => {
    expect(err({ MCP_TOKEN_MUSE: TOKEN_A, MCP_TOKEN_BOT: TOKEN_A })).toEqual({
      kind: 'duplicate-token',
      settings: ['MCP_TOKEN_BOT', 'MCP_TOKEN_MUSE'],
    })
  })

  it('empty-allowlist when set but empty (4.5)', () => {
    expect(err({ MCP_TOKEN_MUSE: TOKEN_A, MCP_TOOLS_MUSE: ' , ' })).toEqual({
      kind: 'empty-allowlist',
      setting: 'MCP_TOOLS_MUSE',
    })
    expect(err({ MCP_TOKEN_MUSE: TOKEN_A, MCP_TOOLS_MUSE: '' })).toEqual({
      kind: 'empty-allowlist',
      setting: 'MCP_TOOLS_MUSE',
    })
  })

  it('unknown-tool names the setting and the tool (4.5)', () => {
    expect(err({ MCP_TOKEN_MUSE: TOKEN_A, MCP_TOOLS_MUSE: 'list_chats, drop_db' })).toEqual({
      kind: 'unknown-tool',
      setting: 'MCP_TOOLS_MUSE',
      tool: 'drop_db',
    })
  })

  it('allowlist-without-token names the setting (4.6)', () => {
    expect(err({ MCP_TOKEN_MUSE: TOKEN_A, MCP_TOOLS_BOT: 'list_chats' })).toEqual({
      kind: 'allowlist-without-token',
      setting: 'MCP_TOOLS_BOT',
    })
  })

  it.each([['0'], ['65536'], ['abc'], ['80.5'], ['-1'], ['3335x']])('invalid-port for %s', (value) => {
    expect(err({ MCP_TOKEN_MUSE: TOKEN_A, MCP_HTTP_PORT: value })).toEqual({ kind: 'invalid-port', value })
  })

  it('accepts the port bounds', () => {
    expect(ok({ MCP_TOKEN_MUSE: TOKEN_A, MCP_HTTP_PORT: '1' }).port).toBe(1)
    expect(ok({ MCP_TOKEN_MUSE: TOKEN_A, MCP_HTTP_PORT: '65535' }).port).toBe(65535)
  })

  it('reports errors in the fixed order', () => {
    const all: NodeJS.ProcessEnv = {
      MCP_TOKEN_bad: TOKEN_A,
      MCP_TOKEN_FILEONLY_FILE: '/x',
      MCP_TOKEN_SHORT: 'short',
      MCP_TOKEN_DUP1: TOKEN_B,
      MCP_TOKEN_DUP2: TOKEN_B,
      MCP_TOOLS_DUP1: '',
      MCP_TOOLS_DUP2: 'nope',
      MCP_TOOLS_GHOST: 'list_chats',
      MCP_HTTP_PORT: '0',
    }
    const order: RemoteMcpConfigError['kind'][] = []
    const env = { ...all }
    const removeFor: Record<string, string[]> = {
      'invalid-client-name': ['MCP_TOKEN_bad'],
      'unresolved-secret-file': ['MCP_TOKEN_FILEONLY_FILE'],
      'token-too-short': ['MCP_TOKEN_SHORT'],
      'duplicate-token': ['MCP_TOKEN_DUP2', 'MCP_TOOLS_DUP2'],
      'empty-allowlist': ['MCP_TOOLS_DUP1'],
      'allowlist-without-token': ['MCP_TOOLS_GHOST'],
      'invalid-port': ['MCP_HTTP_PORT'],
    }
    for (;;) {
      const result = parseRemoteMcpConfig(env, TOOLS)
      if (result.ok) break
      order.push(result.error.kind)
      for (const key of removeFor[result.error.kind] ?? []) delete env[key]
      if (order.length > 10) break
    }
    expect(order).toEqual([
      'invalid-client-name',
      'unresolved-secret-file',
      'token-too-short',
      'duplicate-token',
      'empty-allowlist',
      'allowlist-without-token',
      'invalid-port',
    ])
  })

  it('reports unknown-tool before allowlist-without-token', () => {
    expect(
      err({ MCP_TOKEN_MUSE: TOKEN_A, MCP_TOOLS_MUSE: 'nope', MCP_TOOLS_GHOST: 'list_chats' }).kind,
    ).toBe('unknown-tool')
  })
})

describe('parseRemoteMcpConfig: allowlists (4.1, 4.2)', () => {
  it('restricts an allowlisted client to the named tools, trimming whitespace', () => {
    const config = ok({
      MCP_TOKEN_MUSE: TOKEN_A,
      MCP_TOKEN_BOT: TOKEN_B,
      MCP_TOOLS_MUSE: ' list_chats , search_messages ',
    })
    const muse = config.clients.find((c) => c.name === 'muse')
    const bot = config.clients.find((c) => c.name === 'bot')
    expect(muse?.allowlisted).toBe(true)
    expect([...(muse?.tools ?? [])].sort()).toEqual(['list_chats', 'search_messages'])
    expect(bot?.allowlisted).toBe(false)
    expect(bot?.tools.size).toBe(TOOLS.length)
  })
})

describe('formatConfigError', () => {
  const errors: RemoteMcpConfigError[] = [
    { kind: 'no-clients' },
    { kind: 'invalid-client-name', setting: 'MCP_TOKEN_muse' },
    { kind: 'unresolved-secret-file', setting: 'MCP_TOKEN_MUSE_FILE' },
    { kind: 'token-too-short', setting: 'MCP_TOKEN_MUSE' },
    { kind: 'duplicate-token', settings: ['MCP_TOKEN_A', 'MCP_TOKEN_B'] },
    { kind: 'empty-allowlist', setting: 'MCP_TOOLS_MUSE' },
    { kind: 'unknown-tool', setting: 'MCP_TOOLS_MUSE', tool: 'drop_db' },
    { kind: 'allowlist-without-token', setting: 'MCP_TOOLS_BOT' },
    { kind: 'invalid-port', value: '99999' },
  ]

  it.each(errors.map((e) => [e.kind, e]))('names the setting for %s', (_kind, error) => {
    const message = formatConfigError(error)
    expect(message.length).toBeGreaterThan(0)
    if ('setting' in error) expect(message).toContain(error.setting)
    if ('settings' in error) for (const s of error.settings) expect(message).toContain(s)
    if ('tool' in error) expect(message).toContain(error.tool)
    if (error.kind === 'invalid-port') expect(message).toContain('MCP_HTTP_PORT')
    if (error.kind === 'no-clients') expect(message).toContain('MCP_TOKEN_<CLIENT>')
  })

  it('never contains token values for errors produced from real env', () => {
    const secretShort = 'short-secret-value'
    const envs: NodeJS.ProcessEnv[] = [
      { MCP_TOKEN_MUSE: secretShort },
      { MCP_TOKEN_MUSE: TOKEN_A, MCP_TOKEN_BOT: TOKEN_A },
      { MCP_TOKEN_muse: TOKEN_A },
      { MCP_TOKEN_MUSE: TOKEN_A, MCP_TOOLS_MUSE: 'nope' },
    ]
    for (const env of envs) {
      const message = formatConfigError(err(env))
      expect(message).not.toContain(secretShort)
      expect(message).not.toContain(TOKEN_A)
    }
  })
})

describe('isLoopbackHost (1.7)', () => {
  it.each([['127.0.0.1'], ['127.1.2.3'], ['127.255.255.255'], ['::1'], ['[::1]'], ['localhost'], ['LOCALHOST']])(
    '%s is loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true)
    },
  )

  it.each([['0.0.0.0'], ['::'], ['192.168.1.10'], ['128.0.0.1'], ['127.0.0'], ['127.0.0.256'], ['example.com'], ['']])(
    '%s is not loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false)
    },
  )
})
