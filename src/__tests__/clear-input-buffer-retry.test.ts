// clearInputBuffer retry + verify (card b34fa678, ported from upstream blob 31758af9d36f).
//
// WHY IT EXISTS. The clear used to be fire-and-forget and returned void. On 2026-09-03 the
// clear-scheduled path fired, left a TRUNCATED FRAGMENT of the parked tick behind, and that
// leftover no longer matched any delivery wrapper -- so every later restart decision read
// machineOrigin=false and deferred. The session sat wedged 25.4 hours. An unverified clear is the
// root cause; the restart hard cap only bounds the damage.
//
// capturePane and runTmux both go through node:child_process execFileSync, so the pane the function
// reads is driven by mocking that with argument inspection -- the pattern parked-input-escalation
// already uses in this suite.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  // 'typing' state with text in the live box -> stuckInputSignature() is non-null, i.e. NOT empty.
  const STUCK = ['', SEP, '❯ [scheduled-task] leftover fragment', SEP, FOOTER].join('\n')
  // Same box, empty -> stuckInputSignature() is null, i.e. the clear worked.
  const EMPTY = ['', SEP, '❯ ', SEP, FOOTER].join('\n')
  return {
    STUCK,
    EMPTY,
    // One entry per capture-pane call, consumed in order; the last one repeats.
    panes: [] as string[],
    captures: 0,
    sendKeys: 0,
    throwOnSendKeys: false,
    // 1-based index of the capture-pane call that should THROW. capturePane returns null only when
    // captureTmux throws, so an empty string is NOT the null path -- see the test that uses this.
    throwOnCapture: 0,
  }
})

vi.mock('node:child_process', async (orig) => ({
  ...((await orig()) as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      if (args.includes('capture-pane')) {
        h.captures++
        if (h.throwOnCapture === h.captures) throw new Error('pane is gone')
        return h.panes[Math.min(h.captures - 1, h.panes.length - 1)] ?? h.EMPTY
      }
      if (args.includes('send-keys')) {
        h.sendKeys++
        if (h.throwOnSendKeys) throw new Error('tmux is gone')
      }
    }
    return ''
  }),
}))

import { readFileSync } from 'node:fs'
import { clearInputBuffer } from '../web/agent-process.js'

beforeEach(() => {
  h.panes = []
  h.captures = 0
  h.sendKeys = 0
  h.throwOnSendKeys = false
  h.throwOnCapture = 0
})

describe('clearInputBuffer retry + verify (card b34fa678)', () => {
  it('returns TRUE and stops after one pass when the box verifies empty', async () => {
    // capture 1 = the row-count read, capture 2 = the verify.
    h.panes = [h.STUCK, h.EMPTY]
    expect(await clearInputBuffer('s')).toBe(true)
    expect(h.captures).toBe(2)
  })

  it('RETRIES and returns true when the SECOND pass is the one that empties the box', async () => {
    // THE CASE THAT PROVES THE LOOP IS A LOOP. Without it, "returns true" is satisfied by a
    // function that never retries at all -- the exact shape this card replaces.
    h.panes = [h.STUCK, h.STUCK, h.STUCK, h.EMPTY]
    expect(await clearInputBuffer('s')).toBe(true)
    expect(h.captures).toBe(4)
  })

  it('returns FALSE after three passes when the box never empties', async () => {
    h.panes = [h.STUCK]
    expect(await clearInputBuffer('s')).toBe(false)
    // 3 attempts x (row-count read + verify read)
    expect(h.captures).toBe(6)
  })

  it('returns FALSE immediately when tmux throws, without burning the retries', async () => {
    // A dead pane is not a box that needs another try: retrying would send keys into nothing
    // three times and delay the caller for no gain.
    h.panes = [h.STUCK]
    h.throwOnSendKeys = true
    expect(await clearInputBuffer('s')).toBe(false)
    expect(h.captures).toBe(1)
  })

  it('treats an UNREADABLE pane as cleared rather than looping forever', async () => {
    // capturePane returns null ONLY when captureTmux throws, so the verify capture has to throw --
    // an empty string takes the `stuckInputSignature(...) == null` branch instead and proves
    // nothing about this one. The first version of this case used '' and stayed green under the
    // mutation that removes the null clause, i.e. it was vacuous.
    //
    // Upstream resolves an unreadable pane to true: the alternative is three guaranteed-useless
    // retries every time a capture fails, and the caller's own delivery verification is what
    // actually catches a bad send. Pinned so the choice is visible rather than incidental.
    h.panes = [h.STUCK]
    h.throwOnCapture = 2
    expect(await clearInputBuffer('s')).toBe(true)
  })
})

// The two call sites that ACT on the boolean. There is no harness in this suite for
// performStuckInputAction (stuck-input-action.test.ts covers the pure pane-state predicates, not
// channel-monitor), and building one for a NORMAL card would be new infrastructure rather than
// coverage. So this pins the WIRING from the source, the way parked-clear-sequence.test.ts already
// does for agent-process -- and says so: the runtime behaviour is pinned above, at the function
// itself; what is asserted here is only that these two branches stopped discarding the result.
//
// The three RE-INJECT sites deliberately keep ignoring it, matching upstream: each is immediately
// followed by sendPromptToSession, which replaces the box contents and carries its own delivery
// verification, so the boolean would add nothing there.
describe('the no-re-inject call sites act on the result (card b34fa678)', () => {
  const SRC = readFileSync(
    new URL('../web/channel-monitor.ts', import.meta.url), 'utf-8')

  for (const branch of ['clear-preamble', 'clear-scheduled']) {
    it(`${branch} captures the boolean and logs when the clear failed`, () => {
      const start = SRC.indexOf(`case '${branch}':`)
      expect(start, `${branch} branch not found`).toBeGreaterThan(-1)
      const body = SRC.slice(start, SRC.indexOf('break', start))
      // Not a bare `await clearInputBuffer(...)` statement any more...
      expect(body).toMatch(/const\s+cleared\s*=\s*await\s+clearInputBuffer\(/)
      // ...and the failure is actually reported, not just captured into a dead variable.
      expect(body).toMatch(/if\s*\(!cleared\)/)
    })
  }
})
