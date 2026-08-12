// gate-pretriage-card.sh: the wiring that runs the local pre-triage for ONE card and formats the
// verdict:null INPUT comment the gate-reconciler posts before dispatching a gate (card 83191d8d).
//
// The API-driven card resolution (cardId -> repo + REVIEW commit) is exercised live; here we test the
// deterministic OFFLINE CORE (`--repo <path> --sha <sha> --dry-run`) against a throwaway git repo, so
// the comment body's SHAPE and the "never a verdict" contract are pinned without touching the network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
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
 *  `title` (optional) exercises the card-title-vs-changed-files self-check (card ce159d2b). */
function commitAndBody(files: Record<string, string>, title?: string): string {
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
