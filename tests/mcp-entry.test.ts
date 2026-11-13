import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as path from 'path'
import { main, selectMcpMode, type McpMainDeps } from '../src/mcp'

// McpEntry (Req 1.1, 1.2): `--http` routes to the remote runner, loaded on demand,
// with process env and the same archive path stdio uses; no flag keeps stdio.

const ROOT = path.join(__dirname, '..')
const STDIO_DB_PATH = path.join(ROOT, 'khipuchat.db')
const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsx')

function fakeDeps(argv: readonly string[]) {
  const runRemoteMcp = vi.fn().mockResolvedValue(0)
  const loadRunner = vi.fn().mockResolvedValue({ runRemoteMcp })
  const runStdio = vi.fn().mockResolvedValue(undefined)
  const loadEnvFile = vi.fn()
  const deps: McpMainDeps = { argv, env: { MCP_TOKEN_X: 'not-used' }, loadRunner, runStdio, loadEnvFile }
  return { deps, runRemoteMcp, loadRunner, runStdio, loadEnvFile }
}

describe('selectMcpMode', () => {
  it('is http only when --http is present', () => {
    expect(selectMcpMode(['--http'])).toBe('http')
    expect(selectMcpMode(['--verbose', '--http'])).toBe('http')
    expect(selectMcpMode([])).toBe('stdio')
    expect(selectMcpMode(['--https', 'http'])).toBe('stdio')
  })
})

describe('mcp main()', () => {
  it('--http loads the runner and passes env and the stdio archive path', async () => {
    const { deps, runRemoteMcp, loadRunner, runStdio } = fakeDeps(['--http'])
    const prev = process.exitCode
    try {
      await main(deps)
      expect(loadRunner).toHaveBeenCalledTimes(1)
      expect(runRemoteMcp).toHaveBeenCalledWith({ env: deps.env, dbPath: STDIO_DB_PATH })
      expect(runStdio).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = prev
    }
  })

  it('--http sets process.exitCode to the runner status', async () => {
    const { deps, runRemoteMcp } = fakeDeps(['--http'])
    runRemoteMcp.mockResolvedValue(1)
    const prev = process.exitCode
    try {
      await main(deps)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = prev
    }
  })

  it('without --http runs stdio with the archive path and never loads the runner', async () => {
    const { deps, loadRunner, runStdio } = fakeDeps([])
    await main(deps)
    expect(runStdio).toHaveBeenCalledWith(STDIO_DB_PATH)
    expect(loadRunner).not.toHaveBeenCalled()
  })

  it('the default stdio dbPath matches the runner path stdio uses', async () => {
    const { deps, runRemoteMcp } = fakeDeps(['--http'])
    const prev = process.exitCode
    try {
      await main(deps)
      const { deps: d2, runStdio } = fakeDeps([])
      await main(d2)
      expect(runRemoteMcp.mock.calls[0][0].dbPath).toBe(runStdio.mock.calls[0][0])
    } finally {
      process.exitCode = prev
    }
  })
})

describe('mcp main(): review fixes', () => {
  it('--http loads .env before the runner; stdio does not', async () => {
    const order: string[] = []
    const { deps, loadRunner, loadEnvFile } = fakeDeps(['--http'])
    loadEnvFile.mockImplementation(() => order.push('env'))
    loadRunner.mockImplementation(async () => {
      order.push('runner')
      return { runRemoteMcp: vi.fn().mockResolvedValue(0) }
    })
    const prev = process.exitCode
    try {
      await main(deps)
      expect(order).toEqual(['env', 'runner'])
      const stdio = fakeDeps([])
      await main(stdio.deps)
      expect(stdio.loadEnvFile).not.toHaveBeenCalled()
    } finally {
      process.exitCode = prev
    }
  })

  it.each([['--htp'], ['--http=1'], ['--http', '--port']])('rejects unknown argument %s with exit 2', async (...argv) => {
    const { deps, loadRunner, runStdio } = fakeDeps(argv)
    const prev = process.exitCode
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await main(deps)
      expect(process.exitCode).toBe(2)
      expect(loadRunner).not.toHaveBeenCalled()
      expect(runStdio).not.toHaveBeenCalled()
      expect(String(write.mock.calls[0][0])).toContain('Usage: khipu mcp [--http]')
    } finally {
      write.mockRestore()
      process.exitCode = prev
    }
  })
})

describe('mcp.ts module graph', () => {
  it('importing src/mcp.ts loads neither src/remote-mcp nor express', () => {
    const probe =
      "require('./src/mcp'); const ks = Object.keys(require.cache);" +
      " console.log(JSON.stringify(ks.filter((k) => /remote-mcp|node_modules[\\\\/]express[\\\\/]/.test(k))))"
    const out = execFileSync(TSX_BIN, ['-e', probe], { cwd: ROOT, encoding: 'utf8' })
    expect(JSON.parse(out.trim())).toEqual([])
  })
})
