// Card 873c48df: agent-process.ts spawned a process just to wait.
//
// `execSync('sleep 3')` after a tmux kill-session in startAgentProcess, and `execSync('sleep 2')`
// in stopAgentProcess. Both are reachable from POST /api/agents/<name>/start|stop, and both are
// SYNCHRONOUS, so a single inbound request froze the whole event loop -- every other request
// included -- for two to three seconds. It is the same shape card 89d0bfde removed from
// routes/agents.ts, in the module that drives every agent start, stop and restart.
//
// This lives in its own file rather than in scheduler-tick-nonblocking.test.ts on purpose: that
// suite's file lists are being reworked on another branch (card 095edfec), and a second edit to the
// same block would collide for no benefit. The rule below is independent of those lists.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT_PROCESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'agent-process.ts')

/** Source minus `//` comment lines: a comment describing the removed call is not a call. */
function code(): string {
  const src = readFileSync(AGENT_PROCESS, 'utf-8')
  expect(src.length, 'agent-process.ts read empty -- every assertion below would be vacuous').toBeGreaterThan(1000)
  return src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
}

describe('agent-process.ts never spawns a process just to wait (card 873c48df)', () => {
  it('has no `sleep N` child anywhere', () => {
    expect(
      code(),
      'a spawned `sleep` blocks the event loop for its full duration and does what a timer does for free. ' +
        'Use the module\'s own `delay(ms)` helper and await it.',
    ).not.toMatch(/['"`]sleep \d/)
  })

  it('the two settle waits are awaited timers, not children', () => {
    const src = code()
    // Both call sites follow a kill-session; the point is that the wait yields to the loop.
    expect(src).toMatch(/await delay\(3000\)/)
    expect(src).toMatch(/await delay\(2000\)/)
  })

  it('start/stop/restart are awaitable, so a caller can await instead of blocking', () => {
    const src = code()
    // Card 74ba7c78 split each entry point into a `export function X(): Promise<...>` wrapper that
    // takes the per-agent in-flight guard, plus the async `XUnlocked` that does the work. The
    // property this test protects is unchanged -- the caller gets a promise, not a frozen loop --
    // so it is asserted on the shape that now carries it rather than on the old keyword.
    for (const fn of ['startAgentProcess', 'stopAgentProcess', 'restartAgentProcess']) {
      expect(src, `${fn} must return a Promise`).toMatch(new RegExp(`export function ${fn}\\(`))
      expect(src, `${fn}'s work must still be async`).toMatch(new RegExp(`async function ${fn}Unlocked\\(`))
    }
    expect(src).toMatch(/Promise<\{ ok: boolean; pid\?: number; error\?: string \}>/)
  })

  // The four REMAINING sync calls -- runTmux, captureTmux and two liveness probes -- are bounded
  // tmux/ssh commands with explicit timeouts, behind two wrappers with 33 internal call sites and
  // 21 external synchronous consumers (isAgentRunning alone has 21). Converting them is an
  // architectural change, not this card, so the count is PINNED: it may not grow silently, and
  // when it shrinks this number has to come down with it.
  it('the remaining synchronous children stay at the reviewed count', () => {
    const matches = code().match(/\b(?:spawnSync|execSync|execFileSync)\(/g) ?? []
    expect(
      matches.length,
      'agent-process.ts changed its number of synchronous child calls. Four are the reviewed tmux/ssh ' +
        'wrappers and probes; a FIFTH needs justification, and a smaller number means this pin is stale.',
    ).toBe(4)
  })
})
