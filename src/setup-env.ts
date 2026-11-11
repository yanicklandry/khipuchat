import * as path from 'path'
import { spawn } from 'child_process'

// Thin wrapper: bridges `khipu setup-env` to the bash engine. No exported API — CLI entrypoint
// only. Performs no .env I/O itself; scripts/setup-env.sh owns the table, prompts, and merge.

const PROJECT_ROOT = path.join(__dirname, '..')
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'setup-env.sh')

const child = spawn('/bin/bash', [SCRIPT_PATH], { stdio: 'inherit', cwd: PROJECT_ROOT })

child.on('close', (code) => {
  process.exit(code ?? 1)
})
