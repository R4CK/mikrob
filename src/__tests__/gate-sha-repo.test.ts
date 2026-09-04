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
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const SCRIPT = join(REPO_ROOT, 'store/gate-sha-repo.sh')

/** Run the script, returning stdout+stderr and the exit code rather than throwing, because the
 * exit code IS part of this script's contract (1 = mismatch, 3 = not found). */
function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { out: out.trim(), code: 0 }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(), code: err.status ?? -1 }
  }
}

describe('gate-sha-repo.sh (card edd4c3bf)', () => {
  it('its own selftest passes, and reports a COUNTED number of cases', () => {
    const { out, code } = run(['--selftest'])
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
    const { out, code } = run(['0000000000000000000000000000000000000000'])
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
    const { out, code } = run(['fbca2448'])
    expect(code, out).toBe(4)
    expect(out).toContain('card-id|fbca2448|')
    // The TITLE is the point -- it is what tells the reader what they actually found. It also
    // regression-guards a real bug: lookup() runs inside $( ), so a subshell variable never reached
    // the caller and the title came back empty until it was carried in the value.
    expect(out.split('|')[2] ?? '').not.toBe('')
  })

  it('an unresolvable value that is NOT a card still reports unlanded', () => {
    // The card-id branch must not swallow the honest answer.
    const { out, code } = run(['0000000000000000000000000000000000000000'])
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
