import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'

const LABEL = 'com.khipuchat.sync'
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'khipuchat-sync.log')

const PROJECT_ROOT = path.join(__dirname, '..')
const TSX_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
const SYNC_SCRIPT = path.join(__dirname, 'sync.ts')

function buildPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${TSX_BIN}</string>
    <string>${SYNC_SCRIPT}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`
}

function isLoaded(): boolean {
  try {
    const out = execSync('launchctl list', { encoding: 'utf8' })
    return out.includes(LABEL)
  } catch {
    return false
  }
}

function setupSync(): void {
  const launchAgentsDir = path.dirname(PLIST_PATH)
  if (!fs.existsSync(launchAgentsDir)) {
    console.error(`LaunchAgents directory not found: ${launchAgentsDir}`)
    process.exit(1)
  }

  // Unload existing job before overwriting
  if (isLoaded()) {
    console.log('Unloading existing job…')
    try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'inherit' }) } catch { /* ignore */ }
  }

  fs.writeFileSync(PLIST_PATH, buildPlist(), 'utf8')
  console.log(`Wrote: ${PLIST_PATH}`)
  console.log(`Node:  ${process.execPath}`)

  execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'inherit' })
  console.log('\nSync daemon installed and started.')
  console.log(`Logs: tail -f ${LOG_PATH}`)
}

if (require.main === module) {
  setupSync()
}
