// gate-pretriage-candidates.py: pick the candidate commit SHAs a card's comments name (card
// 34e7285e). Two REAL incidents (627ac234, 11e87eee) picked the wrong hash: a REVIEW names the
// actual commit up front ("REVIEW -- ... @ <real>") but ALSO mentions an unrelated commit later in
// its own prose (merge-conflict context: "this branches from before my <unrelated> landed"), and
// the old logic's "reverse by text position to approximate newest" let the later-positioned,
// unrelated hash outrank the real one.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'gate-pretriage-candidates.py')

function candidates(comments: ReadonlyArray<{ author: string; content: string }>): string[] {
  const out = execFileSync('python3', [SCRIPT], {
    input: JSON.stringify(comments),
    encoding: 'utf-8',
  })
  return out.split('\n').filter((s) => s.length > 0)
}

describe('gate-pretriage-candidates.py', () => {
  it('REGRESSION (real incident 627ac234): a later, unrelated hash in the SAME REVIEW must not outrank the real one', () => {
    const out = candidates([
      { author: 'local-llm', content: '[LOCAL-LLM DRAFT] unrelated chatter mentioning 9cc72f2c and a5dcabb7\n' },
      {
        author: 'backend2',
        content:
          'REVIEW -- 627ac234 @ 481ff958 (branch fix/superadmin-status-guard, pusholva)\n\n' +
          'Done: three tables switched to Record<Union, number> for compile-time completeness.\n\n' +
          'LANDING NOTE: this branch forks from before my 593743cb (FormBuilder, 6525d1db) landed -- ' +
          'both touch the same test file\'s import line, trivial conflict on merge, resolvable either order.\n\n' +
          '115/115 green, tsc clean.',
      },
    ])
    expect(out[0]).toBe('481ff958')
  })

  it('REGRESSION (real incident 11e87eee): "commit X" stated up front beats a LATER "commit Y" mention', () => {
    const out = candidates([
      { author: 'local-llm', content: '[LOCAL-LLM DRAFT] unrelated chatter\n' },
      {
        author: 'fron-ted',
        content:
          'REVIEW: kesz, commit 2ae6d95a. tsc clean.\n\n' +
          'The backend this depends on (0bb321cb, commit 56760d59) is already merged into main -- ' +
          'verified with git merge-base before starting.\n\n' +
          'Gate: QA + Cybersec.',
      },
    ])
    expect(out[0]).toBe('2ae6d95a')
  })

  it('a gate-pretriage comment mentioning its own "@ <sha>" marker is never a candidate source', () => {
    const out = candidates([
      { author: 'backend', content: 'REVIEW -- kesz. Commit aaaaaaa1.' },
      { author: 'gate-pretriage', content: 'GATE PRE-TRIAGE (mechanikus, verdict:null) @ bbbbbbb2' },
    ])
    expect(out).not.toContain('bbbbbbb2')
    expect(out[0]).toBe('aaaaaaa1')
  })

  it('falls back to scanning the whole history when no comment starts with REVIEW', () => {
    const out = candidates([
      { author: 'someone', content: 'still working on it, current head is ccccccc3' },
    ])
    expect(out).toContain('ccccccc3')
  })

  it('returns nothing for an empty comment list', () => {
    expect(candidates([])).toEqual([])
  })
})
