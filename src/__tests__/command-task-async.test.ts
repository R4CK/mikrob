// Guard: a type='command' scheduled task must never block the Node event loop (cards c091f6c2 / 955f014e).
//
// runCommand() used child_process.spawnSync on the main thread, which freezes the ENTIRE event loop --
// HTTP server included -- until the child exits. One command task (context-compact-dry) runs a script
// that curls this very dashboard to refresh token usage before reading it, so that request could never
// be served while the loop sat inside spawnSync: a guaranteed self-deadlock for the child's whole curl
// budget. Live evidence 2026-08-07: dashboard.log silent 09:00:05.247 -> 09:01:05.342 (60.1s, exactly
// the script's `curl -m 60`), and the line that broke the silence was this task's own "command task ran".
//
// The primary test is behavioural: run a real slow child and prove timers still fire while it runs.
// Under spawnSync the probe cannot tick at all, so a revert fails here rather than in a source grep.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommandTask } from '../web/command-task.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(REPO, 'src', 'web', 'command-task.ts'), 'utf-8')

describe('command task does not block the event loop (card 955f014e)', () => {
  it('lets timers keep firing while the child runs', async () => {
    let ticks = 0
    const probe = setInterval(() => { ticks++ }, 10)
    try {
      const started = Date.now()
      await runCommandTask(
        { name: 'test-async-probe', type: 'command', command: 'sleep 0.4', timeoutMs: 5_000 } as never,
        started,
      )
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(350) // the child really did run
      // ~40 ticks are due in 400ms; spawnSync would yield 0. A low bar keeps this
      // stable on a loaded CI box while still being impossible to pass when blocked.
      expect(ticks).toBeGreaterThan(5)
    } finally {
      clearInterval(probe)
    }
  })

  it('is an async function, so a caller can await it', () => {
    expect(runCommandTask.constructor.name).toBe('AsyncFunction')
  })

  // Deliberately strict: the identifier must not appear ANYWHERE in the file, comments included.
  // A regex that tried to skip comments would be the fragile part of the guard, and the prose can
  // always say "the synchronous spawn API" instead.
  it('does not use any *Sync child_process API', () => {
    expect(SRC).not.toMatch(/\bspawnSync\b/)
    expect(SRC).not.toMatch(/\bexecSync\b/)
    expect(SRC).not.toMatch(/\bexecFileSync\b/)
  })

  it('is awaited at its only call site, so a tick cannot stack runs of the same task', () => {
    const runner = readFileSync(join(REPO, 'src', 'web', 'schedule-runner.ts'), 'utf-8')
    // an un-awaited async call would compile and stay non-blocking, but would drop the
    // one-at-a-time ordering the scheduler relies on
    expect(runner).toMatch(/await runCommandTask\(/)
    expect(runner).not.toMatch(/^\s*runCommandTask\(/m)
  })

  it('reports a timeout as a timeout, not as an exit code', async () => {
    // Node kills the child and sets killed=true; the exit-code branch must not claim it first.
    const started = Date.now()
    await runCommandTask(
      { name: 'test-async-timeout', type: 'command', command: 'sleep 5', timeoutMs: 150 } as never,
      started,
    )
    expect(Date.now() - started).toBeLessThan(3_000) // killed early, did not wait out the 5s
  })
})
