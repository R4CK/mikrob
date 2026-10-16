import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import {
  RETRY_PRECHECK_MIN_INTERVAL_MS,
  rememberPreCheckAnswer,
  resetPreCheckAnswersForTests,
  retryPreCheck,
  runPreCheck,
  type PreCheckResult,
} from '../web/schedule-runner.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// df2e0d97 2a: the pending-retry loop re-ran a task's preCheck on every 15 s
// tick through spawnSync, holding the dashboard's event loop for the whole
// script run. The retry path now runs it off the loop (runPreCheck, the
// single async entry point) and at most once a minute per task
// (retryPreCheck); the cron loop's fresh answer refreshes the remembered one.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name: 'test-task',
    description: 'test',
    prompt: 'Do something.',
    schedule: '0 * * * *',
    agent: 'jarvis',
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    ...overrides,
  }
}

function withScript(content: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-async-'))
  const file = join(dir, 'pre-check.sh')
  writeFileSync(file, content, { mode: 0o755 })
  return { dir, file }
}

// How late a timer due in 50 ms fires while `work` runs.
async function timerLateness(work: () => unknown): Promise<{ lateMs: number; value: unknown }> {
  const t0 = performance.now()
  const fired = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - t0 - 50), 50))
  const value = await work()
  return { lateMs: await fired, value }
}

describe('runPreCheck answers', () => {
  it('SKIP', async () => {
    const { dir, file } = withScript('#!/usr/bin/env bash\necho "SKIP"\n')
    try {
      expect(await runPreCheck(makeTask({ preCheck: file }))).toEqual({ skip: true })
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('actionable text becomes the prefix, trimmed', async () => {
    const { dir, file } = withScript('#!/usr/bin/env bash\necho "  3 actionable cards found  "\n')
    try {
      expect(await runPreCheck(makeTask({ preCheck: file }))).toEqual({ skip: false, prefix: '3 actionable cards found' })
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('no output: no prefix', async () => {
    const { dir, file } = withScript('#!/usr/bin/env bash\nexit 0\n')
    try {
      expect(await runPreCheck(makeTask({ preCheck: file }))).toEqual({ skip: false })
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('a non-zero exit fails open, even after printing SKIP', async () => {
    const { dir, file } = withScript('#!/usr/bin/env bash\necho "SKIP"\nexit 3\n')
    try {
      expect(await runPreCheck(makeTask({ preCheck: file }))).toEqual({ skip: false })
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('accented text survives the chunked read', async () => {
    const { dir, file } = withScript('#!/usr/bin/env bash\nfor i in $(seq 1 3000); do printf "árvíztűrő tükörfúrógép "; done\necho\n')
    try {
      const r = await runPreCheck(makeTask({ preCheck: file }))
      expect(r.skip).toBe(false)
      expect(r.prefix?.startsWith('árvíztűrő tükörfúrógép árvíztűrő')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('a missing script and a task without a preCheck fail open', async () => {
    const missing = makeTask({ preCheck: '/nonexistent/path/pre-check.sh' })
    expect(await runPreCheck(missing)).toEqual({ skip: false })
    expect(await runPreCheck(makeTask())).toEqual({ skip: false })
  })
})

describe('runPreCheck limits', () => {
  it('over the time limit the LLM runs anyway, and the answer comes at the limit, not at the end of the script', async () => {
    const { dir, file } = withScript('#!/usr/bin/env bash\nsleep 5\necho "SKIP"\n')
    try {
      const t0 = performance.now()
      const r = await runPreCheck(makeTask({ preCheck: file }), { timeoutMs: 300 })
      expect(r).toEqual({ skip: false })
      expect(performance.now() - t0).toBeLessThan(2500)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('an output over the cap fails open; the same output under the cap is the prefix', async () => {
    const { dir, file } = withScript('#!/usr/bin/env bash\nhead -c 3000 /dev/zero | tr "\\0" a\necho\n')
    try {
      const task = makeTask({ preCheck: file })
      expect(await runPreCheck(task, { maxStdoutBytes: 1000 })).toEqual({ skip: false })
      const under = await runPreCheck(task, { maxStdoutBytes: 4000 })
      expect(under.skip).toBe(false)
      expect(under.prefix).toBe('a'.repeat(3000))
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})

describe('the event loop while a pre-check runs (the reason for 2a)', () => {
  it('a timer due in 50 ms fires during a 1.5 s pre-check without being held to the end', async () => {
    const { dir, file } = withScript('#!/usr/bin/env bash\nsleep 1.5\necho "SKIP"\n')
    try {
      const task = makeTask({ preCheck: file })
      const off = await timerLateness(() => runPreCheck(task))
      expect(off.value).toEqual({ skip: true })
      expect(off.lateMs).toBeLessThan(500)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})

describe('retryPreCheck: at most once a minute per task', () => {
  afterEach(() => resetPreCheckAnswersForTests())

  function counter(): { run: (t: ScheduledTask) => Promise<PreCheckResult>; runs: () => number } {
    let n = 0
    return {
      run: async (t: ScheduledTask) => {
        n += 1
        return { skip: false, prefix: `${t.name} run ${n}` }
      },
      runs: () => n,
    }
  }

  it('the ticks inside the interval reuse the answer; the first tick at its end runs the script again', async () => {
    const c = counter()
    const task = makeTask({ preCheck: '/x/pre.sh' })
    const t0 = 1_000_000
    expect(await retryPreCheck(task, t0, c.run)).toEqual({ skip: false, prefix: 'test-task run 1' })
    expect(await retryPreCheck(task, t0 + 15_000, c.run)).toEqual({ skip: false, prefix: 'test-task run 1' })
    expect(await retryPreCheck(task, t0 + RETRY_PRECHECK_MIN_INTERVAL_MS - 1, c.run)).toEqual({ skip: false, prefix: 'test-task run 1' })
    expect(c.runs()).toBe(1)
    expect(await retryPreCheck(task, t0 + RETRY_PRECHECK_MIN_INTERVAL_MS, c.run)).toEqual({ skip: false, prefix: 'test-task run 2' })
    expect(c.runs()).toBe(2)
  })

  it('the answer is the task\'s: another task, or the same task with another script, runs its own', async () => {
    const c = counter()
    const t0 = 2_000_000
    await retryPreCheck(makeTask({ name: 'a', preCheck: '/x/a.sh' }), t0, c.run)
    await retryPreCheck(makeTask({ name: 'b', preCheck: '/x/b.sh' }), t0, c.run)
    await retryPreCheck(makeTask({ name: 'a', preCheck: '/x/a2.sh' }), t0, c.run)
    expect(c.runs()).toBe(3)
    // the rows of one task (two target agents) share one run
    await retryPreCheck(makeTask({ name: 'a', preCheck: '/x/a.sh' }), t0 + 1, c.run)
    expect(c.runs()).toBe(3)
  })

  it('the cron loop\'s fresh answer is the one the next retry ticks use', async () => {
    const c = counter()
    const task = makeTask({ preCheck: '/x/pre.sh' })
    const t0 = 3_000_000
    await retryPreCheck(task, t0, c.run)
    rememberPreCheckAnswer(task, t0 + 45_000, { skip: false, prefix: 'fresh from the cron loop' })
    expect(await retryPreCheck(task, t0 + 60_000, c.run)).toEqual({ skip: false, prefix: 'fresh from the cron loop' })
    expect(c.runs()).toBe(1)
  })

  it('a SKIP answer is reused like any other inside the interval', async () => {
    let n = 0
    const run = async (): Promise<PreCheckResult> => {
      n += 1
      return { skip: true }
    }
    const task = makeTask({ preCheck: '/x/pre.sh' })
    expect(await retryPreCheck(task, 4_000_000, run)).toEqual({ skip: true })
    expect(await retryPreCheck(task, 4_000_000 + 15_000, run)).toEqual({ skip: true })
    expect(n).toBe(1)
  })

  it('a clock that stepped back runs the script again instead of trusting a future stamp', async () => {
    const c = counter()
    const task = makeTask({ preCheck: '/x/pre.sh' })
    await retryPreCheck(task, 5_000_000, c.run)
    await retryPreCheck(task, 5_000_000 - 1_000, c.run)
    expect(c.runs()).toBe(2)
  })

  it('a task without a preCheck runs nothing and remembers nothing', async () => {
    const c = counter()
    expect(await retryPreCheck(makeTask(), 6_000_000, c.run)).toEqual({ skip: false })
    rememberPreCheckAnswer(makeTask(), 6_000_000, { skip: true })
    expect(await retryPreCheck(makeTask(), 6_000_001, c.run)).toEqual({ skip: false })
    expect(c.runs()).toBe(0)
  })
})

describe('wiring (source-level)', () => {
  const retryLoop = SRC.slice(SRC.indexOf('for (const row of pendingRows)'), SRC.indexOf('for (const task of tasks)'))

  it('the pending-retry loop awaits the thinned pre-check before attemptFireTask, and the synchronous form is gone from it', () => {
    expect(retryLoop).toMatch(/const retryPc = await retryPreCheck\(taskDef, now\)/)
    expect(retryLoop).not.toMatch(/runPreCheck\(taskDef\)/)
    expect(retryLoop.indexOf('retryPreCheck(taskDef')).toBeLessThan(retryLoop.indexOf('attemptFireTask(current,'))
  })

  // CRONPRECHECKSYNC1007: the cron loop awaits the async form; the answer is
  // still recorded right after it.
  it('the cron loop awaits the async pre-check and records its fresh answer right after it', () => {
    expect(SRC).toMatch(/const cronPc = await runPreCheck\(task\)\n\s+rememberPreCheckAnswer\(task, now, cronPc\)/)
  })

  it('runPreCheck spawns without a synchronous call, anywhere in the file', () => {
    expect(SRC).not.toMatch(/\b(spawnSync|execSync|execFileSync)\(/)
    const fn = SRC.slice(SRC.indexOf('export async function runPreCheck'), SRC.indexOf('export const RETRY_PRECHECK_MIN_INTERVAL_MS'))
    expect(fn).toMatch(/spawn\('bash', \[scriptPath\]/)
  })
})
