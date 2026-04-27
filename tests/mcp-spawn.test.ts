/**
 * Integration test: spawns the MCP server exactly as Claude Desktop would
 * (same node binary, same tsx binary, same args) and exercises the protocol
 * over stdio to verify stdout is always valid JSON.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import * as path from 'path'

const PROJECT_ROOT = path.join(__dirname, '..')
const TSX_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
const MCP_SCRIPT = path.join(PROJECT_ROOT, 'src', 'mcp.ts')
// Same node binary that will be written to claude_desktop_config.json
const NODE_BIN = process.execPath

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Spawn the MCP server, send one or more newline-delimited JSON messages,
 * and collect exactly `expectLines` lines of stdout output.
 */
function mcpExchange(
  messages: object[],
  expectLines: number,
  timeoutMs = 8000,
): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [TSX_BIN, MCP_SCRIPT], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    const stdoutLines: object[] = []
    let done = false

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const parts = stdoutBuf.split('\n')
      stdoutBuf = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        let parsed: object
        try {
          parsed = JSON.parse(line) as object
        } catch {
          done = true
          clearTimeout(timer)
          proc.kill()
          reject(new Error(`Non-JSON on stdout: ${line}`))
          return
        }
        stdoutLines.push(parsed)
        if (stdoutLines.length >= expectLines) {
          done = true
          clearTimeout(timer)
          proc.kill()
          resolve(stdoutLines)
        }
      }
    })

    proc.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`Process exited early (code ${code})`))
    })

    const timer = setTimeout(() => {
      if (done) return
      done = true
      proc.kill()
      reject(new Error(`Timeout after ${timeoutMs}ms — got ${stdoutLines.length}/${expectLines} lines`))
    }, timeoutMs)

    for (const msg of messages) {
      proc.stdin.write(JSON.stringify(msg) + '\n')
    }
    proc.stdin.end()
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const INIT_MSG = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0' },
  },
}

const LIST_TOOLS_MSG = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
}

describe('MCP server (spawned as Claude Desktop)', () => {
  it('responds to initialize with valid JSON containing server info', async () => {
    const [response] = await mcpExchange([INIT_MSG], 1)
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: { name: 'khipuchat' },
        protocolVersion: '2024-11-05',
      },
    })
  }, 10000)

  it('stdout contains only valid JSON — no setup or debug text', async () => {
    // If any non-JSON line reaches stdout, mcpExchange rejects with an error
    await expect(mcpExchange([INIT_MSG], 1)).resolves.toBeDefined()
  }, 10000)

  it('lists all 4 expected tools', async () => {
    const [, toolsResponse] = await mcpExchange([INIT_MSG, LIST_TOOLS_MSG], 2)
    const resp = toolsResponse as { result?: { tools?: Array<{ name: string }> } }
    const names = resp.result?.tools?.map(t => t.name) ?? []
    expect(names).toContain('find_chat_by_name')
    expect(names).toContain('list_messages')
    expect(names).toContain('search_messages')
    expect(names).toContain('get_chat_summary')
  }, 10000)
})
