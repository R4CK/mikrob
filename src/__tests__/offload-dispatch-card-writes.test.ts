// Card 8b925388: the local-LLM offload path must not touch a card's TITLE or STATUS.
//
// THE REPORT AND WHAT IS ACTUALLY TRUE. The card says the draft generation "silently rewrote the
// card title/percentage", after a [50%] marker appeared on 8d673233 around the time the draft
// comment landed, making the board show progress nobody had made. Measured before writing any fix:
// the whole offload path makes THREE HTTP calls and exactly ONE of them writes -- a POST to
// /api/kanban/<id>/comments. There is no PUT, no /move, and no title write anywhere in either
// script. So that [50%] came from somewhere else, and "fixing" these scripts would have shipped a
// no-op while the real writer kept doing it.
//
// What IS worth having is the property itself, pinned: a draft is a SUGGESTION, and a suggestion
// that edits the board is no longer a suggestion. Today the scripts satisfy that by construction;
// this test is what keeps it true when someone later adds "and mark it 50% while we are here".
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = ['store/offload-dispatch.sh', 'store/offload-batch-run.sh'] as const

/** Executable lines only -- a URL inside a comment is documentation, not a call. */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
}

/** Every curl invocation in the file, one flattened string each (line continuations folded in). */
function curlCalls(rel: string): string[] {
  const body = code(rel).replace(/\\\n/g, ' ')
  return body.split('\n').filter((l) => /\bcurl\b/.test(l))
}

describe('the offload path writes COMMENTS and nothing else (card 8b925388)', () => {
  it('the matcher finds the calls at all -- otherwise every assertion below is vacuous', () => {
    // This whole file is greps over script text. If a rename made curlCalls() return [], each
    // "no such call exists" check below would pass while measuring nothing at all.
    const all = SCRIPTS.flatMap(curlCalls)
    expect(all.length).toBeGreaterThanOrEqual(3)
    expect(all.some((c) => /\/api\/kanban\/.*\/comments/.test(c))).toBe(true)
  })

  it('THE PROPERTY: no call writes a card record -- no PUT, no /move, no title field', () => {
    for (const rel of SCRIPTS) {
      for (const call of curlCalls(rel)) {
        expect(call, `${rel}: must not PUT a card record`).not.toMatch(/-X\s+PUT/)
        expect(call, `${rel}: must not move a card`).not.toMatch(/\/api\/kanban\/[^/\s"']*\/move/)
        expect(call, `${rel}: must not send a title`).not.toMatch(/"title"\s*:/)
      }
    }
  })

  it('every mutating call in the whole path is a comment POST -- never a card-record write', () => {
    // Card 1bf37a35 added a second call site (a one-time "local offload exhausted" notice) next to
    // the original draft comment, and both now target the LEAF card actually being drafted -- which
    // can differ from the top-level $CARD once real kanban children are involved -- rather than
    // always literally $CARD. The count is no longer pinned at exactly one; the invariant that
    // actually matters (every mutating call is a comment POST, never a PUT/move/title write) still is.
    const mutating = SCRIPTS.flatMap(curlCalls).filter((c) => /-X\s+(POST|PUT|PATCH|DELETE)/.test(c))
    expect(mutating.length).toBeGreaterThan(0)
    for (const call of mutating) {
      expect(call).toMatch(/-X\s+POST/)
      expect(call).toMatch(/\/api\/kanban\/\$[A-Za-z_][A-Za-z0-9_]*\/comments/)
    }
  })

  it('the draft comment is LABELLED as a draft, so a reader cannot mistake it for a decision', () => {
    // The content half of the same finding: the 7B draft on 8d673233 argued the OPPOSITE of the
    // card's goal. Draft-only is the mitigation, and it only works if the label is actually there.
    const src = readFileSync(join(ROOT, 'store/offload-dispatch.sh'), 'utf-8')
    expect(src).toMatch(/LOCAL-LLM DRAFT/)
    expect(src).toMatch(/DRAFT-ONLY/i)
  })
})
