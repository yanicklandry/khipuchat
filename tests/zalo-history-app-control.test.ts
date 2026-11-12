import { describe, it, expect } from 'vitest'
import { createAppControl, findPageTarget, defaultExec, type ExecFn } from '../src/platforms/zalo/history/app-control'
import type { CdpClient, CdpTarget } from '../src/platforms/zalo/history/cdp'

const APP = '/Applications/Zalo.app'
const PAGE: CdpTarget = {
  id: 'p', type: 'page',
  url: 'file:///Applications/Zalo.app/Contents/Resources/app.asar/pc-dist/index.html',
  webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/p',
}
const NOTIF: CdpTarget = { ...PAGE, id: 'n', url: PAGE.url.replace('index.html', 'znotification.html') }

interface World {
  running: boolean
  /** How many pgrep calls still report running after a quit was sent (simulates slow exit). */
  exitAfterPolls: number
  quitWorks: boolean
  /** pkill with these args actually stops the process ('-x' = SIGTERM, '-9' = SIGKILL, 'none'). */
  killWorksWith: 'term' | 'kill' | 'none'
  reopenFails: boolean
  openFails: boolean
  pageAfterPolls: number
  installed: Set<string>
}

function setup(over: Partial<World> = {}, appPath?: string) {
  const w: World = {
    running: false, exitAfterPolls: 0, quitWorks: true, killWorksWith: 'term', reopenFails: false, openFails: false, pageAfterPolls: 0,
    installed: new Set([APP]), ...over,
  }
  const calls: string[] = []
  let quitSent = false
  let polls = 0
  let targetPolls = 0
  const exec: ExecFn = (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    if (cmd === 'defaults') return { status: 0, stdout: '26.11.10\n' }
    if (cmd === 'pgrep') {
      if (quitSent && w.quitWorks && polls++ >= w.exitAfterPolls) w.running = false
      return { status: w.running ? 0 : 1, stdout: '' }
    }
    if (cmd === 'osascript') { quitSent = true; return { status: 0, stdout: '' } }
    if (cmd === 'pkill') {
      const isKill = args.includes('-9')
      if (w.killWorksWith === 'term' || (w.killWorksWith === 'kill' && isKill)) w.running = false
      return { status: 0, stdout: '' }
    }
    if (cmd === 'open') {
      if (w.openFails && args.includes('-j')) return { status: 1, stdout: 'LSOpenURLsWithRole() failed' }
      if (w.reopenFails && !args.includes('-j')) return { status: 1, stdout: 'Unable to find application' }
      quitSent = false
      w.running = true
      return { status: 0, stdout: '' }
    }
    throw new Error(`unexpected ${line}`)
  }
  const cdp: CdpClient = {
    listTargets: async () => {
      if (targetPolls++ < w.pageAfterPolls) throw new Error('ECONNREFUSED')
      return [NOTIF, PAGE]
    },
    version: async () => ({ browser: 'Chrome/108' }),
    connect: async () => { throw new Error('not used') },
  }
  let slept = 0
  const ctl = createAppControl({
    appPath, exec, cdp, home: '/Users/me',
    exists: (p) => w.installed.has(p),
    sleep: async (ms) => { slept += ms },
    randomPort: () => 31337,
  })
  return { ctl, calls, w, sleptMs: () => slept }
}

describe('locate', () => {
  it('finds /Applications/Zalo.app and reads its version', () => {
    expect(setup().ctl.locate()).toEqual({ ok: true, value: { appPath: APP, version: '26.11.10' } })
  })

  it('prefers an operator-supplied path, then falls back to ~/Applications', () => {
    expect(setup({ installed: new Set(['/opt/Zalo.app', APP]) }, '/opt/Zalo.app').ctl.locate())
      .toMatchObject({ ok: true, value: { appPath: '/opt/Zalo.app' } })
    expect(setup({ installed: new Set(['/Users/me/Applications/Zalo.app']) }).ctl.locate())
      .toMatchObject({ ok: true, value: { appPath: '/Users/me/Applications/Zalo.app' } })
  })

  it('reports every path searched when Zalo PC is missing', () => {
    expect(setup({ installed: new Set() }, '/opt/Zalo.app').ctl.locate()).toEqual({
      ok: false,
      error: { kind: 'not_installed', step: 'locate', searched: ['/opt/Zalo.app', APP, '/Users/me/Applications/Zalo.app'] },
    })
  })
})

describe('ensureDebugInstance', () => {
  it('not running: launches hidden in the background with a loopback debug port, no quit', async () => {
    const { ctl, calls } = setup()
    expect(await ctl.ensureDebugInstance()).toEqual({ ok: true, value: { port: 31337, restarted: false, target: PAGE } })
    expect(calls).not.toContainEqual(expect.stringMatching(/^osascript/))
    expect(calls).toContain(`open -g -j -a ${APP} --args --remote-debugging-port=31337`)
  })

  it('running: quits gracefully by bundle id, then launches, and reports the restart', async () => {
    const { ctl, calls } = setup({ running: true, exitAfterPolls: 2 })
    expect(await ctl.ensureDebugInstance()).toMatchObject({ ok: true, value: { restarted: true } })
    const quit = calls.indexOf(`osascript -e quit app id "com.vng.zalo"`)
    const open = calls.findIndex((c) => c.startsWith('open -g -j'))
    expect(quit).toBeGreaterThanOrEqual(0)
    expect(open).toBeGreaterThan(quit)
    expect(calls).not.toContainEqual(expect.stringMatching(/^pkill/))
  })

  it('force-stops only after the graceful-quit timeout', async () => {
    const { ctl, calls, sleptMs } = setup({ running: true, quitWorks: false })
    expect(await ctl.ensureDebugInstance()).toMatchObject({ ok: true })
    expect(calls).toContain('pkill -x Zalo')
    expect(sleptMs()).toBeGreaterThanOrEqual(15_000)
  })

  it('waits for the index.html page target to appear', async () => {
    const { ctl } = setup({ pageAfterPolls: 5 })
    expect(await ctl.ensureDebugInstance()).toMatchObject({ ok: true, value: { target: PAGE } })
  })

  it('launch_failed when open fails, keeping the real error text', async () => {
    expect(await setup({ openFails: true }).ctl.ensureDebugInstance())
      .toMatchObject({ ok: false, error: { kind: 'launch_failed', step: 'launch', message: 'LSOpenURLsWithRole() failed' } })
  })

  it('escalates to SIGKILL when SIGTERM does not stop Zalo PC', async () => {
    const { ctl, calls } = setup({ running: true, quitWorks: false, killWorksWith: 'kill' })
    expect(await ctl.ensureDebugInstance()).toMatchObject({ ok: true })
    expect(calls).toContain('pkill -9 -x Zalo')
  })

  it('launch_failed, without launching, when Zalo PC cannot be stopped at all', async () => {
    const { ctl, calls } = setup({ running: true, quitWorks: false, killWorksWith: 'none' })
    expect(await ctl.ensureDebugInstance())
      .toMatchObject({ ok: false, error: { kind: 'launch_failed', message: expect.stringMatching(/did not quit/) } })
    expect(calls).not.toContainEqual(expect.stringMatching(/^open/))
  })

  it('launch_failed when the page target never appears', async () => {
    expect(await setup({ pageAfterPolls: 1_000 }).ctl.ensureDebugInstance())
      .toMatchObject({ ok: false, error: { kind: 'launch_failed', message: expect.stringMatching(/90s/) } })
  })

  it('not_installed passes through', async () => {
    expect(await setup({ installed: new Set() }).ctl.ensureDebugInstance())
      .toMatchObject({ ok: false, error: { kind: 'not_installed' } })
  })
})

describe('relaunchNormal', () => {
  it('quits the debug instance and reopens in the background without flags', async () => {
    const { ctl, calls } = setup()
    await ctl.ensureDebugInstance()
    calls.length = 0
    await ctl.relaunchNormal()
    expect(calls).toContain(`osascript -e quit app id "com.vng.zalo"`)
    expect(calls[calls.length - 1]).toBe(`open -g -a ${APP}`)
    expect(calls.join('\n')).not.toMatch(/remote-debugging/)
  })

  it('reopens even when Zalo PC is not running', async () => {
    const { ctl, calls } = setup()
    expect(await ctl.relaunchNormal()).toEqual({ ok: true, value: true })
    expect(calls[calls.length - 1]).toBe(`open -g -a ${APP}`)
  })

  it('reopens by bundle id when the app path is unknown, so Zalo is never left closed', async () => {
    const { ctl, calls } = setup({ installed: new Set(), running: true })
    expect(await ctl.relaunchNormal()).toEqual({ ok: true, value: true })
    expect(calls[calls.length - 1]).toBe('open -g -b com.vng.zalo')
  })

  it('reports when the debug instance will not quit, instead of reopening onto it', async () => {
    const { ctl, calls } = setup({ running: true, quitWorks: false, killWorksWith: 'none' })
    expect(await ctl.relaunchNormal()).toMatchObject({ ok: false, error: { message: expect.stringMatching(/did not quit/) } })
    expect(calls).not.toContainEqual(expect.stringMatching(/^open/))
  })

  it('reports a failed reopen instead of failing silently', async () => {
    expect(await setup({ reopenFails: true }).ctl.relaunchNormal()).toMatchObject({
      ok: false, error: { kind: 'launch_failed', message: expect.stringMatching(/Unable to find application.*open it manually/) },
    })
  })
})

describe('defaultExec', () => {
  it('returns the stderr text of a failing command', () => {
    const r = defaultExec('ls', ['/definitely-not-here-khipu'])
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/No such file/)
  })
})

describe('findPageTarget', () => {
  it('picks the main window page, not notification/worker pages', () => {
    expect(findPageTarget([NOTIF, PAGE])).toBe(PAGE)
    expect(findPageTarget([NOTIF, { ...PAGE, type: 'service_worker' }])).toBeNull()
  })
})
