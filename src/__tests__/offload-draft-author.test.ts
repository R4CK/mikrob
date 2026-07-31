// Card 3307b428 (Cybersec finding alongside the 6f8bba54 GO). The dispatch-time local-LLM offload
// posted its 7B draft to the kanban card as author="mikrob". The DRAFT-ONLY warning was in the body,
// but the AUTHOR field said orchestrator -- and the gate sweeps are author-keyed: they treat
// author=='mikrob' + a keyword (DONE / BLOKKOLVA / KOTOTT) as an orchestrator directive and drop the
// card from the sweep. Measured on the live board: 27 such drafts, 8 carrying a trigger word, 1 posted
// AFTER a REVIEW -- the exact ordering that silently ejects a card from its gate.
//
// Source-level assertions on purpose (same reasoning as repomix-wrapper-guard.test.ts): the realistic
// regression is someone editing the script or "tidying" a deny-list, not a runtime fault. Actually
// posting a comment would need a live dashboard + a loaded 7B; grepping catches the omission directly
// and runs everywhere.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

/** The one author every locally-drafted comment must be signed with. */
const DRAFT_AUTHOR = 'local-llm'

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

const DISPATCH = read('store/offload-dispatch.sh')
const CYBERSEC_SCAN = read('store/cybersec-gate-scan.py')

/** The TRACKED gate-scan recipe. This is the reseed source, so a fix that lands only in a live
 *  per-agent copy (`agents/*` -- gitignored runtime, absent in a fresh checkout) is undone by the next
 *  reseed. The live copies are patched too, but only this one can be asserted everywhere. */
const GATE_SCAN_SEED = 'seed-fleet-agents/cybered/.claude/skills/kanban-gate-scan/SKILL.md'

/** Runtime copy: present on an installed fleet, absent in CI. Checked only when it exists, so the
 *  test cannot pass vacuously on a machine that HAS it and drifted. */
const GATE_SCAN_LIVE = 'agents/cybered/.claude/skills/kanban-gate-scan/SKILL.md'

describe('store/offload-dispatch.sh -- a local draft is never signed as the orchestrator', () => {
  it('posts the draft comment under the distinct draft author', () => {
    expect(DISPATCH).toContain(`DRAFT_AUTHOR="${DRAFT_AUTHOR}"`)
  })

  it('does NOT hardcode any author in the comment POST payload', () => {
    // The regression is a literal author sneaking back into the JSON body.
    const post = DISPATCH.slice(DISPATCH.indexOf('/api/kanban/$CARD/comments'))
    expect(post).toContain('"author":sys.argv[1]')
    expect(post).not.toMatch(/"author"\s*:\s*"[^"]+"/)
  })

  it('never posts as mikrob -- the whole point of the card', () => {
    const post = DISPATCH.slice(DISPATCH.indexOf('/api/kanban/$CARD/comments'))
    expect(post).not.toContain('"mikrob"')
  })

  it('does not pick a draft author that PREFIX-matches an agent identity', () => {
    // Consumers match identity by prefix too (is_cybersec_verdict uses startswith('cybersec')), so a
    // name like "mikrob-offload" would recreate the confusion one string-compare later.
    for (const agent of ['mikrob', 'cybersec', 'cybered', 'qa', 'backend', 'fron-ted']) {
      expect(DRAFT_AUTHOR.startsWith(agent)).toBe(false)
    }
  })
})

describe('gate sweeps -- a draft is neither a REVIEW nor an orchestrator directive', () => {
  it('cybersec-gate-scan deny-lists the draft author for REVIEW detection', () => {
    expect(CYBERSEC_SCAN).toContain(`if author == '${DRAFT_AUTHOR}':`)
  })

  it('cybersec-gate-scan KEEPS the content-based guard for the historical drafts', () => {
    // The 27 drafts already in the database are still stored under author='mikrob'. Dropping this
    // guard because "the author is fixed now" would re-open the bug for every existing row.
    expect(CYBERSEC_SCAN).toContain("'LOCAL-LLM DRAFT' in content")
  })

  it('the reseed source of the gate-scan recipe deny-lists the draft author', () => {
    expect(read(GATE_SCAN_SEED)).toContain(`'mikrob', 'qa', 'qa2', '${DRAFT_AUTHOR}'`)
  })

  it('the installed per-agent copy has not drifted from it (skipped when absent, e.g. CI)', () => {
    const live = join(REPO_ROOT, GATE_SCAN_LIVE)
    if (!existsSync(live)) return
    expect(readFileSync(live, 'utf8')).toContain(`'mikrob', 'qa', 'qa2', '${DRAFT_AUTHOR}'`)
  })
})
