// Zalo PC process lifecycle on macOS: locate, quit, relaunch with a loopback
// debugging port, and relaunch normally. Every launch uses `open -g` (and `-j`
// for the debug launch) so Zalo PC never steals focus or flashes a window.
// All shell calls are injected so tests never touch the real app.
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { homedir } from 'os'
import path from 'path'
import type { CdpClient, CdpTarget } from './cdp'
import type { Result } from './types'

const BUNDLE_ID = 'com.vng.zalo'
const PROCESS_NAME = 'Zalo'
const QUIT_WAIT_S = 15
const PAGE_WAIT_S = 90
const PORT_MIN = 20_000
const PORT_SPAN = 20_000
const PORT_TRIES = 10
/** Zalo PC's main window; other Electron/Chromium apps never serve this path. */
const ZALO_PAGE = '/pc-dist/index.html'

/** True when nothing listens on 127.0.0.1:port (so Zalo PC can bind it). */
export function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

export type ExecFn = (cmd: string, args: string[]) => { status: number; stdout: string }

export interface AppControl {
  locate(): Result<{ appPath: string; version: string }>
  isRunning(): boolean
  /** shouldStop is checked before the quit and while waiting for the page (Ctrl-C). */
  ensureDebugInstance(shouldStop?: () => boolean): Promise<Result<{ port: number; restarted: boolean; target: CdpTarget }>>
  /** Never leaves Zalo PC closed silently: a failed reopen is reported. */
  relaunchNormal(): Promise<Result<true>>
}

export interface AppControlOptions {
  /** From --app-path; tried before the standard locations. */
  appPath?: string
  cdp: CdpClient
  exec?: ExecFn
  exists?: (p: string) => boolean
  home?: string
  sleep?: (ms: number) => Promise<void>
  randomPort?: () => number
  isPortFree?: (port: number) => Promise<boolean>
}

export const defaultExec: ExecFn = (cmd, args) => {
  try {
    return { status: 0, stdout: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    // On failure execFileSync sets stdout to '' and puts the real error on stderr.
    const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string }
    return { status: e.status ?? 1, stdout: e.stdout || e.stderr || e.message || '' }
  }
}

/** The main Zalo PC window; the app also exposes notification and worker pages. */
export function findPageTarget(targets: CdpTarget[]): CdpTarget | null {
  return targets.find((t) => t.type === 'page' && t.url.split('?')[0]!.endsWith(ZALO_PAGE)) ?? null
}

export function createAppControl(opts: AppControlOptions): AppControl {
  const exec = opts.exec ?? defaultExec
  const exists = opts.exists ?? existsSync
  const home = opts.home ?? homedir()
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const randomPort = opts.randomPort ?? (() => PORT_MIN + Math.floor(Math.random() * PORT_SPAN))
  const isPortFree = opts.isPortFree ?? defaultIsPortFree
  let located: string | null = null
  let cached: { appPath: string; version: string } | null = null

  async function freePort(): Promise<number | null> {
    for (let i = 0; i < PORT_TRIES; i++) {
      const port = randomPort()
      if (await isPortFree(port)) return port
    }
    return null
  }

  /** Cached once found: the bundle version is read a single time per run. */
  function locate(): Result<{ appPath: string; version: string }> {
    if (cached) return { ok: true, value: cached }
    const candidates = [
      ...(opts.appPath ? [opts.appPath] : []),
      '/Applications/Zalo.app',
      path.join(home, 'Applications', 'Zalo.app'),
    ]
    const appPath = candidates.find((p) => exists(p))
    if (!appPath) return { ok: false, error: { kind: 'not_installed', step: 'locate', searched: candidates } }
    located = appPath
    const read = exec('defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleShortVersionString'])
    cached = { appPath, version: read.status === 0 ? read.stdout.trim() : 'unknown' }
    return { ok: true, value: cached }
  }

  function isRunning(): boolean {
    return exec('pgrep', ['-x', PROCESS_NAME]).status === 0
  }

  /** Quits Zalo PC: graceful, then SIGTERM, then SIGKILL. Returns false if it is still running. */
  async function quit(): Promise<boolean> {
    if (!isRunning()) return true
    exec('osascript', ['-e', `quit app id "${BUNDLE_ID}"`])
    for (let i = 0; i < QUIT_WAIT_S && isRunning(); i++) await sleep(1000)
    for (const signal of [[], ['-9']]) {
      if (!isRunning()) break
      exec('pkill', [...signal, '-x', PROCESS_NAME])
      await sleep(2000)
    }
    if (isRunning()) return false
    await sleep(500) // let the single-instance lock release before relaunching
    return true
  }

  async function waitForPage(port: number, shouldStop: () => boolean): Promise<CdpTarget | null | 'stopped'> {
    for (let i = 0; i < PAGE_WAIT_S; i++) {
      if (shouldStop()) return 'stopped'
      await sleep(1000)
      try {
        const page = findPageTarget(await opts.cdp.listTargets(port))
        if (page) return page
      } catch {
        // debugging port not listening yet
      }
    }
    return null
  }

  return {
    locate,
    isRunning,
    async ensureDebugInstance(shouldStop = () => false) {
      const loc = locate()
      if (!loc.ok) return loc
      // Pick the port before quitting, so a failure never leaves Zalo PC closed.
      const port = await freePort()
      if (port === null) {
        return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: `no free loopback port found for debugging after ${PORT_TRIES} tries`, untouched: true } }
      }
      if (shouldStop()) return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: 'interrupted before restarting Zalo PC', untouched: true } }
      const restarted = isRunning()
      // Zalo holds a single-instance lock: flags only take effect on a fresh launch.
      if (!(await quit())) {
        return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: 'Zalo PC did not quit, so it could not be restarted in debug mode' } }
      }
      // Zalo PC is now closed; the importer's teardown reopens it normally.
      if (shouldStop()) return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: 'interrupted after quitting Zalo PC' } }
      const launched = exec('open', ['-g', '-j', '-a', loc.value.appPath, '--args', `--remote-debugging-port=${port}`])
      if (launched.status !== 0) {
        return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: launched.stdout.trim() || 'open failed' } }
      }
      const target = await waitForPage(port, shouldStop)
      if (target === 'stopped') return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: 'interrupted while waiting for Zalo PC' } }
      if (!target) {
        return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: `Zalo PC did not open its debugging port within ${PAGE_WAIT_S}s` } }
      }
      return { ok: true, value: { port, restarted, target } }
    },
    async relaunchNormal() {
      const appPath = located ?? (locate().ok ? located : null)
      if (!(await quit())) {
        return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: 'Zalo PC did not quit, so its debugging port may still be open; quit and reopen it manually' } }
      }
      // Without a known path, reopen by bundle id so Zalo PC is never left closed.
      const opened = exec('open', appPath ? ['-g', '-a', appPath] : ['-g', '-b', BUNDLE_ID])
      if (opened.status !== 0) {
        const why = opened.stdout.trim() || 'open failed'
        return { ok: false, error: { kind: 'launch_failed', step: 'launch', message: `Could not reopen Zalo PC (${why}); open it manually` } }
      }
      return { ok: true, value: true }
    },
  }
}
