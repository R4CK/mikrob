// gate-pretriage-candidates.py: pick the candidate commit SHAs a card's comments name, newest first
// (card d7ac3470, card 34e7285e -- two incident classes, both covered here).
//
// (1) RECENCY BEATS WORDING (d7ac3470): an OLD comment's `commit <sha>` wording used to outrank a
//     NEWER comment naming the fresh sha some other way. This ran against the wrong commit three
//     times in one day (63e2069c, 45331a93, 2124e347).
// (2) WITHIN-COMMENT ORDER (34e7285e): a REVIEW names the real commit up front but ALSO mentions an
//     unrelated commit later in its own prose (merge-conflict/dependency context); the old
//     "last mention in a comment wins" rule let the later, unrelated hash outrank the real one.
//     Real incidents: 627ac234, 11e87eee.
//
// The ordering lives in its own tracked, TESTABLE file -- both bugs were invisible from the inline
// shell version this replaced.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'store',
  'gate-pretriage-candidates.py'
)
const MARKER = 'GATE PRE-TRIAGE (mechanikus, verdict:null)'

interface Row {
  author?: string
  content?: string
  created_at?: number
}

const run = (rows: Row[], card = '', marker = ''): string[] =>
  execFileSync('python3', [SCRIPT, card, marker], {
    input: JSON.stringify(rows),
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean)

describe('WITHIN-COMMENT ORDER: a REVIEW front-loads its answer (card 34e7285e)', () => {
  it('REGRESSION (real incident 627ac234): a later, unrelated hash in the SAME REVIEW must not outrank the real one', () => {
    const out = run([
      { author: 'local-llm', created_at: 100, content: '[LOCAL-LLM DRAFT] unrelated chatter mentioning 9cc72f2c and a5dcabb7\n' },
      {
        author: 'backend2',
        created_at: 200,
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

  it('REGRESSION (real incident 11e87eee): "commit X" stated up front beats a LATER "commit Y" mention in the same REVIEW', () => {
    const out = run([
      { author: 'local-llm', created_at: 100, content: '[LOCAL-LLM DRAFT] unrelated chatter\n' },
      {
        author: 'fron-ted',
        created_at: 200,
        content:
          'REVIEW: kesz, commit 2ae6d95a. tsc clean.\n\n' +
          'The backend this depends on (0bb321cb, commit 56760d59) is already merged into main -- ' +
          'verified with git merge-base before starting.\n\n' +
          'Gate: QA + Cybersec.',
      },
    ])
    expect(out[0]).toBe('2ae6d95a')
  })

  it('a plain follow-up (no REVIEW prefix) still ends on its answer -- self-correction is LAST-wins', () => {
    // The fleet's real correction shape: "JAVITVA -- commit X" after a NO-GO/FAIL, not a REVIEW.
    const out = run([{ created_at: 1, content: 'commit 1111111 -- javitva: commit 2222222' }])
    expect(out[0]).toBe('2222222')
  })

  it('REGRESSION (real incident 57112049, card ce159d2b): a CYBERSEC GO verdict front-loads its answer too, not just a literal REVIEW', () => {
    const out = run([
      {
        author: 'backend2',
        created_at: 100,
        content: 'REVIEW -- 57112049 @ fea51c4 (marveen, develop, pusholva)\n\nfix details.',
      },
      {
        author: 'gate-pretriage',
        created_at: 150,
        content: 'GATE PRE-TRIAGE (mechanikus, verdict:null) @ 6199f0b\nreszletek...',
      },
      {
        author: 'cybersec',
        created_at: 200,
        content:
          'CYBERSEC GO -- 57112049 @ `fea51c4` (marveen, develop). A `fea51c4`-et neztem, nem a ' +
          'pretriage altal kiirt `6199f0b`-t (koszonom a korrekciot). Kapcsolodo elozo kartya: 746ea4e4.',
      },
    ])
    expect(out[0]).toBe('fea51c4')
  })

  it('REGRESSION (real incident 57112049): QA PASS also front-loads (uses the "commit X" form)', () => {
    const out = run([
      {
        author: 'qa',
        created_at: 100,
        content:
          'QA PASS -- 57112049, commit fea51c4 (marveen fleet repo, develop, mar HEAD-en). ' +
          'Ugyanaz a hookot erinti mint 746ea4e4, ugyanazzal a korulzarassal ellenoriztem.',
      },
    ])
    expect(out[0]).toBe('fea51c4')
  })

  it('a comment merely discussing a past verdict mid-text (not starting with it) is NOT swept into first-mention-wins', () => {
    const out = run([
      {
        author: 'someone',
        created_at: 100,
        content: 'Followed up on the earlier CYBERSEC GO @ 1111111, real fix here: commit 2222222',
      },
    ])
    expect(out[0]).toBe('2222222')
  })

  it('falls back to scanning the whole history when no comment starts with REVIEW', () => {
    const out = run([{ author: 'someone', created_at: 1, content: 'still working on it, current head is ccccccc3' }])
    expect(out).toContain('ccccccc3')
  })

  it('returns nothing for an empty comment list', () => {
    expect(run([])).toEqual([])
  })
})

describe('RECENCY BEATS WORDING (card d7ac3470)', () => {
  // Reconstructed from card 63e2069c at the moment the script actually ran. Two old comments carry
  // the `commit <sha>` form for the PRE-NO-GO commit; the newest comment (a plain "Javitva:" follow-
  // up, not a REVIEW) names the fixed commit without that wording.
  const incident: Row[] = [
    { author: 'fullstack', created_at: 1_786_142_300, content: 'REVIEW: kesz, commit 7021f00' },
    { author: 'qa', created_at: 1_786_142_616, content: 'QA PASS a commit 7021f00-on' },
    { author: 'cybered', created_at: 1_786_164_805, content: 'NO-GO: a 63e2069c kartyan hiba van' },
    { author: 'fullstack', created_at: 1_786_165_725, content: 'Javitva: ce83bcf pusholva' },
  ]

  it("picks the NEWEST comment's sha, not the one with the nicer wording", () => {
    expect(run(incident, '63e2069c', MARKER)[0]).toBe('ce83bcf')
  })

  it('the stale commit-prefixed sha is still offered, just LATER', () => {
    const out = run(incident, '63e2069c', MARKER)
    expect(out).toContain('7021f00')
    expect(out.indexOf('ce83bcf')).toBeLessThan(out.indexOf('7021f00'))
  })

  it('CONTROL: with the newest comment removed, the old sha legitimately wins', () => {
    expect(run(incident.slice(0, 3), '63e2069c', MARKER)[0]).toBe('7021f00')
  })

  it('sorts by created_at even when the rows arrive out of order', () => {
    const rows: Row[] = [
      { created_at: 300, content: 'legujabb: ccccccc' },
      { created_at: 100, content: 'legregebbi: commit aaaaaaa' },
      { created_at: 200, content: 'kozepso: bbbbbbb' },
    ]
    expect(run(rows, '', MARKER)).toEqual(['ccccccc', 'bbbbbbb', 'aaaaaaa'])
  })

  it('a row with NO created_at sorts last instead of crashing', () => {
    const rows: Row[] = [
      { content: 'timestamp nelkul: aaaaaaa' },
      { created_at: 5, content: 'bbbbbbb' },
    ]
    expect(run(rows, '', MARKER)).toEqual(['bbbbbbb', 'aaaaaaa'])
  })
})

describe('the tool does not feed on its own output', () => {
  it('skips its OWN previous pre-triage comment (by AUTHOR)', () => {
    const rows: Row[] = [
      { author: 'fullstack', created_at: 100, content: 'REVIEW: commit 7021f00' },
      { author: 'fullstack', created_at: 200, content: 'Javitva: ce83bcf' },
      { author: 'gate-pretriage', created_at: 300, content: `${MARKER} @ 7021f00\nreszletek...` },
    ]
    expect(run(rows, '63e2069c', MARKER)[0]).toBe('ce83bcf')
  })

  it('the exclusion is UNCONDITIONAL on author -- an empty marker argument changes nothing', () => {
    // Simplified from the marker-AND-author gate this replaced (Cybersec, card d7ac3470 follow-up
    // already established author is the only signal that cannot be spoofed by content; requiring
    // the marker text too was redundant in production, where the caller always passes it, and
    // strictly weaker as a safety property). The gate-pretriage row must stay excluded regardless.
    const rows: Row[] = [
      { author: 'fullstack', created_at: 100, content: 'REVIEW: commit 7021f00' },
      { author: 'fullstack', created_at: 200, content: 'Javitva: ce83bcf' },
      { author: 'gate-pretriage', created_at: 300, content: `${MARKER} @ 7021f00` },
    ]
    expect(run(rows, '63e2069c', '')[0]).toBe('ce83bcf')
  })

  it("a REAL review that quotes the marker text is NOT mistaken for the tool's own output", () => {
    const rows: Row[] = [
      { author: 'fullstack', created_at: 100, content: 'REVIEW: commit 1111111' },
      { author: 'gate-pretriage', created_at: 200, content: `${MARKER} @ 1111111` },
      {
        author: 'fullstack',
        created_at: 300,
        content: `Javitva a "${MARKER}" altal jelzettek alapjan: commit 2222222`,
      },
    ]
    expect(run(rows, '', MARKER)[0]).toBe('2222222')
  })

  it('MUTATION CONTROL: an attacker-authored comment quoting the marker is ALSO not skipped -- the gate is AUTHOR, not content', () => {
    const rows: Row[] = [
      { author: 'gate-pretriage', created_at: 100, content: `${MARKER} @ 1111111` },
      {
        author: 'someone-else',
        created_at: 200,
        content: `${MARKER} @ 1111111, real fix: 2222222`,
      },
    ]
    expect(run(rows, '', MARKER)[0]).toBe('2222222')
  })
})

describe('within one comment, the commit-prefixed form wins over a bare hex', () => {
  it('prefers the `commit <sha>` form over a bare hex in the SAME (non-REVIEW) comment', () => {
    const rows: Row[] = [{ created_at: 1, content: 'a 1111111 branchen, commit 2222222' }]
    expect(run(rows, '', MARKER)[0]).toBe('2222222')
  })

  it('the "@ <sha>" REVIEW convention counts as commit-prefixed too', () => {
    const rows: Row[] = [{ created_at: 1, content: 'REVIEW -- kesz, konyv 1111111-rol, @ 2222222' }]
    expect(run(rows, '', MARKER)[0]).toBe('2222222')
  })
})

describe('noise that must not become a candidate', () => {
  it("the card's OWN id is excluded -- it is 8 hex and appears in nearly every comment", () => {
    const rows: Row[] = [{ created_at: 1, content: 'a 63e2069c kartyan javitva: ce83bcf' }]
    expect(run(rows, '63e2069c', MARKER)).toEqual(['ce83bcf'])
  })

  it('duplicates collapse to their FIRST (newest) position', () => {
    const rows: Row[] = [
      { created_at: 200, content: 'ce83bcf' },
      { created_at: 100, content: 'commit ce83bcf, es 7021f00' },
    ]
    expect(run(rows, '', MARKER)).toEqual(['ce83bcf', '7021f00'])
  })

  it('empty input yields nothing, and does not crash', () => {
    expect(run([], 'abc', MARKER)).toEqual([])
  })

  it('malformed JSON yields nothing, and does not crash', () => {
    // This runs from a scheduled task. A crash here means the gate never gets its input at all,
    // which is worse than getting none.
    const out = execFileSync('python3', [SCRIPT, 'abc', MARKER], {
      input: 'not json at all',
      encoding: 'utf-8',
    })
    expect(out.trim()).toBe('')
  })
})
