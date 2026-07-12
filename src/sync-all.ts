import { spawn } from 'child_process'
import * as path from 'path'

export const PLATFORMS = ['telegram', 'imessage', 'wechat', 'discord', 'slack', 'email', 'whatsapp'] as const

const PROJECT_ROOT = path.join(__dirname, '..')
const TSX_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')

/**
 * Spawn each platform sync script serially.
 * Forwards `--force` and `--backfill` from argv to every child.
 * Appends `--backfill-only` to the telegram child so it exits after sync.
 * Returns `true` if any child exited non-zero, `false` otherwise.
 */
export async function runAllPlatforms(argv: readonly string[]): Promise<boolean> {
  const forwarded = argv.filter(a => a === '--force' || a === '--backfill')

  let anyFailed = false

  for (const platform of PLATFORMS) {
    const script = path.join('src', 'platforms', platform, 'sync.ts')
    const extraArgs = platform === 'telegram' ? ['--backfill-only'] : []
    const args = [TSX_BIN, script, ...forwarded, ...extraArgs]

    const exitCode = await spawnChild(args)

    if (exitCode !== 0) {
      console.error(`[sync-all] ${platform} failed with exit code ${exitCode}`)
      anyFailed = true
    }
  }

  return anyFailed
}

function spawnChild(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

if (require.main === module) {
  void runAllPlatforms(process.argv.slice(2)).then((anyFailed) => {
    process.exit(anyFailed ? 1 : 0)
  })
}
