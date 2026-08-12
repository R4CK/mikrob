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

describe('EXPLICIT LABEL ALWAYS WINS, even inside a front-loaded comment (card d9a57239)', () => {
  it('REGRESSION (real incident 011b3f89): an explicit "Commit: X" trailer beats an EARLIER, merely-contextual "@ <sha>"', () => {
    // Verbatim shape from the actual comment: a REVIEW quotes an old incident's example sha
    // ("cybered GO @596f0f15") while explaining a fix, then states the REAL commit at the end.
    const out = run([
      {
        author: 'fullstack',
        created_at: 100,
        content:
          'REVIEW: kesz. Piros->zoldon bizonyitva: git stash-eltem a fixem, kozvetlenul lefuttattam ' +
          'a 25083c6f valos fixture-t (cybered GO @596f0f15, kesobbi backend REVIEW ami csak ' +
          'reszletezi ugyanazt a 596f0f15-ot) a REGI kodon -> ALLOW:stale-verdict. Osszesen 33/33 ' +
          'selftest zold. Commit: 26ea788.',
      },
    ])
    expect(out[0]).toBe('26ea788')
  })

  it('REGRESSION (real incident 3f6bcc41): a "Commitok:" (plural) multi-commit trailer picks the LAST commit, not the first', () => {
    const out = run([
      {
        author: 'fullstack',
        created_at: 100,
        content:
          'REVIEW: kesz, 108/108 zold teszt. Commitok: bbbed68/f9b0976/99d98e4/4bee60f/7847afe/762cd8a/6d12b81/5467c0f.',
      },
    ])
    expect(out[0]).toBe('5467c0f')
  })

  it('a bare "Commit: X" (singular) inside a REVIEW still beats an earlier @-mention, minimal synthetic case', () => {
    const out = run([{ created_at: 100, content: 'REVIEW -- @ 1111111 (context only). Commit: 2222222.' }])
    expect(out[0]).toBe('2222222')
  })

  it('a "Commitok:" list works the same in a PLAIN (non-front-loaded) follow-up comment', () => {
    const out = run([{ created_at: 100, content: 'Javitva, commitok: aaaaaaa/bbbbbbb/ccccccc.' }])
    expect(out[0]).toBe('ccccccc')
  })

  it('with NO explicit label present, the existing @-mention/bare-hex tiers behave exactly as before', () => {
    const out = run([{ created_at: 100, content: 'REVIEW -- kesz, konyv 1111111-rol, @ 2222222' }])
    expect(out[0]).toBe('2222222')
  })

  it('REGRESSION (real incident 1f51f050, card bb15a712): a "+"-joined two-commit mention picks the LAST commit, not the first', () => {
    // Verbatim shape: this fleet's own post-gate-fix convention, no "Commit:" label on the pair,
    // "+" between the two shas. Before the fix, "+" broke EXPLICIT_LABEL's match right after the
    // first sha, so e6097b6 (the commit the SECOND one fixes a regression in) won instead of the
    // real final answer.
    const out = run([
      {
        author: 'fullstack',
        created_at: 100,
        content:
          'POST-GATE FIX: Cybersec MEDIUM leletere es egy sajat regresszio javitasa, ' +
          'commit e6097b6 + 4152268 (a QA PASS / Cybersec GO altal mar attekintett 917fd71 utan).',
      },
    ])
    expect(out[0]).toBe('4152268')
  })

  it('a "+"-joined pair works the same with an explicit "Commit:" label too', () => {
    const out = run([{ created_at: 100, content: 'Commit: 1111111 + 2222222.' }])
    expect(out[0]).toBe('2222222')
  })
})

describe('the fleet\'s OTHER completion markers front-load too, not just REVIEW/verdicts (card 2dd93b53, Cybered)', () => {
  it('REGRESSION (the real comment text, card ac7d5530): a KÉSZ close now uses first-mention-wins, not last', () => {
    // Verbatim (the real observed content), which has NO "commit "/"@ " prefix anywhere -- both
    // 871dfcff and 481b61cf are bare hex. This test is honest about what the fix actually changes:
    // it does NOT resolve WHICH bare hex is the semantically right one (that is the separate,
    // acknowledged bare-hex-fallback weakness this same card names but does not ask this fix to
    // solve) -- it only changes the ORDER a KÉSZ-prefixed comment is read in. Before this fix, KÉSZ
    // matched no prefix, so the comment fell through to last-mention-wins and ranked 11d3e76a (a
    // card id mentioned only in passing, "Fix (481b61cf/11d3e76a)") FIRST -- the worst of the three.
    // After this fix, KÉSZ front-loads, so first-mention-wins ranks 871dfcff first -- at least a
    // real, actually-deployed commit, even though it is not the ideal target either.
    const out = run([
      {
        author: 'teszter',
        created_at: 100,
        content:
          'KÉSZ: 6 US story API-szinten verifikálva a post-deploy (871dfcff) szerveren. ' +
          'Fix (481b61cf/11d3e76a) él: minimális body most 400, nem 500.',
      },
    ])
    expect(out[0]).toBe('871dfcff')
    expect(out).toEqual(['871dfcff', '481b61cf', '11d3e76a'])
  })

  // The next four tests all use TWO bare-hex mentions (no "commit "/"@ " prefix) so that
  // front-loaded (first-mention-wins) and non-front-loaded (last-mention-wins) genuinely disagree
  // on the answer -- a single prefixed mention would pass either way and prove nothing about
  // WHICH ordering rule actually ran (a real mistake in an earlier draft of these tests, caught by
  // mutation-testing them: they stayed green even with the marker recognition reverted).
  it('the unaccented spelling (KESZ) is recognised too -- not every agent types the accent', () => {
    const out = run([{ created_at: 100, content: 'KESZ: 1111111, kapcsolodo: 2222222' }])
    expect(out[0]).toBe('1111111')
  })

  it('DONE front-loads', () => {
    const out = run([{ created_at: 100, content: 'DONE: 1111111, see also 2222222' }])
    expect(out[0]).toBe('1111111')
  })

  it('ELKÉSZÜLT (accented) and the unaccented ELKESZULT both front-load', () => {
    for (const marker of ['ELKÉSZÜLT', 'ELKESZULT']) {
      const out = run([{ created_at: 100, content: `${marker}: 1111111, lasd 2222222` }])
      expect(out[0]).toBe('1111111')
    }
  })

  it('the BEFEJEZ- stem front-loads regardless of its Hungarian ending', () => {
    for (const word of ['BEFEJEZVE', 'BEFEJEZTEM', 'BEFEJEZTÜK']) {
      const out = run([{ created_at: 100, content: `${word}: 1111111, kontextus 2222222` }])
      expect(out[0]).toBe('1111111')
    }
  })

  it('CONTROL: a comment merely mentioning "befejez..." mid-text (not starting with it) still uses last-mention-wins', () => {
    const out = run([
      { created_at: 100, content: 'a korabbi befejezesre hivatkozva, javitva: 1111111, majd 2222222' },
    ])
    expect(out[0]).toBe('2222222')
  })

  it('CONTROL: an unrelated word starting with "kesz" but not the marker itself is not swept in oddly -- checked against a realistic sentence', () => {
    // "készen" ("ready") is a real Hungarian word starting with the same letters as KÉSZ. The regex
    // requires a WORD BOUNDARY right after the marker, so "KÉSZEN" (one word) must NOT match -- only
    // the bare marker (optionally followed by punctuation/whitespace) counts.
    const out = run([
      { created_at: 100, content: 'készen áll a build, de meg nem indult: 1111111, majd 2222222' },
    ])
    expect(out[0]).toBe('2222222') // last-mention-wins path, same as any ordinary comment
  })
})
