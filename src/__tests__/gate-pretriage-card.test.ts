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

/** Commit `files` and return the pre-triage INPUT comment body the wiring would post for that commit. */
function commitAndBody(files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(repo, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'change')
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
  return execFileSync('bash', [SCRIPT, '--repo', repo, '--sha', sha, '--dry-run'], {
    encoding: 'utf-8',
    stdio: 'pipe',
  })
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
