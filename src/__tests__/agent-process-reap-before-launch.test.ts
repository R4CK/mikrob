// Card d4902522 (RedHat delta, comment 27363, KC4): the dashboard's own agent-launch path
// (startAgentProcess / startWorkerSession) could silently create a SECOND tmux server on an
// orphaned-then-replaced default socket, launching a full duplicate agent set -- the same
// incident shape as the 08:20 channels restart, just triggered from reconcileDesiredAgents()
// instead. reapOrphanedLocalTmuxServerBeforeLaunch() (agent-process.ts) closes this by shelling
// out to channels.sh's own (now socket-scoped) reap pass right before every local `new-session`.
//
// This test exercises the REAL exported function against REAL scratch tmux servers (never the
// live default socket): it proves the TS call site actually reaches and triggers the shell reap,
// not just that the shell reap works in isolation (already covered by
// scripts/__tests__/channels-orphaned-tmux-reap.test.sh).
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapOrphanedLocalTmuxServerBeforeLaunch } from '../web/agent-process.js'

function tmuxPid(tmuxTmpdir: string): string {
  return execFileSync('tmux', ['display-message', '-p', '#{pid}'], {
    encoding: 'utf-8',
    env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir, TMUX: '' },
  }).trim()
}

function alive(pid: string): boolean {
  try {
    execFileSync('kill', ['-0', pid], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('reapOrphanedLocalTmuxServerBeforeLaunch (card d4902522 KC4)', () => {
  let tmpd: string | null = null
  let pidA: string | null = null
  let pidB: string | null = null

  afterEach(() => {
    for (const pid of [pidA, pidB]) {
      if (pid) try { execFileSync('kill', ['-KILL', pid], { stdio: 'ignore' }) } catch { /* already gone */ }
    }
    pidA = pidB = null
    if (tmpd) { try { rmSync(tmpd, { recursive: true, force: true }) } catch { /* best-effort */ } tmpd = null }
  })

  it('reaps an orphaned server on the exact default socket this process is about to launch into, before new-session runs', () => {
    tmpd = mkdtempSync(join(tmpdir(), 'reap-before-launch-'))
    const defaultSock = join(tmpd, `tmux-${process.getuid?.() ?? 0}`, 'default')

    execFileSync('tmux', ['new-session', '-d', '-s', 'orphan-session', 'sleep', '60'], {
      env: { ...process.env, TMUX_TMPDIR: tmpd, TMUX: '' },
    })
    pidA = tmuxPid(tmpd)
    expect(pidA, 'server A must have started').toBeTruthy()

    // Orphan A exactly as the incident measured: socket directory entry gone, process alive.
    rmSync(defaultSock, { force: true })
    expect(alive(pidA), 'server A survives socket removal').toBe(true)

    execFileSync('tmux', ['new-session', '-d', '-s', 'orphan-session', 'sleep', '60'], {
      env: { ...process.env, TMUX_TMPDIR: tmpd, TMUX: '' },
    })
    pidB = tmuxPid(tmpd)
    expect(pidB, 'server B must be a distinct, reachable server').toBeTruthy()
    expect(pidB).not.toBe(pidA)

    const prevTmpdir = process.env.TMUX_TMPDIR
    const prevTmux = process.env.TMUX
    process.env.TMUX_TMPDIR = tmpd
    delete process.env.TMUX
    try {
      reapOrphanedLocalTmuxServerBeforeLaunch({ host: null, runAsUser: null })
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prevTmpdir
      if (prevTmux !== undefined) process.env.TMUX = prevTmux
    }

    expect(alive(pidA), 'orphaned server A is killed by the TS call').toBe(false)
    expect(alive(pidB), 'live server B is untouched').toBe(true)
  })

  it('is a no-op for a remote or runAsUser target (reap only ever applies to this process\'s own uid/socket)', () => {
    // No TMUX_TMPDIR override, no real orphan set up -- if this did anything other than return
    // early, it would run channels.sh against the real environment during a test run.
    expect(() => reapOrphanedLocalTmuxServerBeforeLaunch({ host: 'some-remote-host', runAsUser: null })).not.toThrow()
    expect(() => reapOrphanedLocalTmuxServerBeforeLaunch({ host: null, runAsUser: 'some-other-user' })).not.toThrow()
  })
})
