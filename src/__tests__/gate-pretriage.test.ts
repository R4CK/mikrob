// gate-pretriage.sh: the LOCAL mechanical first-pass a gate runs before spending online tokens
// (card 7041c165).
//
// Each test builds a THROWAWAY git repo with exactly one planted defect and asserts the matching
// check fires -- and, just as importantly, that it does NOT fire when the pattern was merely MOVED
// rather than introduced. That second half is the point: the script's own first run flagged
// "secret-in-argv" on a commit that only swapped a path inside lines already containing the pattern,
// and a check that fires on untouched risk trains gates to ignore it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
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
type Finding = { severity: string; check: string; detail: string }
const find = (r: { findings: Finding[] }, name: string): Finding | undefined =>
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

  // Card b143a439, Cybered's finding: the note above fired on EVERY CleanCore card regardless of
  // whether the changed file was already covered by a SEPARATE project in the typecheck chain that
  // DOES include test files (packages/control-plane/tsconfig.test.json, root tsconfig.tests.json --
  // card 2c0b2002's real 7-member chain). A gate had already taken the note as fact once, unverified.
  it('does NOT warn when a per-package tsconfig.test.json exists elsewhere in the tree', () => {
    const r = commitAndTriage({
      'tsconfig.json': JSON.stringify({ exclude: ['node_modules', '**/*.test.ts'] }, null, 2),
      'packages/control-plane/tsconfig.test.json': JSON.stringify({ include: ['**/*.test.ts'] }, null, 2),
    })
    expect(checks(r)).not.toContain('tsc-excludes-tests')
  })

  it('does NOT warn when a root tsconfig.tests.json exists', () => {
    const r = commitAndTriage({
      'tsconfig.json': JSON.stringify({ exclude: ['node_modules', '**/*.test.ts'] }, null, 2),
      'tsconfig.tests.json': JSON.stringify({ include: ['packages/**/*.test.ts'] }, null, 2),
    })
    expect(checks(r)).not.toContain('tsc-excludes-tests')
  })

  it('CONTROL: a DIFFERENTLY-named project file (not tsconfig.test.json / tsconfig.tests.json) does not suppress the warning', () => {
    // Otherwise this fix would silence the note on any tsconfig sprawl, not specifically the
    // test-covering chain members it exists to recognise.
    const r = commitAndTriage({
      'tsconfig.json': JSON.stringify({ exclude: ['node_modules', '**/*.test.ts'] }, null, 2),
      'packages/control-plane/tsconfig.json': JSON.stringify({ compilerOptions: {} }, null, 2),
    })
    expect(checks(r)).toContain('tsc-excludes-tests')
  })

  // The OTHER direction, and the one that keeps the fix honest (card aae6632c). Reporting
  // "unavailable" unconditionally would make the test above pass while silently disabling the
  // type-check for every repo. So: give the fixture a local ./node_modules/.bin/tsc and prove the
  // script actually RUNS it and reports what it says.
  it('runs the repo OWN tsc when there is one, instead of reporting it unavailable', () => {
    const bin = join(repo, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    // A stand-in compiler: exits non-zero and prints one `error TS` line, like tsc would.
    writeFileSync(join(bin, 'tsc'), '#!/usr/bin/env bash\necho "src/x.ts(1,1): error TS2304: planted."\nexit 2\n')
    chmodSync(join(bin, 'tsc'), 0o755)
    try {
      const r = commitAndTriage({ 'tsconfig.json': JSON.stringify({ compilerOptions: {} }, null, 2) }, 'local tsc')
      expect(r.tsc, 'the local compiler was not run -- the lookup regressed to "unavailable"').toBe('errors:1')
      expect(checks(r)).toContain('tsc-errors')
      expect(checks(r)).not.toContain('tsc-unavailable')
    } finally {
      rmSync(join(repo, 'node_modules'), { recursive: true, force: true })
    }
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

describe('gate-pretriage.sh -- --trunk land parity is opt-in (card a42d27e1)', () => {
  // The real land-parity behaviour (merge + lint-ratchet + importer sweep against the ACTUAL
  // marveen repo, verified by hand against 3 real historical incidents: 2ba008f2 @13ae7ee37,
  // 9ea8dcb8 @5b5875695, 56344ff4 @093280a1d, plus a clean control at 517ba7f6 @b777d9b5d) is not
  // re-fixtured here -- it needs a real git merge, a real lint-ratchet.sh/ESLint config and a real
  // fleet-test.sh run, none of which a throwaway one-commit repo can cheaply stand in for. What a
  // fixture repo CAN prove, cheaply and deterministically, is the opt-in boundary itself: omitting
  // --trunk must never add any land-parity finding, for ANY commit, not just the clean ones above.
  it('never adds a land-parity finding when --trunk is omitted, even with a real conflict present', () => {
    // Plant the exact shape that --trunk WOULD flag (two branches both appending to the same
    // file's tail) and confirm the DEFAULT (no --trunk) run never attempts a merge at all.
    git('checkout', '-q', '-b', 'other')
    writeFileSync(join(repo, 'seed.txt'), 'seed\nother branch addition\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'other branch tail-append')
    git('checkout', '-q', 'master')
    writeFileSync(join(repo, 'seed.txt'), 'seed\nmaster branch addition\n')
    const r = commitAndTriage({})
    for (const check of [
      'land-parity-merge',
      'decisions-union-would-refuse',
      'land-merge-conflicts',
      'lint-ratchet-regression',
      'lint-ratchet-unmeasured',
      'importer-sweep-red',
      'importer-sweep-green',
      'importer-sweep-empty',
      'land-parity-skipped',
    ]) {
      expect(find(r, check), `${check} must not appear without --trunk`).toBeUndefined()
    }
  })

  it('--trunk pointed at an unresolvable ref reports land-parity-skipped, not a crash', () => {
    const out = execFileSync(
      'bash',
      [SCRIPT, '--repo', repo, '--trunk', 'refs/does-not-exist', '--json'],
      { encoding: 'utf-8' },
    )
    const r = JSON.parse(out) as { findings: Finding[] }
    expect(find(r, 'land-parity-skipped')?.severity).toBe('info')
  })
})

describe('gate-pretriage.sh -- --trunk trust boundary (F1/F2, cybersec GO 20497 on card a42d27e1)', () => {
  it('F1: skips lint-ratchet/importer-sweep execution when the diff touches a harness/config file, instead of running branch-controlled harness code unattended', () => {
    // trunk branches off AFTER package.json already exists, so master's later edit is a genuine
    // content diff against trunk, not an add/add conflict from two independent additions.
    writeFileSync(join(repo, 'package.json'), '{\n  "name": "fixture-base"\n}\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base package.json')
    git('checkout', '-q', '-b', 'trunk')
    git('checkout', '-q', 'master')
    writeFileSync(join(repo, 'package.json'), '{\n  "name": "fixture-head"\n}\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'head package.json change')
    const out = execFileSync(
      'bash',
      [SCRIPT, '--repo', repo, '--trunk', 'trunk', '--head', 'master', '--json'],
      { encoding: 'utf-8' },
    )
    const r = JSON.parse(out) as { findings: Finding[] }
    const skipped = find(r, 'land-parity-measurement-skipped')
    expect(skipped?.severity).toBe('info')
    expect(skipped?.detail).toMatch(/package\.json/)
    for (const check of [
      'lint-ratchet-regression',
      'lint-ratchet-unmeasured',
      'importer-sweep-red',
      'importer-sweep-green',
      'importer-sweep-empty',
      'importer-sweep-unmeasured',
    ]) {
      expect(find(r, check), `${check} must not appear when harness/config is touched`).toBeUndefined()
    }
  })

  it('F2: a fleet-test.sh setup failure (rc=3, no FAIL line) reports importer-sweep-unmeasured, never a false red', () => {
    mkdirSync(join(repo, 'src/__tests__'), { recursive: true })
    mkdirSync(join(repo, 'store'), { recursive: true })
    writeFileSync(join(repo, 'src/thing.ts'), 'export function thing() { return 1 }\n')
    writeFileSync(join(repo, 'src/__tests__/thing.test.ts'), 'import { thing } from "../thing"\n')
    // A fake fleet-test.sh standing in for "died in the CPU-slot/lock queue before a single test
    // ran" -- the real die() call sites exit 2 (bad usage) or 3 (harness/setup fault), never with
    // a vitest FAIL/"N failed" line, which is exactly the shape F2 must not mistake for a red.
    writeFileSync(
      join(repo, 'store/fleet-test.sh'),
      '#!/usr/bin/env bash\necho "fleet-test.sh: no shared CPU slot after 15 min" >&2\nexit 3\n',
    )
    chmodSync(join(repo, 'store/fleet-test.sh'), 0o755)
    git('add', '-A')
    git('commit', '-q', '-m', 'base: thing.ts + test + fake fleet-test.sh')
    // trunk branches off AFTER this base, so the only diff master introduces below is thing.ts's
    // body -- not fleet-test.sh itself (F1 would otherwise swallow this test's own target).
    git('checkout', '-q', '-b', 'trunk')
    git('checkout', '-q', 'master')
    writeFileSync(join(repo, 'src/thing.ts'), 'export function thing() { return 2 }\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'head change to thing.ts')
    const out = execFileSync(
      'bash',
      [SCRIPT, '--repo', repo, '--trunk', 'trunk', '--head', 'master', '--json'],
      { encoding: 'utf-8' },
    )
    const r = JSON.parse(out) as { findings: Finding[] }
    expect(find(r, 'importer-sweep-red')).toBeUndefined()
    const unmeasured = find(r, 'importer-sweep-unmeasured')
    expect(unmeasured?.severity).toBe('info')
    expect(unmeasured?.detail).toMatch(/exited 3/)
  })
})
