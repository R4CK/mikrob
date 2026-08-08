// gate-pretriage-candidates.py: which commit the pre-triage runs against (card d7ac3470).
//
// This ran against the WRONG commit three times in one day (63e2069c, 45331a93, 2124e347), each time
// needing manual correction. The failure is quiet in the worst way: the pre-triage comment looks
// authoritative, names a sha, and the gate reads it -- while the sha is the pre-NO-GO commit and the
// fix it is supposed to inform is invisible.
//
// The ordering was inline in the shell script and therefore untestable without the live API, which is
// exactly why it stayed broken. It is its own file now, and these tests drive it directly.
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

describe('THE INCIDENT: recency beats wording', () => {
  // Reconstructed from card 63e2069c at the moment the script actually ran. Two old comments carry
  // the `commit <sha>` form for the PRE-NO-GO commit; the newest REVIEW names the fixed commit
  // without that wording. The old code tried every commit-prefixed sha before any bare one, so the
  // stale sha won.
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
    // Not dropped: if the newest sha does not resolve to a real commit, the older one is a sane
    // fallback. Order is the fix, not exclusion.
    const out = run(incident, '63e2069c', MARKER)
    expect(out).toContain('7021f00')
    expect(out.indexOf('ce83bcf')).toBeLessThan(out.indexOf('7021f00'))
  })

  it('CONTROL: with the newest comment removed, the old sha legitimately wins', () => {
    // Proves the ordering is doing the work, rather than the fixture happening to start with ce83bcf.
    expect(run(incident.slice(0, 3), '63e2069c', MARKER)[0]).toBe('7021f00')
  })
})

describe('the tool does not feed on its own output', () => {
  it('skips its OWN previous pre-triage comment', () => {
    // The pre-triage posts a comment naming the sha it triaged. Left in the corpus, that is one more
    // vote for the stale answer on every subsequent run -- measured on 63e2069c.
    const rows: Row[] = [
      { author: 'fullstack', created_at: 100, content: 'REVIEW: commit 7021f00' },
      { author: 'fullstack', created_at: 200, content: 'Javitva: ce83bcf' },
      { author: 'gate-pretriage', created_at: 300, content: `${MARKER} @ 7021f00\nreszletek...` },
    ]
    expect(run(rows, '63e2069c', MARKER)[0]).toBe('ce83bcf')
  })

  it('CONTROL: without the marker argument the same comment DOES count -- the skip is the marker', () => {
    const rows: Row[] = [
      { author: 'fullstack', created_at: 100, content: 'REVIEW: commit 7021f00' },
      { author: 'fullstack', created_at: 200, content: 'Javitva: ce83bcf' },
      { author: 'gate-pretriage', created_at: 300, content: `${MARKER} @ 7021f00` },
    ]
    expect(run(rows, '63e2069c', '')[0]).toBe('7021f00')
  })

  // Cybersec, card d7ac3470 follow-up: the marker-text skip above is content-only, so ANY comment
  // quoting the marker verbatim -- not just the tool's own output -- drops out of candidacy. The
  // fleet's own convention is to quote a prior comment when responding to or correcting it, so an
  // honest, newer REVIEW that happens to quote the pre-triage line resurrects the exact
  // stale-commit-wins bug this file exists to close, just via a different trigger. Measured with the
  // realistic three-comment shape Cybersec used: an old genuine review, then the tool's own output,
  // then a new genuine review that quotes the marker while fixing it.
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
    // The newest genuine review (2222222) must win -- not the old pre-triage answer (1111111).
    expect(run(rows, '', MARKER)[0]).toBe('2222222')
  })

  it('MUTATION CONTROL: an attacker-authored comment quoting the marker is ALSO not skipped', () => {
    // Same shape, but the quoting comment is authored by neither fullstack nor gate-pretriage --
    // proves the gate is on AUTHOR, not on some allowlist of "trusted" non-attacker names.
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

describe('ordering is computed, not inherited from the API', () => {
  it('sorts by created_at even when the rows arrive out of order', () => {
    // The API returns comments oldest-first today. Nothing promises it, and a silently assumed
    // ordering is exactly what this whole class of bug is made of.
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

describe('within one comment, the commit-prefixed form wins and the LAST mention wins', () => {
  it('prefers the `commit <sha>` form over a bare hex in the SAME comment', () => {
    const rows: Row[] = [{ created_at: 1, content: 'a 1111111 branchen, commit 2222222' }]
    expect(run(rows, '', MARKER)[0]).toBe('2222222')
  })

  it('a comment that corrects itself ends on the answer', () => {
    const rows: Row[] = [{ created_at: 1, content: 'commit 1111111 -- javitva: commit 2222222' }]
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
