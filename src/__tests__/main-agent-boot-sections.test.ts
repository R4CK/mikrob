// Every CLAUDE.md section-writer the MAIN agent needs must be called from web.ts's boot block
// (card f27c999b, B-wave 4/6).
//
// WHY THE MAIN AGENT IS THE SPECIAL CASE. Sub-agents get their sections from startAgentProcess, so
// adding a writer there covers them automatically. The main agent never goes through that function
// -- it comes up via channels.sh -- so its ONLY path to a generated section is this boot block. A
// writer added to the per-agent path and not here reaches fourteen agents and misses the one that
// coordinates them, and nothing errors.
//
// That is not hypothetical: ensureSystemDirectiveAuthSection shipped with a startAgentProcess call
// and no boot-block call, so the agent that RECEIVES authenticated system directives (from the
// context-restart gate and channel-monitor) was the one whose CLAUDE.md never described how to
// verify one.
//
// Asserted from the SOURCE rather than by running the boot path, which would start a web server.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB_TS = readFileSync(join(import.meta.dirname, '..', 'web.ts'), 'utf-8')

/** The generated-section writers that must run for MAIN_AGENT_ID at boot. */
const MAIN_AGENT_SECTION_WRITERS = [
  'ensureAutonomySection',
  'ensureSkillsPathTrapSection',
  'ensureSystemDirectiveAuthSection',
]

describe('web.ts boot block writes every main-agent CLAUDE.md section', () => {
  it.each(MAIN_AGENT_SECTION_WRITERS)('calls %s(MAIN_AGENT_ID)', (fn) => {
    expect(WEB_TS).toContain(`${fn}(MAIN_AGENT_ID)`)
  })

  it.each(MAIN_AGENT_SECTION_WRITERS)('imports %s, so the call is not a stray reference', (fn) => {
    expect(WEB_TS).toMatch(new RegExp(`import \\{[^}]*\\b${fn}\\b[^}]*\\} from '\\./web/agent-scaffold\\.js'`))
  })

  it('the three calls sit together, so a fourth writer is added next to them and not somewhere else', () => {
    // Adjacency is the actual defence here. The failure this file exists for is a writer added to
    // the per-agent path and forgotten at boot; keeping the boot calls in one block is what makes
    // the omission visible to the next person editing either side.
    const positions = MAIN_AGENT_SECTION_WRITERS.map((fn) => WEB_TS.indexOf(`${fn}(MAIN_AGENT_ID)`))
    expect(Math.min(...positions)).toBeGreaterThan(0)
    const span = Math.max(...positions) - Math.min(...positions)
    expect(span).toBeLessThan(1200)
  })
})
