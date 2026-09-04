// gate-pretriage-card.sh: the wiring that runs the local pre-triage for ONE card and formats the
// verdict:null INPUT comment the gate-reconciler posts before dispatching a gate (card 83191d8d).
//
// The API-driven card resolution (cardId -> repo + REVIEW commit) is exercised live; here we test the
// deterministic OFFLINE CORE (`--repo <path> --sha <sha> --dry-run`) against a throwaway git repo, so
// the comment body's SHAPE and the "never a verdict" contract are pinned without touching the network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'gate-pretriage-card.sh')

let repo: string
const git = (...args: string[]): void => {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
}

/** Commit `files` and return the pre-triage INPUT comment body the wiring would post for that commit.
 *  `title` (optional) exercises the card-title-vs-changed-files self-check (card ce159d2b).
 *  `desc` (optional) exercises the missing-DECISIONS.md nudge (card 78f85eb1).
 *  `peerGateSha` (optional) exercises the stale-Pair-FE/Pair-BE-Gate-SHA nudge (card 367c23a9) --
 *  stands in for what card-mode would have resolved live by following a Pair-FE:/Pair-BE: line. */
function commitAndBody(
  files: Record<string, string>,
  title?: string,
  desc?: string,
  peerGateSha?: string,
): string {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(repo, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'change')
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
  const args = [SCRIPT, '--repo', repo, '--sha', sha, '--dry-run']
  if (title !== undefined) args.push('--title', title)
  if (desc !== undefined) args.push('--desc', desc)
  if (peerGateSha !== undefined) args.push('--peer-gate-sha', peerGateSha)
  return execFileSync('bash', args, { encoding: 'utf-8', stdio: 'pipe' })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gpt-card-'))
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'Tester')
  writeFileSync(join(repo, 'seed.md'), '# seed\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('the INPUT comment body', () => {
  it('is labelled as mechanical pre-triage with verdict:null, and NEVER as a verdict', () => {
    const body = commitAndBody({ 'src/x.ts': 'export const x = 1\n' })
    expect(body).toContain('GATE PRE-TRIAGE (mechanikus, verdict:null)')
    expect(body).toContain('Ez NEM gate-verdikt')
    // The hard contract: no decision word may appear (case-insensitive, whole word).
    expect(body).not.toMatch(/\b(PASS|FAIL|GO|NO-GO)\b/i)
  })

  it('names the commit it triaged', () => {
    const body = commitAndBody({ 'src/x.ts': 'export const x = 1\n' })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    expect(body).toContain(`@ ${sha}`)
  })

  it('surfaces a real mechanical finding -- code changed with no test file', () => {
    const body = commitAndBody({ 'src/feature.ts': 'export function f() { return 1 }\n' })
    expect(body).toContain('no-test-for-changed-code')
    expect(body).toMatch(/Mechanikus leletek/)
  })

  it('reports a clean run without implying the card is good', () => {
    // A docs-only change trips none of the code heuristics.
    const body = commitAndBody({ 'docs/notes.md': 'just docs\n' })
    expect(body).toContain('Mechanikus lelet: nincs')
    expect(body).toContain('ez NEM jelenti, hogy a kartya jo')
  })
})

// Card ce159d2b, incident 57112049/6199f0b: a resolved commit belonging to an ENTIRELY DIFFERENT
// card (dashboard semver display, not the secret-write-guard fix its own card described) got
// mechanically triaged and reported with nothing flagging the mismatch. This is a NUDGE only -- it
// never changes the resolved SHA or the exit code, it only adds a warning line for the human/gate.
describe('the title-vs-changed-files self-check (card ce159d2b)', () => {
  it("warns when NONE of the title's meaningful words appear in the changed files", () => {
    const body = commitAndBody(
      { 'web/dashboard-semver-display.js': 'export const x = 1\n' },
      '[SEC] secret-write-guard.py finditer fix',
    )
    expect(body).toContain('FIGYELEM -- ONELLENORZES')
    expect(body).toContain('ELLENORIZD KEZZEL')
  })

  it('stays quiet when the title shares a real word with the changed-files paths', () => {
    const body = commitAndBody(
      { 'web/dashboard-semver-display.js': 'export const x = 1\n' },
      '[BUG] dashboard semver display broken',
    )
    expect(body).not.toContain('FIGYELEM')
  })

  it('no title given (offline manual use) -- the check is skipped, not a false warning', () => {
    const body = commitAndBody({ 'web/dashboard-semver-display.js': 'export const x = 1\n' })
    expect(body).not.toContain('FIGYELEM')
  })

  it('generic bracket-tag words alone (MikroB/INFRA/SEC/HIGH) do not count as a "match" -- they say nothing about WHAT changed', () => {
    const body = commitAndBody(
      { 'src/totally-unrelated.ts': 'export const y = 2\n' },
      '[MikroB][INFRA][SEC][HIGH] generic tag-only title',
    )
    // "generic", "tag-only", "title" are the only non-stopword tokens and none appear in the path.
    expect(body).toContain('FIGYELEM -- ONELLENORZES')
  })

  it('too few meaningful words in the title -- the check does not fire on noise alone', () => {
    const body = commitAndBody(
      { 'src/anything.ts': 'export const z = 3\n' },
      '[MikroB][INFRA] fix',
    )
    // "mikrob"/"infra" are stopwords and "fix" is under the 4-char minimum -- zero survives the
    // filter, well below the 2-word minimum, so the check does not fire on noise alone.
    expect(body).not.toContain('FIGYELEM')
  })
})

// Card c92c2142, Cybersec's own request after finding the same pattern TWICE in one session
// (65e96a20's static-server.ts, 1f51f050's api-routes.ts) -- an [FE]-labeled card whose own
// Gate: line said QA-only actually carried backend/server code. A NUDGE only, same contract as
// the self-check above: never blocks, never changes the resolved commit.
describe('the [FE]-label-vs-backend-file mechanical warning (card c92c2142)', () => {
  it('warns when an [FE]-tagged card touches a *-server.ts file', () => {
    const body = commitAndBody(
      { 'src/webapp/static-server.ts': 'export const x = 1\n' },
      '[Ingatlan][3c/4][FE] Webapp SPA shell',
    )
    expect(body).toContain('FIGYELEM -- FE-CIMKE VS BACKEND-FAJL')
  })

  it('warns when an [FE]-tagged card touches an *-routes.ts file', () => {
    const body = commitAndBody(
      { 'src/webapp/api-routes.ts': 'export const x = 1\n' },
      '[Ingatlan][3d/4][FE] Hirdetesek nezet',
    )
    expect(body).toContain('FIGYELEM -- FE-CIMKE VS BACKEND-FAJL')
  })

  it('warns when an [FE]-tagged card touches a file under an api/ directory segment', () => {
    const body = commitAndBody({ 'apps/api/handler.ts': 'export const x = 1\n' }, '[FE] some card')
    expect(body).toContain('FIGYELEM -- FE-CIMKE VS BACKEND-FAJL')
  })

  it('stays quiet for an [FE]-tagged card that only touches real frontend files', () => {
    const body = commitAndBody(
      { 'frontend/src/components/HirdetesekView.tsx': 'export const x = 1\n' },
      '[Ingatlan][3d/4][FE] Hirdetesek nezet',
    )
    expect(body).not.toContain('FIGYELEM -- FE-CIMKE VS BACKEND-FAJL')
  })

  it('CONTROL: a frontend api-client.ts does NOT false-positive -- "api" as a filename prefix is not a path segment', () => {
    const body = commitAndBody(
      { 'frontend/src/api-client.ts': 'export const x = 1\n' },
      '[Ingatlan][3c/4][FE] Webapp SPA shell',
    )
    expect(body).not.toContain('FIGYELEM -- FE-CIMKE VS BACKEND-FAJL')
  })

  it('stays quiet when the backend file is touched but the card has no [FE] tag', () => {
    const body = commitAndBody(
      { 'src/webapp/static-server.ts': 'export const x = 1\n' },
      '[Ingatlan][3c/4][BE] Static file server',
    )
    expect(body).not.toContain('FIGYELEM -- FE-CIMKE VS BACKEND-FAJL')
  })

  it('no title given (offline manual use) -- the check is skipped, not a false warning', () => {
    const body = commitAndBody({ 'src/webapp/static-server.ts': 'export const x = 1\n' })
    expect(body).not.toContain('FIGYELEM -- FE-CIMKE VS BACKEND-FAJL')
  })
})

// Card 78f85eb1: three cards in a row (fed9409f, ced9ce80, 398f351b) failed QA solely for a missing
// DECISIONS.md entry, even though the code itself was pass-ready every time -- a missing
// definition-of-done step, not three independent oversights. Nudge only, same contract as the other
// checks: never blocks or changes the resolved commit.
describe('the missing-DECISIONS.md nudge (card 78f85eb1)', () => {
  it('warns when the title reads as an architecture decision and DECISIONS.md is untouched', () => {
    const body = commitAndBody(
      { 'src/auth.ts': 'export const x = 1\n' },
      '[CleanCore][BE][SEC] Architektura-dontes: uj auth-ut bevezetese',
    )
    expect(body).toContain('FIGYELEM -- HIANYZO DECISIONS.md')
  })

  it('warns when the DESCRIPTION (not the title) mentions PLAN-GRILLING and DECISIONS.md is untouched', () => {
    const body = commitAndBody(
      { 'src/auth.ts': 'export const x = 1\n' },
      '[CleanCore][BE] Uj auth-ut',
      'A PLAN-GRILLING verdikt alapjan bevezetjuk az uj folyamatot.',
    )
    expect(body).toContain('FIGYELEM -- HIANYZO DECISIONS.md')
  })

  it('matches the correctly-accented Hungarian form too (architektúra-döntés)', () => {
    const body = commitAndBody(
      { 'src/auth.ts': 'export const x = 1\n' },
      '[CleanCore][BE] architektúra-döntés az uj auth-utrol',
    )
    expect(body).toContain('FIGYELEM -- HIANYZO DECISIONS.md')
  })

  it('stays quiet when DECISIONS.md IS part of the diff', () => {
    const body = commitAndBody(
      { 'src/auth.ts': 'export const x = 1\n', 'DECISIONS.md': '## entry\n' },
      '[CleanCore][BE][SEC] Architektura-dontes: uj auth-ut bevezetese',
    )
    expect(body).not.toContain('FIGYELEM -- HIANYZO DECISIONS.md')
  })

  it('stays quiet for an ordinary card with no architecture/plan-grilling wording', () => {
    const body = commitAndBody(
      { 'src/auth.ts': 'export const x = 1\n' },
      '[CleanCore][BE] fix off-by-one in pagination',
    )
    expect(body).not.toContain('FIGYELEM -- HIANYZO DECISIONS.md')
  })

  it('no title/desc given (offline manual use) -- the check is skipped, not a false warning', () => {
    const body = commitAndBody({ 'src/auth.ts': 'export const x = 1\n' })
    expect(body).not.toContain('FIGYELEM -- HIANYZO DECISIONS.md')
  })
})

describe('the stale Pair-FE/Pair-BE Gate-SHA nudge (card 367c23a9)', () => {
  it('warns when the embedded Gate-SHA no longer matches the peer card\'s latest one', () => {
    const body = commitAndBody(
      { 'src/x.ts': 'export const x = 1\n' },
      '[Fron Ted][FE] repo-card new row',
      'Pair-BE: abcdef01\nA BE resz landolt.\nGate-SHA: 1111111',
      '2222222',
    )
    expect(body).toContain('FIGYELEM -- ELAVULT PAIR GATE-SHA')
    expect(body).toContain('1111111')
    expect(body).toContain('2222222')
  })

  it('stays quiet when the embedded Gate-SHA still matches the peer\'s latest one', () => {
    const body = commitAndBody(
      { 'src/x.ts': 'export const x = 1\n' },
      '[Fron Ted][FE] repo-card new row',
      'Pair-BE: abcdef01\nGate-SHA: 1111111',
      '1111111',
    )
    expect(body).not.toContain('FIGYELEM -- ELAVULT PAIR GATE-SHA')
  })

  it('stays quiet when the peer sha is a longer, still-matching prefix (short vs. full sha)', () => {
    const body = commitAndBody(
      { 'src/x.ts': 'export const x = 1\n' },
      '[Fron Ted][FE] repo-card new row',
      'Pair-BE: abcdef01\nGate-SHA: 1111111',
      '11111117890abc',
    )
    expect(body).not.toContain('FIGYELEM -- ELAVULT PAIR GATE-SHA')
  })

  it('stays quiet when the description has no embedded Gate-SHA to compare', () => {
    const body = commitAndBody(
      { 'src/x.ts': 'export const x = 1\n' },
      '[Fron Ted][FE] repo-card new row',
      'Pair-BE: abcdef01\nNincs meg landolva BE oldalon.',
      '2222222',
    )
    expect(body).not.toContain('FIGYELEM -- ELAVULT PAIR GATE-SHA')
  })

  it('stays quiet when no peer Gate-SHA was resolved (offline manual use, or no Pair-* line)', () => {
    const body = commitAndBody(
      { 'src/x.ts': 'export const x = 1\n' },
      '[Fron Ted][FE] repo-card new row',
      'Gate-SHA: 1111111',
    )
    expect(body).not.toContain('FIGYELEM -- ELAVULT PAIR GATE-SHA')
  })
})

// Card 5b4cca21, Cybersec's live finding on commit 2c56d300 (card 132a6cfb comment 15118): a MERGE
// commit's first parent is not always trunk. The standard land (marveen-land.sh / cleancore-land.sh)
// checks out trunk and merges the agent branch IN, so parent 1 IS trunk -- but an agent's own ad-hoc
// "sync my branch against origin/<trunk> mid-landing" puts trunk in parent 2 instead, and diffing
// against parent 1 there shows what trunk brought (someone else's already-landed card), not what this
// branch itself contributed. These tests build both merge topologies directly and diff the resolved
// commit through the SAME `--repo/--sha/--dry-run` offline core the wiring uses, so the fix is pinned
// against the real script, not a reimplementation of it.
describe('merge-commit diff base (card 5b4cca21)', () => {
  it('reversed topology (trunk is parent 2): reports THIS card\'s own file, not the other card trunk brought in', () => {
    const t0 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim() // the seed commit, the fork point

    // "other card" lands on trunk first.
    writeFileSync(join(repo, 'other-card-file.ts'), 'export const other = 1\n')
    git('add', 'other-card-file.ts')
    git('commit', '-q', '-m', 'other card lands on trunk')
    git('branch', '-f', 'origin/develop', 'HEAD') // fake trunk ref (no real remote in a throwaway repo)

    // This card's own branch, forked BEFORE the other card landed.
    git('checkout', '-q', '-b', 'agent-branch', t0)
    writeFileSync(join(repo, 'card-file.ts'), 'export const mine = 1\n')
    git('add', 'card-file.ts')
    git('commit', '-q', '-m', 'this card\'s own work')

    // Ad-hoc sync merge: pull trunk INTO the agent's own branch mid-landing (parent 1 = agent branch,
    // parent 2 = trunk) -- the reversed-from-standard topology that broke pre-triage.
    git('merge', '-q', '--no-ff', 'origin/develop', '-m', 'sync with trunk')
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()

    const body = execFileSync('bash', [SCRIPT, '--repo', repo, '--sha', sha, '--dry-run'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(body).toContain('card-file.ts')
    expect(body).not.toContain('other-card-file.ts')
  })

  it('standard topology (trunk is parent 1): unaffected -- still reports the branch\'s own file', () => {
    git('branch', 'origin/develop', 'HEAD') // trunk ref at the fork point, unmoved

    git('checkout', '-q', '-b', 'feature', 'HEAD')
    writeFileSync(join(repo, 'card-file.ts'), 'export const mine = 1\n')
    git('add', 'card-file.ts')
    git('commit', '-q', '-m', 'card work')
    const featureSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()

    git('checkout', '-q', '-b', 'trunk-work', 'origin/develop')
    git('merge', '-q', '--no-ff', featureSha, '-m', 'land feature') // parent1=trunk, parent2=feature
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()

    const body = execFileSync('bash', [SCRIPT, '--repo', repo, '--sha', sha, '--dry-run'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(body).toContain('card-file.ts')
  })

  it('degenerate case (trunk already advanced to the reviewed sha itself): falls back to the parent-1 diff instead of an empty one', () => {
    git('branch', 'origin/develop', 'HEAD')

    git('checkout', '-q', '-b', 'feature2', 'HEAD')
    writeFileSync(join(repo, 'card-file2.ts'), 'export const mine = 2\n')
    git('add', 'card-file2.ts')
    git('commit', '-q', '-m', 'card work 2')
    const featureSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()

    git('checkout', '-q', '-b', 'trunk-work2', 'origin/develop')
    git('merge', '-q', '--no-ff', featureSha, '-m', 'land feature 2')
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    git('branch', '-f', 'origin/develop', sha) // simulate: trunk was just pushed to this exact sha

    const body = execFileSync('bash', [SCRIPT, '--repo', repo, '--sha', sha, '--dry-run'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    expect(body).toContain('card-file2.ts')
  })
})

describe('offline-core guards', () => {
  it('a commit that does not exist is a benign SKIP, not an error', () => {
    const out = execFileSync(
      'bash',
      [SCRIPT, '--repo', repo, '--sha', 'deadbeefdeadbeef', '--dry-run'],
      { encoding: 'utf-8', stdio: 'pipe' },
    )
    expect(out).toMatch(/SKIP: commit .* not in/)
  })

  it('--repo/--sha without --dry-run refuses (offline mode never posts)', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
    let code = 0
    try {
      execFileSync('bash', [SCRIPT, '--repo', repo, '--sha', sha], { stdio: 'pipe' })
    } catch (e) {
      code = (e as { status?: number }).status ?? 1
    }
    expect(code).toBe(2)
  })

  it('missing args is a usage error (exit 2)', () => {
    let code = 0
    try {
      execFileSync('bash', [SCRIPT], { stdio: 'pipe' })
    } catch (e) {
      code = (e as { status?: number }).status ?? 1
    }
    expect(code).toBe(2)
  })
})

// Security regression (card 83191d8d, Cybersec NO-GO): the dashboard token must NEVER reach a curl
// command line -- /proc/<pid>/cmdline is world-readable. This runs at EVERY gate, so a leak here is a
// full /api compromise. Pin the 0600 @headerfile pattern in the source so a future edit cannot regress it.
describe('the token is never passed in a curl argv (Cybersec)', () => {
  const src = readFileSync(SCRIPT, 'utf-8')
  const code = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')

  it('every curl reads the auth header from a file (-H @<file>), never a literal Authorization arg', () => {
    const curls = code.split('\n').filter((l) => /\bcurl\b/.test(l))
    expect(curls.length).toBeGreaterThan(0)
    for (const c of curls) {
      if (!/Authorization|hdr_file|-H @/.test(c)) continue // a curl with no auth at all is fine
      expect(c).toMatch(/-H @"\$hdr_file"/)
      expect(c).not.toMatch(/-H ["']?Authorization/) // no inline Authorization header
      expect(c).not.toMatch(/\$\(cat[^)]*TOKEN/) // no `$(cat ...token)` on the command line
    }
  })

  it('uses a private 0600 temp header file, cleaned up on EXIT', () => {
    expect(code).toContain('chmod 600')
    expect(code).toMatch(/trap\s+cleanup\s+EXIT/)
    expect(code).toContain("printf 'Authorization: Bearer %s")
  })

  it('does NOT define the old auth() helper that returned the header for an argv -H', () => {
    expect(code).not.toMatch(/auth\(\)\s*\{/)
    expect(code).not.toContain('-H "$(auth)"')
  })
})

// Card 928251b5. The tests above exercise the offline `--repo --sha` core -- the INPUT body it
// writes for a commit it was HANDED. This block covers the step before that: WHICH commit it picks
// out of the card's comments, which is where the false positive lived.
//
// On card 54d4a4a3 a hex quoted in Cybersec's prose (`ee864511`, whose own message says
// `(card 550befbf)`) resolved to a real commit, so pre-triage posted a verdict:null round for it.
// The close-time dependency check read that as a NEW gate round, a valid Cybersec GO went "stale",
// and the card had to be closed with force:true over a commit nobody on it wrote.
describe('candidate attribution (card 928251b5)', () => {
  const STORE = join(import.meta.dirname, '..', '..', 'store')

  it('ships the predicate and its selftest', () => {
    expect(existsSync(join(STORE, 'gate-pretriage-attribution.sh'))).toBe(true)
    expect(existsSync(join(STORE, 'gate-pretriage-attribution.selftest.sh'))).toBe(true)
  })

  it('its selftest passes against REAL git repos, and counts its cases', () => {
    const out = execFileSync('bash', [join(STORE, 'gate-pretriage-attribution.selftest.sh')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    expect(out).toMatch(/selftest: [1-9]\d* case\(s\), PASS/)
  })

  // THE WIRING. The selftest proves the predicate; this proves pre-triage actually consults it, and
  // passes the card it is running for rather than some default.
  it('gate-pretriage-card.sh sources it and asks about THIS card', () => {
    const src = readFileSync(join(STORE, 'gate-pretriage-card.sh'), 'utf-8')
    expect(src).toContain('gate-pretriage-attribution.sh')
    expect(src).toContain('names_another_card "$r" "$cand" "$CARD"')
  })

  // Exclusion, not preference -- and the distinction is the fix. kanban-landed-guard's
  // attributedToCard prefers commits naming the card and keeps everything when none does; correct
  // there, useless here, because NO commit names 54d4a4a3 at all.
  it('keeps a commit that names no card, so a rebase or cherry-pick is not narrowed away', () => {
    const src = readFileSync(join(STORE, 'gate-pretriage-attribution.sh'), 'utf-8')
    expect(src).toContain('names no card')
    expect(src).toContain('EXCLUSION, NOT PREFERENCE')
  })
})
