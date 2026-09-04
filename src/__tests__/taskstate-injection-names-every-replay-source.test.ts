// The replayed sentence must describe every situation that can trigger it (card 272361eb, B-wave).
//
// THE DRIFT THIS PINS, and this file has already suffered it twice. REPLAY_SOURCES holds four
// sources; the sentence the agent actually READS listed three. 'clear' has been a replay source on
// both fork and upstream since card 1ce3fd90, and CLAUDE.md rule 14 makes /clear the ROUTINE way an
// agent moves between cards -- so the most common replay was described to the agent as "tomorites,
// resume vagy osszeomlas", none of which happened to it. A reader who trusts the sentence concludes
// the block is not about them.
//
// agent-taskstate.ts's own comment names the pattern: "A copy is exactly how the two halves drifted
// apart twice: 'startup' was added here in 2026-07 and the matcher was left behind." That was fixed
// by EXPORTING the set so the matcher compares against it. The sentence is the third copy, and prose
// cannot import a Set -- so it gets a test instead.
//
// DELIBERATELY NOT a string-equality pin: the wording is allowed to change, the COVERAGE is not.
import { describe, it, expect } from 'vitest'
import { REPLAY_SOURCES, buildTaskStateInjection, type AgentTaskState } from '../web/agent-taskstate.js'

/** How each replay source is expected to appear in the Hungarian sentence the agent reads. */
const WORDING: Readonly<Record<string, string>> = {
  compact: 'tomorites',
  resume: 'resume',
  clear: '/clear',
  startup: 'osszeomlas', // a crash respawn arrives as source=startup
}

const RECORD: AgentTaskState = {
  agent: 'backend2',
  summary: 'egy folyamatban levo feladat',
  doneSteps: ['elso lepes'],
  alreadyDelegated: [],
  nextAction: 'masodik lepes',
  pendingDecision: '',
  ts: Date.now(),
  consumed: false,
}

describe('the task-state injection describes every source that can replay it', () => {
  const text = buildTaskStateInjection(RECORD)

  it('has a wording entry for every REPLAY_SOURCES member -- a new source fails HERE', () => {
    // Adding a source without deciding how the agent should hear about it is the defect; this
    // catches it at the set, before the sentence is even examined.
    expect([...REPLAY_SOURCES].sort()).toEqual(Object.keys(WORDING).sort())
  })

  it.each([...REPLAY_SOURCES])('the injected text names the %s case', (source) => {
    const needle = WORDING[source as string]
    expect(needle, `no wording recorded for source '${source}'`).toBeTruthy()
    expect(text).toContain(needle as string)
  })

  it('still says what it is FOR -- the pin must not reduce to a keyword check', () => {
    expect(text).toContain('NEM uj feladat')
    expect(text).toContain('FOLYTASD')
    expect(text).toContain(RECORD.summary)
  })
})
