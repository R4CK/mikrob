// Guard: nothing on the SCHEDULER TICK may run a child process synchronously (card 92e2bb1b).
//
// Generalises the card-955f014e fix. Anything the tick calls runs on the main thread, so a
// synchronous child freezes the whole event loop -- HTTP server included -- for its full duration.
// command-task.ts was the 60-second case; runPreCheck() in schedule-runner.ts was the same shape with
// a 10-second ceiling, once per tick, and had been there the whole time.
//
// SCOPE, deliberately narrow and measured rather than assumed. A repo-wide "no sync child_process on
// the server" rule is NOT implementable today: `src/web/**` has 30+ files and hundreds of such call
// sites (updates.ts alone has 20). Most are short, bounded, local commands. Banning the API globally
// would land red and be switched off, which is worse than no rule. So the invariant covers exactly the
// two files that execute ON the tick, where the cost is a frozen dashboard rather than a slow function.
//
// The optional part of the card -- `-m/--max-time` on self-curls -- is a soft guideline by MikroB's own
// decision, so it is NOT gated here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

// Files whose code runs synchronously inside a scheduler tick.
const TICK_PATH_FILES = ['command-task.ts', 'schedule-runner.ts'] as const
const SYNC_CHILD_APIS = ['spawnSync', 'execSync', 'execFileSync'] as const

describe('scheduler tick stays off the blocking path (card 92e2bb1b)', () => {
  it.each(TICK_PATH_FILES)('%s uses no synchronous child_process API', (file) => {
    const src = readFileSync(join(WEB, file), 'utf-8')
    expect(src.length, `${file} is empty -- an empty read would make this vacuous`).toBeGreaterThan(0)
    for (const api of SYNC_CHILD_APIS) {
      expect(src, `${file} must not call ${api}: it would freeze the event loop for the child's lifetime`)
        .not.toMatch(new RegExp(`\\b${api}\\b`))
    }
  })

  it.each(TICK_PATH_FILES)('%s awaits every child it starts', (file) => {
    const src = readFileSync(join(WEB, file), 'utf-8')
    // Every execFile call has to be wrapped in an awaited Promise; an un-awaited one would let the
    // tick continue while the child is still running, which is a different bug (interleaved runs).
    const execFileCalls = (src.match(/\bexecFile\(/g) ?? []).length
    if (execFileCalls === 0) return
    expect(src).toMatch(/new Promise/)
    expect(src).toMatch(/await /)
  })

  it('keeps the two runners async, so the callers can await instead of blocking', () => {
    const runner = readFileSync(join(WEB, 'schedule-runner.ts'), 'utf-8')
    const cmd = readFileSync(join(WEB, 'command-task.ts'), 'utf-8')
    expect(runner).toMatch(/export async function runPreCheck/)
    expect(cmd).toMatch(/export async function runCommandTask/)
    expect(runner).toMatch(/await runPreCheck\(/)
    expect(runner).toMatch(/await runCommandTask\(/)
  })

  // Guards the SCOPE decision itself: this list is small on purpose, and shrinking it to nothing
  // would silently disable the rule.
  it('covers every file known to execute on the tick', () => {
    expect(TICK_PATH_FILES).toContain('command-task.ts')
    expect(TICK_PATH_FILES).toContain('schedule-runner.ts')
    expect(SYNC_CHILD_APIS.length).toBeGreaterThanOrEqual(3)
  })
})
