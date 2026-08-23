// Tests for the sub-agent Telegram inbox wake-nudge.
//
// The pure gate decision (shouldWakeForTelegramInbox) is tested exhaustively
// with no filesystem or tmux, mirroring shouldWakeMainAgent. All five conditions
// (hasPending + age + debounce + session-exists + session-idle) are exercised.

import { describe, it, expect } from 'vitest'
import { shouldWakeForTelegramInbox, wakeBackoffMs } from '../web/telegram-inbox-wake.js'

const BASE = {
  inboxAgeMs: 60_000,
  hasPending: true,
  now: 1_000_000_000,
  lastWakeAt: 0,
  sessionExists: true,
  sessionIdle: true,
  minAgeMs: 25_000,
  debounceMs: 60_000,
}

describe('shouldWakeForTelegramInbox (pure gate decision)', () => {
  it('wakes when inbox has pending content, is old enough, session idle, debounce elapsed', () => {
    expect(shouldWakeForTelegramInbox(BASE)).toBe(true)
  })

  it('does NOT wake when there is nothing pending', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, hasPending: false })).toBe(false)
  })

  it('does NOT wake for a fresh inbox (age gate, strict >)', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 10_000 })).toBe(false)
    // exactly at the threshold is still not old enough
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 25_000 })).toBe(false)
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 25_001 })).toBe(true)
  })

  it('does NOT wake within the debounce window of the last nudge', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, lastWakeAt: BASE.now - 30_000 })).toBe(false)
    // exactly at the debounce boundary is allowed
    expect(shouldWakeForTelegramInbox({ ...BASE, lastWakeAt: BASE.now - 60_000 })).toBe(true)
  })

  it('does NOT wake when the sub-agent session is absent', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, sessionExists: false })).toBe(false)
  })

  it('does NOT wake when the session is busy/mid-turn -- avoids the inject race', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, sessionIdle: false })).toBe(false)
  })

  it('stops nudging once the per-agent attempt budget is exhausted', () => {
    // debounce elapsed and everything else ready, but attempts >= maxAttempts
    expect(shouldWakeForTelegramInbox({
      ...BASE, lastWakeAt: 0, attempts: 5, maxAttempts: 5,
    })).toBe(false)
    // one under the budget still wakes (backoff window permitting)
    expect(shouldWakeForTelegramInbox({
      ...BASE, lastWakeAt: 0, attempts: 4, maxAttempts: 5,
    })).toBe(true)
  })

  it('applies exponential backoff: a higher attempt count needs a longer gap', () => {
    const commonDebounce = { ...BASE, debounceMs: 60_000, maxDebounceMs: 30 * 60_000 }
    // attempt 2 -> effective gap 60s * 2^2 = 240s. 200s since last nudge: too soon.
    expect(shouldWakeForTelegramInbox({
      ...commonDebounce, attempts: 2, lastWakeAt: BASE.now - 200_000,
    })).toBe(false)
    // 240s since last nudge: exactly at the backed-off boundary -> allowed.
    expect(shouldWakeForTelegramInbox({
      ...commonDebounce, attempts: 2, lastWakeAt: BASE.now - 240_000,
    })).toBe(true)
  })
})

describe('wakeBackoffMs (exponential gap with cap)', () => {
  it('is the base gap at attempt 0 (unchanged first-retry behaviour)', () => {
    expect(wakeBackoffMs(0, 60_000, 30 * 60_000)).toBe(60_000)
  })
  it('doubles per attempt', () => {
    expect(wakeBackoffMs(1, 60_000, 30 * 60_000)).toBe(120_000)
    expect(wakeBackoffMs(3, 60_000, 30 * 60_000)).toBe(480_000)
  })
  it('never exceeds the cap', () => {
    expect(wakeBackoffMs(10, 60_000, 30 * 60_000)).toBe(30 * 60_000)
  })
})

describe('the backoff grows on UNDELIVERED nudges, not on received ones (card b2f13520)', () => {
  // QA's finding on the df193354 gate. That card correctly narrowed `attempts` to "nudges the
  // agent actually RECEIVED and ignored", so a busy/locked pane no longer burns a waiting agent's
  // give-up budget -- but `attempts` was ALSO the backoff input, so for a permanently locked pane
  // it stays 0 for ever and the gap stayed pinned at the 60s floor. The 30-minute escalation
  // became unreachable, and the backoff gate runs BEFORE the tmux probes, so that floor is what
  // decides how often a locked pane costs a blocking sleep plus two capture-panes.
  const BASE = 60_000
  const CAP = 30 * 60_000
  const common = {
    inboxAgeMs: 10 * 60_000,
    hasPending: true,
    sessionExists: true,
    sessionIdle: true,
    minAgeMs: 60_000,
    debounceMs: BASE,
    maxDebounceMs: CAP,
    maxAttempts: 5,
  }

  it('THE DEFECT: attempts=0 forever must no longer mean a 60s gap forever', () => {
    // A permanently locked pane: nothing was ever delivered, so attempts stays 0 -- but four
    // undelivered tries have happened, and the gap must reflect THEM.
    const gapAfterFour = wakeBackoffMs(4, BASE, CAP)
    expect(gapAfterFour).toBe(16 * BASE)
    // Just under that gap the sweep must hold off; at the floor it would have gone again.
    expect(
      shouldWakeForTelegramInbox({
        ...common, now: 1_000_000, lastWakeAt: 1_000_000 - (gapAfterFour - 1),
        attempts: 0, backoffAttempts: 4,
      }),
    ).toBe(false)
    expect(
      shouldWakeForTelegramInbox({
        ...common, now: 1_000_000, lastWakeAt: 1_000_000 - gapAfterFour,
        attempts: 0, backoffAttempts: 4,
      }),
    ).toBe(true)
  })

  it('CONTROL: with the old single-counter behaviour the same state waited only 60s', () => {
    // Pins WHAT changed. Without backoffAttempts the call falls back to `attempts`, which is 0 for
    // a locked pane -- one minute, for ever. This is the behaviour the card is about.
    expect(
      shouldWakeForTelegramInbox({
        ...common, now: 1_000_000, lastWakeAt: 1_000_000 - BASE, attempts: 0,
      }),
    ).toBe(true)
  })

  it('the give-up BUDGET still reads attempts, not the undelivered count', () => {
    // Otherwise this fix would undo df193354: a locked pane would exhaust the budget of an agent
    // that never received anything, which is the starvation that card removed.
    // `lastWakeAt` is pushed far enough back that the (now much wider) backoff window has already
    // elapsed -- otherwise this would measure the gap, not the budget. My first version used 0 and
    // went red for exactly that reason: 99 undelivered means a 30-minute gap, and `now` was only a
    // thousand seconds past the epoch here.
    const longAgo = 1_000_000 - CAP - 1
    expect(
      shouldWakeForTelegramInbox({
        ...common, now: 1_000_000, lastWakeAt: longAgo, attempts: 0, backoffAttempts: 99,
      }),
    ).toBe(true) // 99 undelivered, budget untouched -- still allowed to try
    expect(
      shouldWakeForTelegramInbox({
        ...common, now: 1_000_000, lastWakeAt: longAgo, attempts: 5, backoffAttempts: 0,
      }),
    ).toBe(false) // 5 RECEIVED and ignored -> budget exhausted
  })

  it('backoffAttempts defaults to attempts, so every existing caller is unchanged', () => {
    for (const n of [0, 1, 3, 9]) {
      const withDefault = shouldWakeForTelegramInbox({
        ...common, now: 1_000_000, lastWakeAt: 1_000_000 - wakeBackoffMs(n, BASE, CAP), attempts: n,
      })
      const explicit = shouldWakeForTelegramInbox({
        ...common, now: 1_000_000, lastWakeAt: 1_000_000 - wakeBackoffMs(n, BASE, CAP), attempts: n, backoffAttempts: n,
      })
      expect(withDefault).toBe(explicit)
    }
  })

  it('the growth still stops at the cap -- this widens the gap, it does not remove the ceiling', () => {
    expect(wakeBackoffMs(30, BASE, CAP)).toBe(CAP)
  })
})
