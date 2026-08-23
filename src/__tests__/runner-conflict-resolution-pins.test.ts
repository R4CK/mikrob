// Card 6cd3b6af: the accepted per-hunk resolutions for the two runners had no test coverage in
// EITHER direction (Cybersec on the bc898166 gate, comment 14819).
//
// WHAT THE EXISTING GUARD DOES AND DOES NOT DO. fork-upstream-conflict-guard.test.ts asks whether a
// conflicting file has a recorded decision, and (since card a1d613e3) whether that decision was read
// against today's upstream blob. Neither question is "was the decision FOLLOWED". So a merge that
// takes upstream's side wholesale on model-fallback-runner.ts -- dropping the fork's weekly-tier
// axis, its durable-baseline bookkeeping and its parked-agent path, all of which upstream's simpler
// action.kind form has no equivalent for -- would pass that guard cleanly. The properties the
// resolution promises to KEEP are what this file pins.
//
// Source-level pins, like agent-lifecycle-lock.test.ts's wiring block, and for the same reason:
// exercising these sweeps would drive tmux and the live config store, so a mock deep enough to run
// them would be asserting against my own model of them rather than against the resolution.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(HERE, '..', rel), 'utf-8')

const AUTO_RESTART = read('web/auto-restart-runner.ts')
const MODEL_FALLBACK = read('web/model-fallback-runner.ts')
const GUARD_TEST = readFileSync(join(HERE, 'fork-upstream-conflict-guard.test.ts'), 'utf-8')

/** Comment lines are stripped before matching: a rule that survives only in prose is exactly the
 *  state this card is about. Every assertion below runs against executable text. */
const exec = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const AUTO_RESTART_EXEC = exec(AUTO_RESTART)
const MODEL_FALLBACK_EXEC = exec(MODEL_FALLBACK)

describe('the acknowledged resolutions still exist to be followed', () => {
  // If somebody removes these entries, the pins below would guard a decision nobody is making any
  // more -- passing tests describing a rule that is gone. Cheap, and it fails loudly.
  it.each(['src/web/auto-restart-runner.ts', 'src/web/model-fallback-runner.ts'])(
    '%s is still a recorded conflict resolution',
    (file) => {
      // BOTH maps, counted: the rule text lives in ACKNOWLEDGED_CONFLICTS and the upstream blob it
      // was read against lives in ACKNOWLEDGED_UPSTREAM_BLOBS. Accepting either one would let a
      // rule be deleted while its stale-sha entry kept this pin green.
      const hits = GUARD_TEST.split(`'${file}':`).length - 1
      expect(
        hits,
        `${file} appears ${hits} time(s) in the conflict guard, expected 2 (the rule and its ` +
          'recorded upstream blob). Either it stopped conflicting -- delete this pin with it -- or ' +
          'half the decision was dropped.',
      ).toBe(2)
    },
  )
})

describe('auto-restart-runner: the sweep body the resolution keeps verbatim (card 6cd3b6af)', () => {
  // The recorded rule is "adopt upstream tickRunning re-entrancy guard ... keeping the fork sweep
  // body verbatim inside the try/finally". Upstream owns the guard; the fork owns the body. Both
  // halves are asserted, in the one form that stays true on BOTH sides of the merge.
  const sweepAt = AUTO_RESTART_EXEC.indexOf('async function sweep()')

  it('ANTI-VACUITY: the sweep is actually found, so the assertions below are about something', () => {
    // Without this, a rename would make every match below vacuously pass on an empty slice.
    expect(sweepAt, 'no sweep function in auto-restart-runner.ts -- the pins below mean nothing').toBeGreaterThan(-1)
  })

  const sweep = AUTO_RESTART_EXEC.slice(sweepAt, AUTO_RESTART_EXEC.indexOf('\n  }', sweepAt))

  it('the main session is checked first, guarded so one failure cannot end the sweep', () => {
    expect(sweep).toMatch(/try \{ await checkAgent\(MAIN_AGENT_ID, now\) \} catch/)
  })

  it('every agent is swept, each in its own try/catch', () => {
    expect(sweep).toContain('for (const name of listAgentNames())')
    expect(sweep).toMatch(/try \{ await checkAgent\(name, now\) \} catch/)
  })

  it('overlap protection is EITHER absent (the measured pre-merge state) or upstream tickRunning', () => {
    // The rule rests on a measurement: "the fork sweep has NO overlap protection of any kind, so
    // this is something upstream HAS and the fork LACKS, not a duplicate". The failure this catches
    // is a hand-rolled fork guard growing in between -- at which point the recorded resolution
    // ("adopt upstream's") silently stops describing the file, and the merge would end up with two.
    const guards = AUTO_RESTART_EXEC.match(/\b\w*[Rr]unning\s*=\s*(true|false)/g) ?? []
    const usesUpstreamGuard = AUTO_RESTART_EXEC.includes('tickRunning')
    if (usesUpstreamGuard) {
      // Post-merge: the body must be inside the try/finally, or a thrown sweep wedges the runner
      // for good -- the flag would never be cleared.
      expect(AUTO_RESTART_EXEC, 'tickRunning is set but never released in a finally').toMatch(
        /finally \{[\s\S]{0,200}tickRunning = false/,
      )
    } else {
      expect(
        guards,
        `auto-restart-runner grew its own overlap guard (${guards.join(', ')}). The recorded ` +
          'resolution says to adopt upstream\'s tickRunning because the fork has none -- re-read ' +
          'both sides and rewrite the rule before the next merge, or the file ends up with two.',
      ).toEqual([])
    }
  })
})

describe('model-fallback-runner: the fork superset the resolution keeps (card 6cd3b6af)', () => {
  // Hunks 1-2 of the recorded rule: "keep the fork weekly-tier structure + durable-baseline
  // bookkeeping + parked-agent path (upstream has no equivalent)". Each clause gets its own
  // assertion, so a failure names WHICH half of the resolution was dropped rather than just
  // reporting that the file changed.
  it('the weekly-tier axis survives -- it is a whole axis upstream does not have', () => {
    expect(MODEL_FALLBACK_EXEC).toContain('weeklyTierIndex(')
    expect(MODEL_FALLBACK_EXEC, 'the fleet-global weekly tier is gone').toMatch(/weeklyTier\s*=/)
  })

  it('durable-baseline bookkeeping survives: a park/start cycle must not undo a downgrade', () => {
    // recordBaselineIfAbsent stores what the agent STARTED on, so a revert goes back to that and
    // not to whatever the ladder happens to say. Without it the runner cannot tell "already cheap
    // by its own banner axis" from "cheap because we put it there".
    expect(MODEL_FALLBACK_EXEC).toContain('recordBaselineIfAbsent(')
    expect(MODEL_FALLBACK_EXEC).toContain('clearBaseline(')
  })

  it('the parked-agent path survives -- upstream has no equivalent for it at all', () => {
    // The CALL, not the definition. Measured: asserting the name alone passed with the call site
    // deleted, because the (now dead) function still declares it. A parked-agent path that nothing
    // reaches is the same loss as one that was removed, and harder to notice.
    const at = MODEL_FALLBACK_EXEC.indexOf('async function checkAgent(')
    expect(at, 'checkAgent not found -- the assertion below would be vacuous').toBeGreaterThan(-1)
    const checkAgent = MODEL_FALLBACK_EXEC.slice(at, MODEL_FALLBACK_EXEC.indexOf('\n}', at))
    expect(checkAgent, 'checkAgent no longer routes parked agents anywhere')
      .toContain('updateStoredModelForParkedAgent(name, weeklyIdx)')
  })

  it('"cheaper tier wins" survives: of banner and weekly, the one FURTHER down the ladder', () => {
    // Direction matters more than presence here. Flipping the comparison would leave the function,
    // the name and every caller intact while writing agents back UP to the more expensive model --
    // the exact undo the rule calls out.
    expect(MODEL_FALLBACK_EXEC).toMatch(
      /return ladderIndexOf\(weekly\) >= ladderIndexOf\(banner\) \? weekly : banner/,
    )
  })

  it("checkAgent keeps the fork's own parameter list, which upstream's action.kind form drops", () => {
    // The rule names this explicitly: "checkAgent's own parameter list differs accordingly". It is
    // the seam where taking upstream's side wholesale would be least visible.
    expect(MODEL_FALLBACK_EXEC).toMatch(
      /async function checkAgent\(name: string, nowMs: number, cfg: ModelFallbackConfig, weeklyIdx: number\)/,
    )
  })

  it('the same overlap rule as its sibling: absent, or upstream tickRunning released in a finally', () => {
    const guards = MODEL_FALLBACK_EXEC.match(/\b\w*[Rr]unning\s*=\s*(true|false)/g) ?? []
    if (MODEL_FALLBACK_EXEC.includes('tickRunning')) {
      expect(MODEL_FALLBACK_EXEC).toMatch(/finally \{[\s\S]{0,200}tickRunning = false/)
    } else {
      expect(
        guards,
        `model-fallback-runner grew its own overlap guard (${guards.join(', ')}); the recorded ` +
          'resolution assumes it has none. Re-read both sides before the next merge.',
      ).toEqual([])
    }
  })
})
