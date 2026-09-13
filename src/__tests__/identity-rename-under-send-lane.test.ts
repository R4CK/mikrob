import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// IDENTLANE910 -- card 1d421873. The behavioural pin the identity `/rename` never had.
//
// WHAT CYBERSEC FOUND (9c665470 gate, 2026-09-11): scheduleIdentitySetup typed `/rename <name>`
// with a bare runTmux(send-keys) on a fire-and-forget setTimeout, outside any lock. Measured
// upstream 2026-09-10: an update.sh restart fired identity setup while the scheduler was
// chunk-pasting a task prompt into the SAME pane, and the rename spliced into the MIDDLE of that
// prompt. The reading agent saw an unprovenanced self-rename command inside its own instructions --
// foreign text inside a trusted-sender frame, the prompt-injection shape the nudger incident
// already cost us once.
//
// WHY THIS FILE EXISTS EVEN THOUGH THE CODE IS ALREADY FIXED. The fix did not come from this fork:
// it arrived as upstream db4e4723 (IDENTLANE910) + ad76037f (PANEWRITERS910) and landed in develop
// on 2026-09-12 via merge b92a5b66 -- one day AFTER the finding, before anyone here wrote a line.
// Nothing in our suite asserted it. A fix that arrives in a merge can leave in one: agent-identity-
// setup.test.ts covers only identitySlashCommands (the pure string), and janitor-under-send-lane
// .test.ts pins the two janitors, not this writer. So the one pane writer a security review actually
// named was the one with no test standing behind it.
//
// THE CONTRACT PINNED HERE:
//   - lane HELD by a delivery -> the rename sends NOTHING and does not give up on the first try;
//   - lane freed mid-wait     -> it takes its turn (a skip would leave the session unnamed for life);
//   - lane free               -> it fires exactly once (positive control, so a broken acquire
//                                cannot pass as "safely deferred");
//   - lane never free         -> it abandons rather than writing into a held lane.
//
// Same harness as janitor-under-send-lane.test.ts: execFileSync is mocked with arg inspection, and
// session-send-lock is deliberately NOT mocked -- the test holds the REAL lane the way a delivery
// does. Timers are faked because the production delays are 8s + 5s.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  // A plain idle pane: no survey, no resume summary, no consent, no feedback draft -- so the
  // dismissal span finds nothing to dismiss and only the rename can produce send-keys.
  const IDLE = ['', SEP, '❯ ', SEP, FOOTER].join('\n')
  return { IDLE, calls: [] as string[][] }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.IDLE
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { scheduleIdentitySetup } from '../web/agent-process.js'
import { tryAcquireSessionSendLane, __resetSessionSendLocks } from '../web/session-send-lock.js'

const SESSION = 'agent-backend'

/** Every send-keys the code fired, as argv arrays. */
const sentKeys = (): string[][] => h.calls.filter((a) => a.includes('send-keys'))
/** The send-keys that actually carry the rename command. */
const renameSends = (): string[][] => sentKeys().filter((a) => a.some((s) => s.startsWith('/rename')))

beforeEach(() => {
  h.calls.length = 0
  __resetSessionSendLocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Run the schedule past both delays plus `extraMs` of retry time. */
async function runSetup(extraMs = 0): Promise<void> {
  const p = scheduleIdentitySetup(SESSION, 'Backend')
  await vi.advanceTimersByTimeAsync(8000 + 5000 + extraMs)
  await p
}

describe('the identity /rename under the per-pane send lane (IDENTLANE910, card 1d421873)', () => {
  it('writes NOTHING while a delivery holds the lane', async () => {
    // THE DEFECT ITSELF. Before the fix this fired regardless, and its text could land inside the
    // delivery's frame. Asserting on send-keys (not just on the rename) is deliberate: the
    // dismissal span must stay off the pane too while someone else is mid-message.
    const release = tryAcquireSessionSendLane(SESSION, null)
    expect(release, 'the test must actually hold the lane, or it proves nothing').toBeTruthy()
    try {
      await runSetup(2000)
      expect(sentKeys(), `wrote into a held lane: ${JSON.stringify(sentKeys())}`).toEqual([])
    } finally {
      release!()
    }
  })

  it('positive control: with the lane free it sends the rename exactly once', async () => {
    // Without this, an implementation that never sent anything at all would satisfy every
    // "sends nothing" case above.
    await runSetup()
    expect(renameSends()).toHaveLength(1)
    expect(renameSends()[0]!.some((s) => s === '/rename Backend')).toBe(true)
  })

  it('takes its turn when the lane frees mid-wait, instead of skipping', async () => {
    // A SKIPPED rename leaves the session unnamed for its whole life, so this writer retries where
    // the janitors skip. That difference is the thing most likely to be "simplified" away later.
    const release = tryAcquireSessionSendLane(SESSION, null)
    const p = scheduleIdentitySetup(SESSION, 'Backend')
    await vi.advanceTimersByTimeAsync(8000 + 5000)
    expect(renameSends(), 'must not have written while the lane was held').toEqual([])
    release!()
    await vi.advanceTimersByTimeAsync(3000 * 2)
    await p
    expect(renameSends(), 'a freed lane must be used, not abandoned').toHaveLength(1)
  })

  it('abandons after its bounded retries rather than writing into a lane that never frees', async () => {
    // The give-up branch is the safe one, and it has to stay reachable: an unbounded retry loop
    // would hold a timer forever, and a fallthrough that wrote anyway would be the original bug.
    const release = tryAcquireSessionSendLane(SESSION, null)
    try {
      await runSetup(3000 * 6)
      expect(sentKeys()).toEqual([])
    } finally {
      release!()
    }
  })
})
