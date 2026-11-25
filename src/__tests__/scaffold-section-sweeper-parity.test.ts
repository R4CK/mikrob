// Card 4af036ab: fron-teddy's LIVE agents/fron-teddy/CLAUDE.md (and 6 other live agents --
// jogasz, marketing, penzugy, teszter, videooo, elemzo) are missing several generated sections
// (fleet-auth-rule, evidence-rule, mcp-list-channel-warning, message-close, agent-id-header, and
// others) that other, more-often-restarted agents have.
//
// ROOT CAUSE (src/web/scaffold-section-sweeper.ts:74-87, import list at :40-47): startAgentProcess
// (agent-process.ts:2744-2769) applies FIFTEEN marker-producing section writers to a fresh/restarted
// sub-agent's CLAUDE.md -- verified directly by reading agent-scaffold.ts: each one assembles its
// block from a module-level `const X_BEGIN = '<!-- BEGIN GENERATED: ... -->'` constant, and there
// are exactly 15 non-profile-conditional such constants (plus THIN_CHIEF_BEGIN, see below). The
// periodic sweeper that exists SPECIFICALLY to bring an already-running agent up to date WITHOUT a
// restart (card 75a6fbe6, exactly this failure class) only calls FIVE of them --
// ensureFleetRosterSection, ensureAutonomySection, ensureLocalFirstSection, ensureSkillsPathTrapSection,
// ensureSystemDirectiveAuthSection. The other ten writers were added to agent-process.ts's call list
// over time and never added to the sweeper's, so any agent that has not been manually restarted since
// one of those ten was introduced is stuck missing that section forever -- the 15-minute timer ticks
// but never calls the function that would fix it. This is the SAME bug 75a6fbe6 already fixed once
// (coverage of a control decided by restart luck), reopened by drift between two call lists that
// have to be kept in sync by hand and were not.
//
// MARKER_FUNCTIONS below is the verified list (not re-derived by fragile source parsing -- a regex
// or brace-matcher over this file's own function bodies turned out to both over- and under-match,
// e.g. it picked up ensureProjectRootAnchor via an unrelated nearby constant; a hand-verified list,
// same convention the sibling scaffold-section-sweeper.test.ts already uses, is more trustworthy
// than a clever extractor that silently mismatches). ensureProjectRootInClaudeMd/ensureProjectRootAnchor
// are deliberately excluded: they re-anchor already-baked literal paths, not a marked section (no
// `_BEGIN`/`_END` pair), a different mechanism -- the sweeper already carries ensureProjectRootAnchor
// for its own documented reason (card 8c6f30fb), unrelated to this card.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const AGENT_PROCESS = readFileSync(join(REPO_ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')
const SWEEPER = readFileSync(join(REPO_ROOT, 'src', 'web', 'scaffold-section-sweeper.ts'), 'utf-8')

// Every ensure*Section function in agent-scaffold.ts that assembles a '<!-- BEGIN GENERATED: ... -->'
// block, EXCEPT ensureThinChiefHandoffSection: that one is profile-conditional
// (`if (profileWantsThinChiefHandoff(profile)) ensureThinChiefHandoffSection(name)`) and, per its own
// comment in agent-process.ts, "only appends, and nothing here deletes" -- an opt-in fleet convention,
// not a universal section every agent should have. Propagating it on a 15-minute timer without also
// knowing the agent's profile is a separate design question, deliberately not solved here.
const MARKER_FUNCTIONS = [
  'ensureFleetRosterSection',
  'ensureAutonomySection',
  'ensureLocalFirstSection',
  'ensureSkillsPathTrapSection',
  'ensureSystemDirectiveAuthSection',
  'ensureAgentIdHeaderSection',
  'ensureMemorySearchLabelSection',
  'ensureFleetAuthSection',
  'ensureEvidenceSection',
  'ensureMcpListChannelSection',
  'ensureMessageCloseSection',
  'ensureSkillUsageSection',
  'ensureLanguageSection',
  'ensureMemorySaveSection',
  'ensureDailyLogSection',
]

// Extract the calls inside agent-process.ts's non-main sub-agent provisioning block specifically
// (between the fleet-roster call that opens it and the project-root-anchor call that closes it),
// not the whole file, so an unrelated ensure* call elsewhere (main agent, tests) cannot leak in.
const subAgentBlockStart = AGENT_PROCESS.indexOf('ensureFleetRosterSection(name)')
const subAgentBlockEnd = AGENT_PROCESS.indexOf('ensureProjectRootAnchor(name)', subAgentBlockStart) + 'ensureProjectRootAnchor(name)'.length

describe('scaffold-section sweeper covers every marker-producing writer that agent start applies (card 4af036ab)', () => {
  it('sanity: found the sub-agent provisioning block in agent-process.ts', () => {
    expect(subAgentBlockStart, 'ensureFleetRosterSection(name) not found').toBeGreaterThan(-1)
    expect(subAgentBlockEnd, 'ensureProjectRootAnchor(name) not found after it').toBeGreaterThan(subAgentBlockStart)
  })

  const SUB_AGENT_BLOCK = AGENT_PROCESS.slice(subAgentBlockStart, subAgentBlockEnd)

  it('sanity: every MARKER_FUNCTIONS entry really is called at sub-agent start (the list is not stale)', () => {
    const notCalledAtStart = MARKER_FUNCTIONS.filter((fn) => !new RegExp(`\\b${fn}\\(name\\)`).test(SUB_AGENT_BLOCK))
    expect(notCalledAtStart, 'MARKER_FUNCTIONS claims a writer that start time does not actually call').toEqual([])
  })

  // The sweeper's per-agent loop: from its `for (const name of listAgentNames())` to the function end.
  const loopStart = SWEEPER.indexOf('for (const name of listAgentNames())')
  const loopEnd = SWEEPER.indexOf('\n}', loopStart)

  it('sanity: found the sweeper per-agent loop', () => {
    expect(loopStart).toBeGreaterThan(-1)
    expect(loopEnd).toBeGreaterThan(loopStart)
  })

  const SWEEP_LOOP = SWEEPER.slice(loopStart, loopEnd)

  it('names every writer missing from the sweep loop (this is the drift this card fixes)', () => {
    const missing = MARKER_FUNCTIONS.filter((fn) => !new RegExp(`\\b${fn}\\(name\\)`).test(SWEEP_LOOP)).sort()
    expect(
      missing,
      'these writers run when a sub-agent STARTS but are never re-applied by the periodic sweep, so ' +
        'a long-lived agent that started before one of them existed stays missing that section forever ' +
        '(exactly the restart-luck failure card 75a6fbe6 already fixed once, for a different writer set)',
    ).toEqual([])
  })
})
