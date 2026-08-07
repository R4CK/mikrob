// Guard: children started from the event loop must be non-blocking AND actually reapable (card 89d0bfde).
//
// Two separate properties, both learned the hard way:
//   1. A synchronous child freezes the whole event loop. In a scheduled task that was a 60s dashboard
//      outage (card 955f014e); in an HTTP route handler it is worse -- one inbound request triggers it.
//   2. Node's `timeout` option SIGTERMs only the process it spawned. Bash EXECs a *simple* command, so
//      the signal lands on the real work -- but a pipeline, a redirection, or a script that spawns its
//      own children makes bash fork, and the grandchildren are orphaned while the caller is told
//      "timeout". Work then accumulates invisibly. `killSignal: 'SIGKILL'` does not help: it changes
//      the signal, not the recipient. The fix is a process GROUP kill.
// `git fetch` (the call this card is really about) has exactly that shape -- it spawns ssh /
// git-remote-https -- so the group kill is the point, not a nicety.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { execFileAsync } from '../web/exec-async.js'

/** How many processes match this exact marker right now. */
function countMatching(marker: string): number {
  try {
    const out = execFileSync('pgrep', ['-fc', marker], { encoding: 'utf-8' }).trim()
    return Number.parseInt(out, 10) || 0
  } catch {
    return 0 // pgrep exits non-zero when nothing matches
  }
}

describe('execFileAsync (card 89d0bfde)', () => {
  it('does not block the event loop while the child runs', async () => {
    let ticks = 0
    const probe = setInterval(() => { ticks++ }, 10)
    try {
      const started = Date.now()
      const r = await execFileAsync('/bin/bash', ['-lc', 'sleep 0.4'], { timeoutMs: 5_000 })
      expect(r.status).toBe(0)
      expect(Date.now() - started).toBeGreaterThanOrEqual(350)
      expect(ticks).toBeGreaterThan(5) // a synchronous child would yield 0
    } finally {
      clearInterval(probe)
    }
  })

  // THE point of the group kill. With a plain `timeout` option this test leaves an orphan behind.
  it('kills backgrounded grandchildren, not just the direct child', async () => {
    const marker = 'sleep 41.7' // unusual duration so pgrep cannot match anything else
    try {
      expect(countMatching(marker), 'stale process from an earlier run').toBe(0)
      const r = await execFileAsync('/bin/bash', ['-lc', `( ${marker} & echo started; wait )`], { timeoutMs: 600 })
      expect(r.timedOut).toBe(true)
      await new Promise((res) => setTimeout(res, 300)) // let the kill land
      expect(countMatching(marker), 'grandchild survived the timeout -- only the direct child was signalled').toBe(0)
    } finally {
      // A FAILING run is exactly the run that leaks an orphan, and that orphan would then
      // trip the precondition of the next run with a misleading message. Clean up here so
      // each run's verdict is about its own behaviour.
      try { execFileSync('pkill', ['-f', marker]) } catch { /* nothing to kill */ }
    }
  })

  it('reports a normal non-zero exit as a status, not as a timeout', async () => {
    const r = await execFileAsync('/bin/bash', ['-lc', 'exit 3'], { timeoutMs: 5_000 })
    expect(r.status).toBe(3)
    expect(r.timedOut).toBe(false)
  })

  it('captures stdout and stderr separately', async () => {
    const r = await execFileAsync('/bin/bash', ['-lc', 'echo out; echo err >&2'], { timeoutMs: 5_000 })
    expect(r.stdout).toContain('out')
    expect(r.stderr).toContain('err')
  })

  it('resolves instead of throwing when the binary does not exist', async () => {
    const r = await execFileAsync('/nonexistent/binary', [], { timeoutMs: 2_000 })
    expect(r.status).toBeNull()
    expect(r.timedOut).toBe(false)
  })

  it('passes arguments as argv, so a value can never reach a shell', async () => {
    // `$(touch /tmp/pwned)` stays literal text: proof the helper never builds a shell string
    const r = await execFileAsync('/bin/echo', ['$(touch /tmp/exec-async-pwned)'], { timeoutMs: 5_000 })
    expect(r.stdout).toContain('$(touch /tmp/exec-async-pwned)')
  })
})
