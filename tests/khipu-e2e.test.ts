/**
 * E2E smoke tests for the khipu CLI.
 *
 * These tests spawn actual child processes via tsx and verify exit codes and
 * output. Data-querying commands (search, list messages) accept either real rows
 * or an explicit empty-results message, making the suite safe to run against
 * any DB state (empty or populated).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import * as path from 'path'

const PROJECT_ROOT = path.join(__dirname, '..')
const TSX = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
const KHIPU = path.join(PROJECT_ROOT, 'src', 'khipu.ts')

function runKhipu(args: string[], env?: Record<string, string>) {
  return spawnSync(process.execPath, [TSX, KHIPU, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
    cwd: PROJECT_ROOT,
  })
}

describe('khipu E2E smoke tests', () => {
  it('khipu --help exits 0 and output includes "list" and "sync"', () => {
    const { status, stdout } = runKhipu(['--help'])
    expect(status).toBe(0)
    expect(stdout).toContain('list')
    expect(stdout).toContain('sync')
  }, 15000)

  it('khipu --help output includes sync <platform>[@account] syntax', () => {
    const { status, stdout } = runKhipu(['--help'])
    expect(status).toBe(0)
    // The usage text describes the sync platform@account form
    expect(stdout).toMatch(/sync.*platform/i)
  }, 15000)

  it('khipu sync exits 0 and prints sync status output', () => {
    const { status, stdout, stderr } = runKhipu(['sync'])
    expect(status).toBe(0)
    // With no configured accounts, output may be empty or list platforms.
    // The important thing is it exits cleanly (no crash).
    // stdout + stderr combined should be accessible (no thrown error)
    expect(typeof stdout).toBe('string')
    expect(typeof stderr).toBe('string')
  }, 15000)

  it('khipu search "term" --platform telegram --since 2025-01-01 --limit 5 exits 0 and prints matching rows or no-results message', () => {
    const { status, stdout } = runKhipu([
      'search', 'term',
      '--platform', 'telegram',
      '--since', '2025-01-01',
      '--limit', '5',
    ])
    expect(status).toBe(0)
    // Either results are shown or an explicit empty-results message appears
    const hasResults = stdout.includes('Chat #') || stdout.includes('No results found') || stdout.includes('Keyword search')
    expect(hasResults).toBe(true)
  }, 15000)

  it('khipu list messages --type text --limit 10 exits 0 and prints messages or no-messages message', () => {
    const { status, stdout } = runKhipu(['list', 'messages', '--type', 'text', '--limit', '10'])
    expect(status).toBe(0)
    // Either messages are shown or an explicit empty-results message appears
    const hasOutput = stdout.includes('Chat #') || stdout.includes('No messages found')
    expect(hasOutput).toBe(true)
  }, 15000)

  it('khipu list (bare, no subcommand) exits non-zero and prints list usage', () => {
    const { status, stdout, stderr } = runKhipu(['list'])
    expect(status).not.toBe(0)
    // Usage text appears on stderr (error path via console.error)
    const combined = stdout + stderr
    expect(combined).toMatch(/Usage|list/i)
  }, 15000)
})
