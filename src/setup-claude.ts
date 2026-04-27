import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'

const CLAUDE_CONFIG_PATH = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Claude', 'claude_desktop_config.json',
)

const PROJECT_ROOT = path.join(__dirname, '..')
const MCP_SCRIPT = path.join(__dirname, 'mcp.ts')
const TSX_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')

// Use the exact Node binary currently running — avoids nvm PATH ordering issues
const MCP_ENTRY = {
  command: process.execPath,
  args: [TSX_BIN, MCP_SCRIPT],
}

export function isClaudeConfigured(): boolean {
  if (!fs.existsSync(CLAUDE_CONFIG_PATH)) return false
  try {
    const raw = fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf8')
    const cfg = JSON.parse(raw) as Record<string, unknown>
    const servers = cfg['mcpServers'] as Record<string, unknown> | undefined
    return servers !== undefined && 'telegram-bridge' in servers
  } catch {
    return false
  }
}

function smokeTest(): Promise<boolean> {
  console.log('Testing MCP server starts correctly…')
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_BIN, MCP_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
    const errors: string[] = []
    let done = false

    proc.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n')
      for (const line of lines) {
        if (line.includes('Error') || line.includes('SyntaxError')) errors.push(line)
      }
    })

    // If it crashes before the timer fires, report the error
    proc.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (errors.length > 0) {
        console.error(`  Server error:\n${errors.join('\n')}`)
      } else {
        console.error(`  Server exited unexpectedly (code ${code})`)
      }
      resolve(false)
    })

    // Still alive after 2s = started successfully
    const timer = setTimeout(() => {
      done = true
      proc.kill()
      console.log('  OK')
      resolve(true)
    }, 2000)
  })
}

async function setupClaude(): Promise<void> {
  if (!await smokeTest()) {
    console.error('\nAborting — fix the error above before configuring Claude Desktop.')
    process.exit(1)
  }

  const configDir = path.dirname(CLAUDE_CONFIG_PATH)
  if (!fs.existsSync(configDir)) {
    console.error(`Claude Desktop config directory not found: ${configDir}`)
    console.error('Make sure Claude Desktop is installed.')
    process.exit(1)
  }

  let cfg: Record<string, unknown> = {}
  if (fs.existsSync(CLAUDE_CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf8')) as Record<string, unknown>
    } catch {
      console.error('Could not parse existing claude_desktop_config.json — aborting.')
      process.exit(1)
    }
  }

  const servers = (cfg['mcpServers'] ?? {}) as Record<string, unknown>
  const alreadyExists = 'telegram-bridge' in servers

  servers['telegram-bridge'] = MCP_ENTRY
  cfg['mcpServers'] = servers

  fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')

  console.log(alreadyExists ? '\ntelegram-bridge config updated.' : '\nDone! telegram-bridge added to Claude Desktop.')
  console.log(`Config: ${CLAUDE_CONFIG_PATH}`)
  console.log(`Node:   ${process.execPath}`)
  console.log('')
  console.log('Restart Claude Desktop, then ask:')
  console.log('  "Use telegram-bridge to find chat Tony Lin and show me the last 20 messages"')
}

if (require.main === module) {
  setupClaude().catch((err: unknown) => { console.error(err); process.exit(1) })
}
