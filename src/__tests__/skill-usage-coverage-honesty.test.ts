// The skill_usage signal must not be presented as if it saw everything (card a10ecfe3).
//
// THE MEASUREMENT BEHIND THIS FILE (this fleet's own install, 2026-09-11): 152 skills on disk, 12
// with any usage row. All ten skills backend2's CLAUDE.md designates as its CORE set have ZERO
// rows while governing every card it shipped that week. 25 of 30 rows belong to mikrob, the one
// agent that calls the `Skill` tool explicitly.
//
// The card that opened this asked for the opposite problem -- "the table is empty, so the
// dream-engine cannot suggest antiquated skills". By the time it was picked up the table had rows,
// and that turned out to be the more dangerous state: with a biased sample the bucket CAN now make
// an "unused -> antiquate" suggestion, and on this data it would fire on 140 of 152 skills.
//
// So the thing worth pinning is not row count. It is that the payload keeps saying what it cannot
// see, right next to the numbers, where a prompt-shaped consumer cannot skip it.
import { describe, expect, it } from 'vitest'
import { SKILL_USAGE_COVERAGE } from '../db.js'

describe('SKILL_USAGE_COVERAGE (card a10ecfe3)', () => {
  it('states outright that a zero row count does NOT mean the skill is unused', () => {
    // The single load-bearing assertion. If this ever flips to true, the destructive inference is
    // sanctioned and the whole point of this constant is gone.
    expect(SKILL_USAGE_COVERAGE.zeroRowsMeansUnused).toBe(false)
  })

  it('names what it observes, and both entries are the two real hook paths', () => {
    expect(SKILL_USAGE_COVERAGE.observes).toHaveLength(2)
    expect(SKILL_USAGE_COVERAGE.observes.join(' ')).toMatch(/tool_call/)
    expect(SKILL_USAGE_COVERAGE.observes.join(' ')).toMatch(/skill_read/)
  })

  it('names the blind spot, and it is the context-loaded path', () => {
    // The specific gap, not a vague hedge: a skill already in context leaves no tool event.
    expect(SKILL_USAGE_COVERAGE.blindTo).toMatch(/context|CLAUDE\.md|trigger/i)
    expect(SKILL_USAGE_COVERAGE.blindTo.length).toBeGreaterThan(40)
  })

  it('names the decision it must not be used for', () => {
    expect(SKILL_USAGE_COVERAGE.doNotUseFor).toMatch(/unused|antiquat|delete/i)
  })

  it('the two hook trigger_type values it claims to observe are the ONLY ones the schema allows', () => {
    // Pins the premise: if a third trigger_type were added and the coverage text not updated, the
    // statement above would silently become incomplete rather than wrong-and-caught.
    const observed = SKILL_USAGE_COVERAGE.observes.join(' ')
    for (const t of ['tool_call', 'skill_read']) expect(observed).toContain(t)
  })
})
