// Card edd4c3bf. The card scoped a MANDATORY, script-read `Gate-repo:` line in every REVIEW, and
// asked the executor to measure first whether the `repo:` block already written in some reviews
// would do instead. The measurement said neither, and this file pins the answer that replaced it.
//
// Measured on the live comment corpus before building anything:
//   - 1019 REVIEW comments carry a `Gate-SHA:`; 13 carry `Gate-repo:`, 36 carry a `repo:` block,
//     983 carry NEITHER. A newly mandated field is absent from 96.5% of the corpus on day one.
//   - gate-pretriage-card.sh, the only script that resolves a sha, ALREADY probes both clones.
//   - Across all 1076 distinct Gate-SHAs ever posted: 590 marveen, 481 CleanCore, 5 unlanded,
//     ZERO in both. Ambiguity -- the only thing a declaration settles that a lookup cannot -- has
//     never occurred.
//
// So the fix is a resolver, not a field: ask which clone holds the sha. It works on all 1076
// existing shas and needs nobody to write a new line. A declared repo is still honoured via
// --check, as a cross-check that can catch an author naming the wrong repo.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const SCRIPT = join(REPO_ROOT, 'store/gate-sha-repo.sh')

/** Run the script, returning stdout+stderr and the exit code rather than throwing, because the
 * exit code IS part of this script's contract (1 = mismatch, 3 = not found). */
function run(args: string[], env: NodeJS.ProcessEnv = {}): { out: string; code: number } {
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out: out.trim(), code: 0 }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(), code: err.status ?? -1 }
  }
}

/** A board stub the script reaches over `file://`, so the card-id branch can be measured without a
 * live dashboard.
 *
 * Card 90eaa6e5, the reason this exists: the card-id test used to call the REAL board, which the
 * script does with `curl --max-time 3`. Inside a saturated full suite that budget expires, the
 * script takes its deliberate FAIL-SOFT path (unlanded, exit 3), and the test -- which expects the
 * card-id answer, exit 4 -- goes red on correct code. Observed three times in one day, TWICE inside
 * a QA gate run, where a false red sends correct work back to in_progress.
 *
 * `file://` and not a stub HTTP server on a port: a server would answer from this same Node event
 * loop, so a starved worker could still blow the 3s budget and reproduce the very flake being
 * fixed. curl reads a file with no socket, no port and no event loop, so there is no budget left to
 * expire. The script needs no change for it -- DASHBOARD_URL and DASHBOARD_TOKEN_FILE are already
 * its own knobs -- and the path under test is the real one: URL construction, the curl call with the
 * token piped as a header file, the JSON parse and the title extraction.
 *
 * It also removes a second, slower rot: the old test asserted against one specific live card, so
 * deleting that card from the board would have broken an unrelated test months later.
 *
 * THE LIMITATION, stated rather than left implied: the stub hardcodes the board's response SHAPE
 * ({"card":{"id","title"}}), so a dashboard that changed that shape would break the script in
 * production while this file stayed green. That trade is taken deliberately -- the script reads
 * `d.get("card", d)` and tolerates both the wrapped and bare forms, and a board response shape
 * change would break many fleet scripts at once, loudly. What it must not become is a reason to
 * add a live call back into a full-suite test.
 */
function boardStub(cards: Record<string, string>): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'gate-sha-repo-board-'))
  mkdirSync(join(dir, 'api', 'kanban'), { recursive: true })
  for (const [id, title] of Object.entries(cards)) {
    writeFileSync(join(dir, 'api', 'kanban', id), JSON.stringify({ card: { id, title } }))
  }
  writeFileSync(join(dir, 'token'), 'stub-token\n')
  return { DASHBOARD_URL: `file://${dir}`, DASHBOARD_TOKEN_FILE: join(dir, 'token') }
}

describe('gate-sha-repo.sh (card edd4c3bf)', () => {
  it('its own selftest passes, and reports a COUNTED number of cases', () => {
    // Stubbed board because the selftest's own "impossible sha" case runs the same lookup, and so
    // reached the live dashboard as well.
    const { out, code } = run(['--selftest'], boardStub({}))
    expect(code, out).toBe(0)
    // The count is asserted so deleting a case is a failure, not a quietly smaller suite -- the
    // same discipline the landers' selftests already use.
    const m = out.match(/selftest: (\d+)\/(\d+) passed/)
    expect(m, out).not.toBeNull()
    expect(Number(m![1])).toBe(Number(m![2]))
    expect(Number(m![2])).toBeGreaterThanOrEqual(10)
  })

  it('resolves a real marveen commit to marveen', () => {
    // HEAD of this very checkout: always present, never pruned, so this cannot rot into a skip.
    const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim()
    const { out, code } = run([head])
    expect(code, out).toBe(0)
    expect(out).toBe('marveen')
  })

  it('--path prints a directory that actually contains that commit', () => {
    const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim()
    const { out, code } = run([head, '--path'])
    expect(code, out).toBe(0)
    expect(() => execFileSync('git', ['-C', out, 'cat-file', '-e', `${head}^{commit}`])).not.toThrow()
  })

  it('reports a sha in NEITHER clone as unlanded, and exits 3 -- it never guesses a repo', () => {
    // The point of the card: a confident wrong answer is what cost card a3b4e0f4 a round trip.
    //
    // Stubbed board, though the ANSWER here never depended on one: a value in neither clone falls
    // through to the card lookup, so this case was quietly making a live HTTP call too. It could
    // not go red from it -- board or no board, the answer is 'unlanded' either way -- but measured
    // against an unreachable dashboard it spent the whole 3s budget (0.043s live, 3.049s
    // blackholed) for an answer it already had.
    const { out, code } = run(['0000000000000000000000000000000000000000'], boardStub({}))
    expect(out).toBe('unlanded')
    expect(code).toBe(3)
  })

  it('--check AGREES with a correctly declared repo, in any of the shapes reviews actually use', () => {
    const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim()
    // All of these shapes appear in real reviews; a check that understood only one would report
    // false mismatches on honest ones.
    //
    // The PATH form is not decoration, it is what makes this test non-vacuous. Mutation testing
    // caught it: dropping the `*marveen*` branch from normalise_repo left every other case green,
    // because a bare 'marveen' passes through unchanged and then happens to equal the answer. It
    // was agreeing for a reason unrelated to normalisation. A path contains 'marveen' but is not
    // equal to it, so only real normalisation satisfies it.
    for (const declared of [
      'git@github.com:R4CK/mikrob.git',
      'marveen',
      'R4CK/mikrob',
      '/home/neon/marveen',
      'git@github.com:Szotasz/marveen.git',
    ]) {
      const { out, code } = run([head, '--check', declared])
      expect(code, `${declared}: ${out}`).toBe(0)
      expect(out).toBe('AGREE|marveen')
    }
  })

  it('--check REJECTS a wrongly declared repo, loudly and with a non-zero exit', () => {
    // This is the whole value of keeping the declared field as a cross-check rather than as the
    // mechanism: an author who states the wrong repo gets told, instead of being believed.
    const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim()
    const { out, code } = run([head, '--check', 'R4CK/CleanCore'])
    expect(code).toBe(1)
    expect(out).toContain('MISMATCH')
    expect(out).toContain('actual=marveen')
  })

  it('names a KANBAN CARD ID instead of laundering it as "unlanded" (backend, msg 22750)', () => {
    // The failure this closes, measured on me: card ids are 8 hex characters, exactly like an
    // abbreviated sha, so answering "unlanded" for one is PLAUSIBLE AND FALSE -- and that is the
    // worst kind of wrong answer, because it confirms the reader is looking at a commit. I did
    // exactly that with fbca2448 and concluded "probably the pre-merge sha the landing rewrote".
    // It had never been a commit.
    //
    // Not hypothetical in the corpus either: of the five Gate-SHA values resolving in NEITHER
    // clone, one (132fc28c) is a kanban card.
    const title = '[STUB] a card id that was written into a Gate-SHA line'
    const { out, code } = run(['fbca2448'], boardStub({ fbca2448: title }))
    expect(code, out).toBe(4)
    expect(out).toContain('card-id|fbca2448|')
    // The TITLE is the point -- it is what tells the reader what they actually found. Asserted by
    // VALUE, not merely as non-empty: a stub makes the expected string knowable, and a title that
    // came back as some other card's would still be non-empty. It also regression-guards a real
    // bug: lookup() runs inside $( ), so a subshell variable never reached the caller and the title
    // came back empty until it was carried in the value.
    expect(out.split('|')[2]).toBe(title)
  })

  it('--check on a card id says CARD-ID and exits 4, instead of comparing it to a repo', () => {
    // The exit-4 branch of --check had no test at all; the stub makes it free to pin. A caller that
    // treated this as an ordinary mismatch would report "the REVIEW names the wrong repo" about a
    // value that is not a commit in any repo.
    const { out, code } = run(['fbca2448', '--check', 'marveen'], boardStub({ fbca2448: 'stub' }))
    expect(code, out).toBe(4)
    expect(out).toContain('CARD-ID')
    expect(out).not.toContain('MISMATCH')
  })

  it('FAIL-SOFT: a board that cannot answer yields unlanded, it does not fail the run', () => {
    // This is the flake's own shape, pinned deterministically: with the board unreachable the card
    // lookup fails and the script must fall back to the honest "unlanded", never to a repo. An
    // empty stub is a board that answers nothing for every id.
    const { out, code } = run(['fbca2448'], boardStub({}))
    expect(out).toBe('unlanded')
    expect(code).toBe(3)
  })

  it('an unresolvable value that is NOT a card still reports unlanded', () => {
    // The card-id branch must not swallow the honest answer. The stub ANSWERS for a different id,
    // so this is the sharper version of the empty-board case above: the lookup path is live and
    // working, and it still declines to invent a card for this value.
    const { out, code } = run(['0000000000000000000000000000000000000000'], boardStub({ fbca2448: 'stub' }))
    expect(out).toBe('unlanded')
    expect(code).toBe(3)
  })

  it('FAIL-SOFT: with the board unavailable it falls back to unlanded, never to a wrong repo', () => {
    // A dashboard that is down, slow or unauthenticated must never turn a correct "unlanded" into
    // something else. GATE_SHA_REPO_NO_BOARD=1 is the same path an offline run takes.
    // "unlanded" exits 3, so this must not treat a non-zero exit as a failure to run -- the exit
    // code IS the contract here, same as everywhere else in this file.
    let out = ''
    let code = 0
    try {
      out = execFileSync('bash', [SCRIPT, 'fbca2448'], {
        encoding: 'utf-8',
        env: { ...process.env, GATE_SHA_REPO_NO_BOARD: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch (e) {
      const err = e as { status?: number; stdout?: string }
      out = (err.stdout ?? '').trim()
      code = err.status ?? -1
    }
    expect(out).toBe('unlanded')
    expect(code).toBe(3)
  })

  it('refuses input that is not a usable sha, rather than resolving something else', () => {
    expect(run(['nothex!']).code).toBe(2)
    expect(run(['abc']).code).toBe(2) // shorter than 7: git itself would call it ambiguous
    expect(run([]).code).toBe(2)
  })
})
