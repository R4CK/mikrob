// gate-pretriage.sh: the LOCAL mechanical first-pass a gate runs before spending online tokens
// (card 7041c165).
//
// Each test builds a THROWAWAY git repo with exactly one planted defect and asserts the matching
// check fires -- and, just as importantly, that it does NOT fire when the pattern was merely MOVED
// rather than introduced. That second half is the point: the script's own first run flagged
// "secret-in-argv" on a commit that only swapped a path inside lines already containing the pattern,
// and a check that fires on untouched risk trains gates to ignore it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'gate-pretriage.sh')

let repo: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
}

/** Commit `files` and return the pre-triage JSON for that single commit. */
function commitAndTriage(files: Record<string, string>, message = 'change'): {
  findings: Array<{ severity: string; check: string; detail: string }>
  verdict: null
  tsc: string
} {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(repo, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  git('add', '-A')
  git('commit', '-q', '-m', message)
  const out = execFileSync('bash', [SCRIPT, '--repo', repo, '--json'], {
    encoding: 'utf-8',
    stdio: 'pipe',
  })
  return JSON.parse(out)
}

const checks = (r: { findings: Array<{ check: string }> }) => r.findings.map((f) => f.check)
const find = (r: { findings: Array<{ check: string; severity: string }> }, name: string) =>
  r.findings.find((f) => f.check === name)

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gate-pretriage-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('gate-pretriage.sh -- it is never a verdict', () => {
  it('always reports verdict: null, whatever it finds', () => {
    const r = commitAndTriage({ 'src/a.ts': 'export const a = 1\n' })
    expect(r.verdict).toBeNull()
  })

  it('exits 0 even when it finds a high-severity item (input to a gate, not a CI blocker)', () => {
    writeFileSync(join(repo, 'run.sh'), 'curl -H "Authorization: Bearer $TOK" x\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'token')
    // execFileSync throws on a non-zero exit; reaching the assertion IS the assertion.
    const out = execFileSync('bash', [SCRIPT, '--repo', repo, '--json'], { encoding: 'utf-8' })
    expect(find(JSON.parse(out), 'secret-in-argv')?.severity).toBe('high')
  })

  it('prints no PASS/FAIL/GO wording that could be mistaken for a sign-off', () => {
    commitAndTriage({ 'src/a.ts': 'export const a = 1\n' })
    const text = execFileSync('bash', [SCRIPT, '--repo', repo], { encoding: 'utf-8' })
    expect(text).not.toMatch(/\b(PASS|FAIL|NO-GO|GO)\b/)
    expect(text).toMatch(/not a verdict/i)
  })
})

describe('gate-pretriage.sh -- checks fire on a planted defect', () => {
  it('flags changed code with no changed test', () => {
    const r = commitAndTriage({ 'src/thing.ts': 'export function thing() { return 1 }\n' })
    expect(checks(r)).toContain('no-test-for-changed-code')
  })

  it('flags a new exported symbol no test mentions', () => {
    const r = commitAndTriage({
      'src/thing.ts': 'export function neverTested() { return 1 }\n',
      'src/thing.test.ts': "import { it } from 'vitest'\nit('x', () => {})\n",
    })
    expect(find(r, 'exported-symbol-untested')?.detail).toContain('neverTested')
  })

  it('does NOT flag an exported symbol a test does reference', () => {
    const r = commitAndTriage({
      'src/thing.ts': 'export function isTested() { return 1 }\n',
      'src/thing.test.ts': "import { it } from 'vitest'\nit('x', () => { isTested() })\n",
    })
    expect(checks(r)).not.toContain('exported-symbol-untested')
  })

  it('flags a newly added .not.toBe assertion as possibly vacuous', () => {
    const r = commitAndTriage({
      'src/x.ts': 'export const x = 1\n',
      'src/x.test.ts': "expect(collapse('a')).not.toBe('a')\n",
    })
    expect(find(r, 'possibly-vacuous-assertion')?.severity).toBe('warn')
  })

  it('flags a newly skipped test', () => {
    const r = commitAndTriage({
      'src/y.ts': 'export const y = 1\n',
      'src/y.test.ts': "it.skip('later', () => {})\n",
    })
    expect(checks(r)).toContain('skipped-test-added')
  })

  it('flags a token placed on a command line', () => {
    const r = commitAndTriage({ 'ops.sh': 'curl -H "Authorization: Bearer $TOKEN" https://x\n' })
    expect(find(r, 'secret-in-argv')?.severity).toBe('high')
  })

  it('flags a newly added inline style (CSP, invisible to jsdom)', () => {
    const r = commitAndTriage({ 'ui/Page.tsx': 'export const P = () => <div style={{ color: "red" }} />\n' })
    expect(find(r, 'csp-inline-style')?.severity).toBe('warn')
  })

  it('flags a migration with no IF NOT EXISTS / backfill / rollback note', () => {
    const r = commitAndTriage({ 'migrations/0001_x.sql': 'ALTER TABLE t ADD COLUMN c TEXT;\n' })
    expect(checks(r)).toContain('migration-no-safety-note')
  })

  it('does NOT flag a migration that carries one', () => {
    const r = commitAndTriage({
      'migrations/0002_y.sql': '-- backfill: existing rows are pre-feature\nALTER TABLE t ADD COLUMN IF NOT EXISTS c TEXT;\n',
    })
    expect(checks(r)).not.toContain('migration-no-safety-note')
  })

  it('warns when a tsconfig excludes test files (tsc --noEmit then cannot see them)', () => {
    const r = commitAndTriage({
      'tsconfig.json': JSON.stringify({ exclude: ['node_modules', '**/*.test.ts'] }, null, 2),
    })
    expect(checks(r)).toContain('tsc-excludes-tests')
    // ...and a compiler that could not run must NOT be reported as a clean/errored type-check.
    expect(r.tsc).toBe('unavailable')
    expect(checks(r)).toContain('tsc-unavailable')
    expect(checks(r)).not.toContain('tsc-errors')
  })
})

describe('gate-pretriage.sh -- net-new, not merely touched', () => {
  it('does NOT raise secret-in-argv when the line is only MOVED/edited around the pattern', () => {
    // The pattern already exists...
    writeFileSync(join(repo, 'ops.sh'), 'curl -H "Authorization: Bearer $TOK" http://old/api\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'pre-existing')
    // ...and this commit only changes the URL on that same line.
    const r = commitAndTriage({ 'ops.sh': 'curl -H "Authorization: Bearer $TOK" http://new/api\n' })
    const f = find(r, 'secret-in-argv')
    expect(f?.severity).toBe('info')
    expect(f?.detail).toMatch(/none net-new/)
  })

  it('DOES raise it when a second occurrence is genuinely added', () => {
    writeFileSync(join(repo, 'ops.sh'), 'curl -H "Authorization: Bearer $TOK" http://a\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'pre-existing')
    const r = commitAndTriage({
      'ops.sh': 'curl -H "Authorization: Bearer $TOK" http://a\ncurl -H "Authorization: Bearer $TOK" http://b\n',
    })
    expect(find(r, 'secret-in-argv')?.severity).toBe('high')
  })

  it('reports info (not warn) for a moved inline style', () => {
    mkdirSync(join(repo, 'ui'), { recursive: true })
    writeFileSync(join(repo, 'ui/P.tsx'), 'const P = () => <div style={{ color: "red" }} />\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'pre-existing')
    const r = commitAndTriage({ 'ui/P.tsx': 'const P = () => <div style={{ color: "blue" }} />\n' })
    expect(find(r, 'csp-inline-style')?.severity).toBe('info')
  })
})

describe('gate-pretriage.sh -- usage', () => {
  it('rejects a non-repo path with exit 2 rather than reporting a clean run', () => {
    let code = 0
    try {
      execFileSync('bash', [SCRIPT, '--repo', tmpdir()], { stdio: 'pipe' })
    } catch (e) {
      code = (e as { status: number }).status
    }
    expect(code).toBe(2)
  })

  it('a clean commit produces an empty finding list, not a fabricated one', () => {
    const r = commitAndTriage({ 'README.md': '# docs only\n' })
    expect(r.findings).toEqual([])
  })
})
