// The stuck-incident WRITER (card 878cd292, parent f92671df).
//
// What these pin, and why each is here rather than being obvious:
//   - EVERY guard verdict is classified, taken from the script's own echo sites. The heartbeat prose
//     documented six; building from it would have left branches permanently unlogged -- the very
//     "a deliberate non-action leaves no trace" hole this table exists to close, reproduced inside
//     its own fix. The set was NINE when measured and became TEN the same afternoon (ledger-busy,
//     card 09a3d52a), which is why the classifier stores an unrecognised reason instead of dropping
//     it, and why these tests assert BEHAVIOUR per shape rather than a count.
//   - THE REASON IS A PREFIX READ, never an equality test. Three verdicts carry a parenthesised
//     payload, and the script's own header comment gets the separator wrong, so a hand-kept list
//     would drift against a script this repo does not own.
//   - `usage` / `card-not-found` are CALLING ERRORS and must NOT become rows: folding our own bad
//     calls into "how often did the system decide not to intervene" would corrupt the number the
//     table exists to produce.
//   - ONE STALL IS ONE ROW: the D section runs every 10 minutes, so without the redetect path an
//     hour-long stall becomes six "incidents" and the repeat count measures heartbeat frequency.
//   - LOGGING IS NOT THE CONTROL: a write fault must be survivable, never thrown at the caller.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyStuckVerdict,
  recordStuckIncident,
  initDatabase,
  getDb,
} from '../db.js'

const tmpDirs: string[] = []
function freshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-writer-'))
  tmpDirs.push(dir)
  initDatabase(join(dir, 'test.db'))
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

const detect = (over: Partial<Parameters<typeof recordStuckIncident>[0]> = {}) =>
  recordStuckIncident({
    cardId: 'c1',
    assignee: 'backend3',
    verdict: 'DENY:agent-busy',
    detectedAt: 1_700_000_000,
    stalledMs: 900_000,
    ...over,
  })

describe('classifyStuckVerdict -- all NINE verdicts, from the script echo sites', () => {
  // The six the heartbeat prose used to list, plus load-paused, which it omitted and which IS a
  // real policy denial (the agent is cgroup-throttled or SIGSTOP-frozen).
  it.each([
    ['DENY:not-active(done)', 'none_denied'],
    ['DENY:load-paused', 'none_denied'],
    ['DENY:progress', 'none_denied'],
    ['DENY:agent-busy', 'none_denied'],
    ['DENY:cap-reached(3)', 'none_denied'],
    ['DENY:backoff(1200s)', 'none_denied'],
    ['DENY:first-seen-baseline', 'none_denied'],
  ])('%s is a recorded decision', (verdict, action) => {
    const c = classifyStuckVerdict(verdict as string)
    expect(c, verdict as string).not.toHaveProperty('skip')
    expect((c as { action: string }).action).toBe(action)
  })

  it('ALLOW is the redispatch case', () => {
    expect(classifyStuckVerdict('ALLOW')).toEqual({ action: 'redispatch', detail: null })
  })

  it.each([['DENY:usage'], ['DENY:card-not-found']])(
    '%s is a CALLING ERROR and is NOT stored',
    (verdict) => {
      const c = classifyStuckVerdict(verdict as string)
      expect(c).toHaveProperty('skip')
      // The reason is carried, so a caller can tell "nothing to log" from "logging broke".
      expect((c as { skip: string }).skip).toMatch(/calling error/)
    },
  )

  it('keeps the verdict VERBATIM, payload included -- the detail is the evidence', () => {
    // If this stored a normalised reason instead, the operator would lose the number that says HOW
    // LONG the backoff was, which is the whole content of that verdict.
    expect(classifyStuckVerdict('DENY:backoff(1200s)')).toEqual({
      action: 'none_denied',
      detail: 'DENY:backoff(1200s)',
    })
  })

  it('ledger-busy is "could not evaluate" -- recorded, but NOT as a denial', () => {
    // The third kind, and it appeared DURING this card (guard card 09a3d52a added the lock). The
    // guard was asked and could not answer, so counting it as a denial would inflate "how often did
    // the system decide not to intervene" with occasions where nothing was decided -- one step
    // milder than the calling errors, which are excluded entirely. Dropping it would hide real lock
    // contention, which is exactly what this table should be able to show.
    expect(classifyStuckVerdict('DENY:ledger-busy')).toEqual({
      action: 'none_other',
      detail: 'DENY:ledger-busy',
    })
  })

  it('an UNKNOWN deny reason is still recorded, not dropped', () => {
    // The guard may grow reasons. Dropping an unrecognised one would be the same silent gap as the
    // three the prose omitted.
    const c = classifyStuckVerdict('DENY:some-future-reason')
    expect(c).not.toHaveProperty('skip')
    expect((c as { detail: string }).detail).toBe('DENY:some-future-reason')
  })

  it('PREFIX, not equality: a payload on a KNOWN reason does not make it unknown', () => {
    for (const v of ['DENY:cap-reached(3)', 'DENY:not-active(waiting)', 'DENY:backoff(600s)']) {
      expect(classifyStuckVerdict(v), v).not.toHaveProperty('skip')
    }
  })

  it('PREFIX, discriminating: a CALLING ERROR with a payload is still a calling error', () => {
    // THIS is the case that actually pins the prefix read, and the case above does not -- I measured
    // that. Replacing `rest.split(/[(:]/)[0]` with the whole string leaves every assertion above
    // green, because the only reasons the classifier matches by name (usage, card-not-found) carry
    // no payload TODAY. The mutant behaves identically on the current verdict set, so it survives.
    //
    // The property is still real and worth holding: the guard already grew payloads on three
    // reasons, and the two calling errors are the ones whose misclassification is worst -- storing
    // them would fold our own bad calls into "how often did the system decide not to intervene".
    // These shapes make the whole-string version fail, so the prefix read is load-bearing again.
    for (const v of ['DENY:usage(2)', 'DENY:card-not-found(c1)', 'DENY:usage:missing-agent']) {
      const c = classifyStuckVerdict(v)
      expect(c, v).toHaveProperty('skip')
      expect((c as { skip: string }).skip, v).toMatch(/calling error/)
    }
  })

  it('a verdict that is neither ALLOW nor DENY: is skipped with its reason', () => {
    expect(classifyStuckVerdict('garbage')).toHaveProperty('skip')
  })
})

describe('recordStuckIncident -- ONE STALL IS ONE ROW', () => {
  it('the first detection opens a row', () => {
    freshDb()
    const r = detect()
    expect(r.kind).toBe('opened')
    const row = getDb().prepare(`SELECT * FROM stuck_incidents`).get() as Record<string, unknown>
    expect(row['card_id']).toBe('c1')
    expect(row['assignee_at_detection']).toBe('backend3')
    expect(row['action']).toBe('none_denied')
    expect(row['action_detail']).toBe('DENY:agent-busy')
    expect(row['detections']).toBe(1)
  })

  it('re-detecting the SAME stall bumps detections instead of inserting', () => {
    freshDb()
    detect()
    const r = detect({ detectedAt: 1_700_000_600 })
    expect(r.kind).toBe('redetected')
    expect((r as { detections: number }).detections).toBe(2)
    expect(getDb().prepare(`SELECT COUNT(*) c FROM stuck_incidents`).get()).toEqual({ c: 1 })
  })

  it('six re-detections (one hour of heartbeats) are ONE incident, not six', () => {
    // The number this protects: without it, "how often did this card get stuck" would report the
    // heartbeat frequency.
    freshDb()
    for (let i = 0; i < 6; i++) detect({ detectedAt: 1_700_000_000 + i * 600 })
    expect(getDb().prepare(`SELECT COUNT(*) c FROM stuck_incidents`).get()).toEqual({ c: 1 })
    expect(getDb().prepare(`SELECT detections d FROM stuck_incidents`).get()).toEqual({ d: 6 })
  })

  it('once RESOLVED, a new stall opens a NEW incident', () => {
    // The negative control for the case above: if dedup were per-card rather than per-OPEN-incident,
    // a card could only ever be stuck once and the repeat question would be unanswerable.
    freshDb()
    detect()
    getDb().prepare(`UPDATE stuck_incidents SET resolved_at = ? WHERE id = 1`).run(1_700_000_500)
    expect(detect({ detectedAt: 1_700_001_000 }).kind).toBe('opened')
    expect(getDb().prepare(`SELECT COUNT(*) c FROM stuck_incidents`).get()).toEqual({ c: 2 })
  })

  it('different cards each get their own open incident', () => {
    freshDb()
    detect({ cardId: 'a' })
    detect({ cardId: 'b' })
    expect(getDb().prepare(`SELECT COUNT(*) c FROM stuck_incidents`).get()).toEqual({ c: 2 })
  })
})

describe('recordStuckIncident -- the calling errors never become rows', () => {
  it.each([['DENY:usage'], ['DENY:card-not-found']])('%s writes nothing', (verdict) => {
    freshDb()
    const r = detect({ verdict: verdict as string })
    expect(r.kind).toBe('skipped')
    expect(getDb().prepare(`SELECT COUNT(*) c FROM stuck_incidents`).get()).toEqual({ c: 0 })
  })

  it('CONTROL: load-paused, which the old prose also omitted, DOES write', () => {
    // Without this control the case above would pass equally well for a writer that stored nothing
    // at all, or one that dropped every reason missing from the six-item prose.
    freshDb()
    expect(detect({ verdict: 'DENY:load-paused' }).kind).toBe('opened')
    expect(getDb().prepare(`SELECT COUNT(*) c FROM stuck_incidents`).get()).toEqual({ c: 1 })
  })
})

describe('recordStuckIncident -- logging is NOT the control', () => {
  it('a broken store does NOT throw -- it reports skipped with the reason', () => {
    // The invariant: a logging fault must never change what the guard decided or what it returns.
    // Simulated by dropping the table, which is also the rollback path tested on the schema card.
    freshDb()
    getDb().exec(`DROP TABLE stuck_incidents`)
    let r: ReturnType<typeof recordStuckIncident> | undefined
    expect(() => {
      r = detect()
    }).not.toThrow()
    expect(r!.kind).toBe('skipped')
    expect((r as { reason: string }).reason).toMatch(/write failed/)
  })

  it('the skip reason distinguishes "nothing to log" from "logging broke"', () => {
    // Both are `skipped`, and conflating them would make a broken writer look like a quiet one --
    // the same absent-versus-zero distinction the schema comment makes about proof counts.
    freshDb()
    const nothingToLog = detect({ verdict: 'DENY:usage' })
    getDb().exec(`DROP TABLE stuck_incidents`)
    const broken = detect()
    expect((nothingToLog as { reason: string }).reason).toMatch(/calling error/)
    expect((broken as { reason: string }).reason).toMatch(/write failed/)
  })
})
