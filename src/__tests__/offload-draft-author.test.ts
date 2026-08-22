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
import { execFileSync } from 'node:child_process'
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
    // 'mikrob' left this flat tuple as of card af580149 (kanban-gate-scan.md rewrite): MikroB's
    // OWN self-work REVIEWs must still reach a gate (rule 4, no self-review), so a blanket
    // author=='mikrob' exclusion was replaced with a conditional self-work-marker check just below
    // this line. DRAFT_AUTHOR ('local-llm') stays flatly excluded either way -- a draft is never a
    // gate request, full stop, which is the one property this test owns.
    expect(read(GATE_SCAN_SEED)).toContain(`'qa', 'qa2', '${DRAFT_AUTHOR}'`)
  })

  it('the installed per-agent copy has not drifted from it (skipped when absent, e.g. CI)', () => {
    const live = join(REPO_ROOT, GATE_SCAN_LIVE)
    if (!existsSync(live)) return
    expect(readFileSync(live, 'utf8')).toContain(`'qa', 'qa2', '${DRAFT_AUTHOR}'`)
  })
})

// --- BEHAVIOURAL half (Cybersec NO-GO F1/F2/F3 on 672001b) --------------------------------------
//
// The assertions above pin the SHAPE of the fix; these run the actual Python and pin its BEHAVIOUR.
// That distinction earned its place here: 672001b patched `is_gate_review` in the skill and left
// `mikrob_blocked` -- the OTHER door out of the same sweep -- untouched, and a grep-only test happily
// passed while an open card (e7d530a9) was being falsely blocked on the live board.
//
// Both scanners are Python, so the tests drive python3 the way the hook tests already do.

/** Run a Python snippet and return its stdout, trimmed. */
function py(source: string): string {
  return execFileSync('python3', ['-c', source], { encoding: 'utf-8' }).trim()
}

/** Load `mikrob_marker` out of the real scanner and report its verdict for one comment. */
function markerVerdict(content: string, author = 'mikrob'): boolean {
  const out = py(`
import importlib.util, json
spec = importlib.util.spec_from_file_location('scan', ${JSON.stringify(join(REPO_ROOT, 'store/cybersec-gate-scan.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.mikrob_marker({'author': ${JSON.stringify(author)}, 'content': ${JSON.stringify(content)}}, ('DONE',))))
`)
  return JSON.parse(out) as boolean
}

/** Extract `mikrob_blocked` from a gate-scan SKILL recipe and report its verdict.
 *  Only the marker/function section is executed -- the recipe's prologue reads a live token. */
function blockedVerdict(skillPath: string, content: string, author = 'mikrob'): boolean {
  const out = py(`
import io, json
src = io.open(${JSON.stringify(skillPath)}, encoding='utf-8').read()
block = src.split('\u0060\u0060\u0060python', 1)[1].split('\u0060\u0060\u0060', 1)[0]
snippet = 'import re' + chr(10) + block[block.index('BLOCKED_MARKERS'):block.index('needs = []')]
ns = {}
exec(compile(snippet, 'skill', 'exec'), ns)
print(json.dumps(ns['mikrob_blocked']([{'author': ${JSON.stringify(author)}, 'content': ${JSON.stringify(content)}}])))
`)
  return JSON.parse(out) as boolean
}

/** The BLOCKED_MARKERS tuple a given SKILL copy actually declares. */
function blockedMarkers(skillPath: string): string[] {
  const out = py(`
import io, json
src = io.open(${JSON.stringify('SKILL_PATH')}, encoding='utf-8').read()
block = src.split('\u0060\u0060\u0060python', 1)[1].split('\u0060\u0060\u0060', 1)[0]
snippet = 'import re' + chr(10) + block[block.index('BLOCKED_MARKERS'):block.index('def _marker_re')]
ns = {}
exec(compile(snippet, 'skill', 'exec'), ns)
print(json.dumps(list(ns['BLOCKED_MARKERS'])))
`.replace('"SKILL_PATH"', JSON.stringify(skillPath)))
  return JSON.parse(out) as string[]
}

const DRAFT_PREFIX = '[LOCAL-LLM DRAFT | dispatch-offload] '

describe('cybersec-gate-scan mikrob_marker -- F3: first line, word-bounded', () => {
  it('a REAL close still counts', () => {
    expect(markerVerdict('DONE -- QA PASS + Cybersec GO\nzarom a kartyat.')).toBe(true)
  })

  it('the tiering SENTENCE mid-comment does NOT close the card', () => {
    // "DONE only after QA PASS + Cybersec GO" is a REQUEST for gating. Matching the whole body read
    // it as the opposite of what it says.
    expect(markerVerdict('Risk-tiering: QA + Cybersec.\nDONE csak QA PASS + Cybersec GO')).toBe(false)
  })

  it('DONE hiding inside ABANDONED is not a close', () => {
    expect(markerVerdict('ABANDONED approach, uj iranyt viszunk')).toBe(false)
  })

  it('a historical draft still cannot close a card, even on its first line', () => {
    expect(markerVerdict(`${DRAFT_PREFIX}DONE\nkesz`)).toBe(false)
  })

  it('a non-orchestrator author is never a directive', () => {
    expect(markerVerdict('DONE -- zarom', 'backend2')).toBe(false)
  })
})

describe.each([
  ['reseed source', join(REPO_ROOT, GATE_SCAN_SEED)],
  ...(existsSync(join(REPO_ROOT, GATE_SCAN_LIVE))
    ? ([['installed copy', join(REPO_ROOT, GATE_SCAN_LIVE)]] as [string, string][])
    : []),
])('gate-scan skill mikrob_blocked (%s) -- F1 + F2', (_label, skillPath) => {
  it('a historical draft carrying a blocking marker no longer ejects the card', () => {
    // F1: 672001b patched the REVIEW door and left this one open. 55 drafts are still stored under
    // the orchestrator's name, so they still reach this function.
    expect(blockedVerdict(skillPath, `${DRAFT_PREFIX}... BLOKKOLVA ...`)).toBe(false)
  })

  it('a REAL block from MikroB still blocks', () => {
    expect(blockedVerdict(skillPath, 'BLOKKOLVA: Peti dontesere var')).toBe(true)
  })

  // F2, non-vacuously: derive the assertion from THIS copy's OWN markers. The three copies carry
  // different marker sets (only the installed one currently lists 'HOLD'), so a test hardcoded to
  // 'placeholder' proves nothing about a copy that has no 'HOLD' -- and a substring regression there
  // would sail straight through. Gluing letters onto each real marker fires the old substring test
  // and nothing else.
  it('a marker embedded INSIDE a longer word does not block (word boundary, not substring)', () => {
    const markers = blockedMarkers(skillPath).filter((m) => /^[\p{L}\p{N}]/u.test(m) && /[\p{L}\p{N}]$/u.test(m))
    expect(markers.length).toBeGreaterThan(0) // otherwise this test asserts nothing
    for (const marker of markers) {
      expect(blockedVerdict(skillPath, `elozo${marker}kovetkezo`)).toBe(false)
      // ...while the marker standing on its own still blocks, so the boundary did not disarm it.
      expect(blockedVerdict(skillPath, `${marker} -- Peti dontesere var`)).toBe(true)
    }
  })

  it('the live case that triggered F2: "placeholder" is not a HOLD', () => {
    // The actual text on card e7d530a9 ("Replace any placeholder graphics") blocked the card in the
    // installed copy. Asserted on every copy so the bug cannot be introduced into one of them later.
    expect(blockedVerdict(skillPath, 'Replace any placeholder graphics')).toBe(false)
    expect(blockedVerdict(skillPath, 'household cleaning module')).toBe(false)
  })

  it('a marker ending in punctuation still matches (no trailing \\b that can never fire)', () => {
    expect(blockedVerdict(skillPath, 'blokk: infra hiany')).toBe(true)
  })

  it('a non-orchestrator author is never a block', () => {
    expect(blockedVerdict(skillPath, 'BLOKKOLVA', 'backend2')).toBe(false)
  })
})
