// Guard: nothing on the SCHEDULER TICK may run a child process synchronously (card 92e2bb1b).
//
// Generalises the card-955f014e fix. Anything the tick calls runs on the main thread, so a
// synchronous child freezes the whole event loop -- HTTP server included -- for its full duration.
// command-task.ts was the 60-second case; runPreCheck() in schedule-runner.ts was the same shape with
// a 10-second ceiling, once per tick, and had been there the whole time.
//
// SCOPE, measured rather than assumed. A repo-wide "no sync child_process on the server" rule is NOT
// implementable today: `src/web/**` has 30+ files and hundreds of such call sites (updates.ts alone
// has 20). Most are short, bounded, local commands. Banning the API globally would land red and be
// switched off, which is worse than no rule.
//
// WHAT THIS DOES AND DOES NOT CLAIM. An earlier version of this header said the invariant "covers
// exactly the two files that execute ON the tick". That was false, and Cybersec was right to block on
// it: the tick reaches further than those two files. `schedule-runner.ts` calls capturePane() and
// sendEnterToSession() from `agent-process.ts` (tmux via execFileSync, 3s local / 8s remote) directly
// inside runCheck. Those calls are bounded and predate this card, but a reader seeing this suite green
// would have concluded the tick spawns no synchronous child at all -- a check that did not run on what
// it talks about, read as a pass. That is the very class this card exists to close.
//
// So: the tick's own RUNNERS are fully enforced, and every other tick-reachable file is listed as a
// PINNED exception with its exact current count. A new sync call site in an exception file turns this
// red even though the file is not clean yet, so the gap can shrink but never silently grow.
//
// The optional part of the card -- `-m/--max-time` on self-curls -- is a soft guideline by MikroB's own
// decision, so it is NOT gated here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

/** Real (non-comment) call sites of the synchronous child_process APIs in a source file. */
function countSyncCalls(src: string): number {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && SYNC_CHILD_APIS.some((a) => t.includes(`${a}(`))
    }).length
}

// The tick's own runners: fully enforced, zero tolerance.
const TICK_PATH_FILES = ['command-task.ts', 'schedule-runner.ts'] as const

// Tick-REACHABLE files that still contain bounded synchronous calls. Pinned to the exact count so the
// set cannot grow unnoticed. schedule-mcp-precheck.ts is absent because this card converted its one
// `/bin/ps` call; agent-process.ts remains because its tmux wrapper is used far beyond the scheduler
// and converting it needs its own card.
//
// The number is MEASURED, not quoted: the NO-GO said 11 for agent-process.ts, but 11 counts comment
// and doc mentions too. Six lines actually call one of these APIs. Pinning the quoted number would
// have made this suite red on arrival.
const TICK_SYNC_EXCEPTIONS: Readonly<Record<string, number>> = {
  'agent-process.ts': 6, // tmux execFileSync wrapper, timeout 3000 local / 8000 remote
}
// Route handlers: a single inbound HTTP request triggers these, so a blocking child freezes every
// other request. agents.ts held three `execSync('sleep N')` calls -- one of them inside a
// 12-iteration loop, i.e. up to twelve seconds of frozen dashboard per /login (card 89d0bfde).
const ROUTE_FILES = ['routes/agents.ts'] as const
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

  it.each(ROUTE_FILES)('%s spawns no synchronous child, and never a process just to wait', (file) => {
    const src = readFileSync(join(WEB, file), 'utf-8')
    expect(src.length).toBeGreaterThan(0)
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//'))
    for (const api of SYNC_CHILD_APIS) {
      expect(codeLines.join('\n'), `${file} must not call ${api} on the request path`)
        .not.toMatch(new RegExp(`\\b${api}\\(`))
    }
    // spawning `sleep` is the daftest form of it: a whole process to do what a timer does for free
    expect(codeLines.join('\n')).not.toMatch(/['"`]sleep \d/)
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

  // The honest half of the invariant. `toBe`, never `>=`: a floor would let the exception grow while
  // staying green, which is exactly the "check that does not check" shape this card is about.
  it.each(Object.entries(TICK_SYNC_EXCEPTIONS))(
    '%s still has exactly %i known synchronous call site(s) -- pinned, so the gap cannot widen',
    (file, expected) => {
      const src = readFileSync(join(WEB, file), 'utf-8')
      expect(src.length, `${file} is empty -- an empty read would make this vacuous`).toBeGreaterThan(0)
      expect(countSyncCalls(src)).toBe(expected)
    },
  )

  // schedule-mcp-precheck.ts ran `/bin/ps` synchronously from attemptFireTask. This card converted it,
  // so it is now held to the same zero-tolerance rule as the runners rather than being an exception.
  it('schedule-mcp-precheck.ts is clean, and its pre-check is awaited on the tick', () => {
    const pre = readFileSync(join(WEB, 'schedule-mcp-precheck.ts'), 'utf-8')
    expect(countSyncCalls(pre)).toBe(0)
    expect(pre).toMatch(/export async function checkTaskMcpRequirements/)
    expect(readFileSync(join(WEB, 'schedule-runner.ts'), 'utf-8')).toMatch(/await checkTaskMcpRequirements\(/)
  })

  // Derives the tick-reachable set from schedule-runner's OWN imports instead of a hand-kept list, so a
  // newly imported module that spawns synchronously cannot slip past unnoticed (Cybersec request 3).
  it('every synchronous call site reachable from the tick is either fixed or pinned', () => {
    const runner = readFileSync(join(WEB, 'schedule-runner.ts'), 'utf-8')
    const imported = [...runner.matchAll(/from '\.\/([A-Za-z0-9-]+)\.js'/g)].map((m) => `${m[1]}.ts`)
    expect(imported.length, 'no local imports parsed -- the regex would make this vacuous').toBeGreaterThan(3)
    const unaccounted: string[] = []
    for (const file of new Set(imported)) {
      let src: string
      try { src = readFileSync(join(WEB, file), 'utf-8') } catch { continue }
      if (countSyncCalls(src) === 0) continue
      if (file in TICK_SYNC_EXCEPTIONS) continue
      unaccounted.push(file)
    }
    expect(unaccounted, 'a tick-reachable module spawns synchronously and is neither fixed nor pinned').toEqual([])
  })
})
