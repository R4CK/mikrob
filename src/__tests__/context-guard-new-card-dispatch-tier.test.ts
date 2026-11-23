// The context-guard's NEW-CARD-DISPATCH tier (card f5f78e13).
//
// The gap it closes: a dispatch to a busy agent's pane is send-keys'd into
// whatever Claude Code session is already running there, so a long-lived
// agent re-reads every PRIOR card's transcript on every turn of a NEW card.
// The fix is a fifth trigger on the EXISTING guard (plan-grilling verdict,
// card f5f78e13 comment 31685) rather than a second handoff mechanism --
// one owner for HANDOFF.md, one state machine, one timeout.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  decideGuard,
  newCardDispatchDue,
  forgetNewCardDispatchRecord,
  NEW_CARD_DISPATCH_REASON_PREFIX,
  DAILY_HANDOFF_REASON_PREFIX,
  DEFAULT_CONTEXT_GUARD,
  normalizeContextGuardConfig,
  INITIAL_GUARD_STATE,
  type ContextGuardConfig,
  type GuardInputs,
} from '../context-guard.js'

const NOW = 1_000_000_000

const ARMED: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, newCardHandoffEnabled: true }

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: null,
    running: true,
    paneIdle: true,
    paneBusy: false,
    paneBackgroundWork: false,
    sessionReady: false,
    handoffMtime: null,
    paneSaturated: false,
    contextTokens: null,
    idleMs: null,
    dailyHandoffDue: false,
    newCardDispatchDue: false,
    newCardId: null,
    newCardTitle: null,
    usageLimited: false,
    pendingResumeExpiresAtMs: null,
    ...overrides,
  }
}

function src(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('newCardDispatchDue -- pure predicate', () => {
  it('disarmed never fires, whatever the ids', () => {
    expect(newCardDispatchDue(false, 'card-b', 'card-a')).toBe(false)
  })
  it('nothing currently dispatched never fires', () => {
    expect(newCardDispatchDue(true, null, 'card-a')).toBe(false)
  })
  it('first sight (no record yet) never fires -- the runner seeds instead', () => {
    expect(newCardDispatchDue(true, 'card-a', undefined)).toBe(false)
  })
  it('same card as last seen does not fire', () => {
    expect(newCardDispatchDue(true, 'card-a', 'card-a')).toBe(false)
  })
  it('a DIFFERENT card than last seen fires', () => {
    expect(newCardDispatchDue(true, 'card-b', 'card-a')).toBe(true)
  })
  it('case matters -- card ids are not normalized here (the DB query already matches the real row)', () => {
    expect(newCardDispatchDue(true, 'Card-A', 'card-a')).toBe(true)
  })
})

describe('forgetNewCardDispatchRecord -- when the runner must drop its record', () => {
  it('disarmed forgets', () => {
    expect(forgetNewCardDispatchRecord(false, 'card-a')).toBe(true)
  })
  it('nothing dispatched forgets', () => {
    expect(forgetNewCardDispatchRecord(true, null)).toBe(true)
  })
  it('armed with a real card id keeps the record', () => {
    expect(forgetNewCardDispatchRecord(true, 'card-a')).toBe(false)
  })
})

describe('decideGuard -- new-card-dispatch tier wiring', () => {
  it('fires a handoff request when due and armed', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true }), ARMED)
    expect(d.action).toBe('request-handoff')
    expect(d.reason).toBe(NEW_CARD_DISPATCH_REASON_PREFIX)
    expect(d.nextState.phase).toBe('await-handoff')
  })
  it('does NOT fire when due but the tier is disarmed (defence in depth against a stale input)', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true }), DEFAULT_CONTEXT_GUARD)
    expect(d.action).toBe('none')
  })
  it('does not fire when armed but not due', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: false }), ARMED)
    expect(d.action).toBe('none')
  })
  it('ranked LAST: the daily tier wins when both are due the same sweep', () => {
    const cfg: ContextGuardConfig = { ...ARMED, dailyHandoffEnabled: true, dailyHandoffTime: '03:00' }
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true, dailyHandoffDue: true }), cfg)
    expect(d.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)).toBe(true)
  })
  it('a busy pane mid-turn on await-handoff still defers at the hard threshold, same as every other trigger', () => {
    // Regression guard: this tier reuses await-handoff wholesale, so it must
    // inherit the existing busy-pane deferral without any new code path.
    const requested = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true }), ARMED)
    const atHardBusy = decideGuard(
      requested.nextState,
      inputs({ pct: 0.99, paneBusy: true }),
      { ...ARMED, enabled: true },
    )
    expect(atHardBusy.action).toBe('none')
    expect(atHardBusy.reason).toContain('mid-turn')
  })
  it('normalizeContextGuardConfig defaults newCardHandoffEnabled to false and only an explicit true arms it', () => {
    expect(normalizeContextGuardConfig({}).newCardHandoffEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ newCardHandoffEnabled: 'true' }).newCardHandoffEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ newCardHandoffEnabled: true }).newCardHandoffEnabled).toBe(true)
  })
})

// CYBERSEC F3 (comment 31757): the flag was missing from the two conditions
// that decide the guard is ARMED at all. Both only showed green on the live
// config because saturationRestart defaults to true, which independently
// keeps those conditions false -- these tests pin the flag alone, with
// saturationRestart explicitly off, so a regression here cannot hide behind
// that default again.
describe('decideGuard -- new-card-dispatch tier must arm the guard on its own (CYBERSEC F3)', () => {
  const NEW_CARD_ONLY: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, newCardHandoffEnabled: true, saturationRestart: false }

  it('idle-phase entry gate: newCardHandoffEnabled alone arms the guard (was: "disabled", never fired)', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true }), NEW_CARD_ONLY)
    expect(d.action).toBe('request-handoff')
  })

  it('await-handoff stand-down gate: newCardHandoffEnabled alone keeps the sequence alive on the next sweep (was: stood down as "guard disabled during await-handoff")', () => {
    const requested = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true }), NEW_CARD_ONLY)
    expect(requested.action).toBe('request-handoff')
    const nextSweep = decideGuard(requested.nextState, inputs(), NEW_CARD_ONLY)
    expect(nextSweep.reason).not.toBe('guard disabled during await-handoff')
    expect(nextSweep.reason).toBe('waiting for handoff')
  })
})

// CYBERSEC F2 (comment 31757): a timeout on this tier used to force-restart a
// healthy, low-context session for the sake of a token saving -- every OTHER
// tier reaching this timeout is acting on a session claimed to be in danger,
// expensive, or a day old, so forcing it there is still a net win; this
// tier's session is none of those.
describe('decideGuard -- new-card-dispatch tier timeout stands down instead of force-restarting (CYBERSEC F2)', () => {
  const ARMED: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, newCardHandoffEnabled: true }

  it('timeout with no handoff written -> cooldown, not restart', () => {
    const requested = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true }), ARMED)
    expect(requested.action).toBe('request-handoff')
    const pastDeadline = decideGuard(
      requested.nextState,
      inputs({ nowMs: requested.nextState.deadlineMs }), // exactly at the recorded deadline
      ARMED,
    )
    expect(pastDeadline.action).not.toBe('restart')
    expect(pastDeadline.nextState.phase).toBe('cooldown')
  })

  it('a DIFFERENT tier (e.g. act threshold) is unaffected -- it still force-restarts on timeout', () => {
    const cfg: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, enabled: true }
    const requested = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.95 }), cfg)
    expect(requested.action).toBe('request-handoff')
    const pastDeadline = decideGuard(
      requested.nextState,
      inputs({ pct: 0.95, nowMs: requested.nextState.deadlineMs }),
      cfg,
    )
    expect(pastDeadline.action).toBe('restart')
  })
})

// CYBERSEC F2: the handoff/resume prompts must name the NEW card, and that
// name must survive the restart into await-ready (carried via GuardState),
// not just exist at request time.
describe('decideGuard -- new-card-dispatch tier carries newCardId/newCardTitle through the restart (CYBERSEC F2)', () => {
  const ARMED: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, newCardHandoffEnabled: true }

  it('handoffRequest records newCardId/newCardTitle from inputs', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true, newCardId: 'card-x', newCardTitle: 'Title X' }), ARMED)
    expect(d.nextState.newCardId).toBe('card-x')
    expect(d.nextState.newCardTitle).toBe('Title X')
  })

  it('survives the handoff-written restart into await-ready', () => {
    const requested = decideGuard(INITIAL_GUARD_STATE, inputs({ newCardDispatchDue: true, newCardId: 'card-x', newCardTitle: 'Title X' }), ARMED)
    const written = decideGuard(
      requested.nextState,
      inputs({ handoffMtime: NOW + 1000, paneIdle: true }),
      ARMED,
    )
    expect(written.action).toBe('restart')
    expect(written.nextState.newCardId).toBe('card-x')
    expect(written.nextState.newCardTitle).toBe('Title X')
    expect(written.nextState.handoffRequestReason).toBe(NEW_CARD_DISPATCH_REASON_PREFIX)
  })

  it('a different tier\'s restart carries null -- never leaks a stale card id into an unrelated sequence', () => {
    const cfg: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, enabled: true }
    const requested = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.95 }), cfg)
    const written = decideGuard(requested.nextState, inputs({ pct: 0.95, handoffMtime: NOW + 1000, paneIdle: true }), cfg)
    expect(written.action).toBe('restart')
    expect(written.nextState.newCardId ?? null).toBe(null)
  })
})

describe('runner wiring -- record advances only at decision time, never on every sweep', () => {
  it('the record is advanced ONLY inside the decision.reason === NEW_CARD_DISPATCH_REASON_PREFIX block, never unconditionally', () => {
    const code = src('src/web/context-guard-runner.ts')
    expect(code).toContain(
      "if (decision.reason === NEW_CARD_DISPATCH_REASON_PREFIX && dispatchedCardIdForGuard !== null) {\n" +
      '    lastDispatchedCard.set(name, dispatchedCardIdForGuard)\n',
    )
    // Pin that this is the ONLY unconditional write site for this map outside
    // the forget branch: a second `.set(` call elsewhere would reintroduce the
    // every-sweep-advances bug this tier was deliberately written to avoid
    // (see forgetNewCardDispatchRecord's doc comment in context-guard.ts).
    expect(code.match(/lastDispatchedCard\.set\(/g)).toHaveLength(1)
  })
  it('the DB read for dispatchedCardIdForGuard happens exactly once per sweep, reused for both the input and the decision-time write', () => {
    const code = src('src/web/context-guard-runner.ts')
    expect(code.match(/getInProgressCardIdForAgent\(name\)/g)).toHaveLength(1)
  })
  it('the new-card-dispatch reason selects its own wording, not the act-tier percentage prompt', () => {
    // Same trap as the idle/daily tiers (see their own pinned tests): pct is
    // null or low for a healthy session about to start a different card, so
    // falling through to handoffPrompt(pctRound ?? 0, ...) would announce a
    // false "~0% -- critical" alarm.
    const code = src('src/web/context-guard-runner.ts')
    expect(code).toContain('newCardDispatchHandoffPrompt(handoffPathFor(name), inputs.newCardId, inputs.newCardTitle)')
    expect(code).toContain('promptReason === NEW_CARD_DISPATCH_REASON_PREFIX')
  })
})
