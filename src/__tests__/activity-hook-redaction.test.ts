// The activity-capture hook's secret redaction, dragged into the suite that actually runs
// (card 5472cfa9).
//
// WHY THIS FILE EXISTS. scripts/hooks/activity-memory-capture.selftest.py already carried the
// redaction fixtures -- and NOTHING RAN IT. That is not a theoretical cost: card 0c5423fc added a
// DB-connection-string redaction pattern, landed it in a near-identical sibling file that nothing
// executes, and closed as done. The live hook -- which runs on EVERY tool call and writes to the
// memories table -- went on returning connection-string passwords unredacted, and no test noticed,
// because the change shipped without one and the selftest that would have hosted it was never
// invoked.
//
// Two independent failures had to line up: a fix in the wrong file, and a test harness with no
// runner. This file removes the second, which is the one that let the first stay invisible.
//
// Same pattern as llm-catalog-contract.test.ts, for the same stated reason: a selftest that only
// executes when someone remembers to type its name is documentation, not a gate.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const HOOKS = join(ROOT, 'scripts', 'hooks')
const LIVE_HOOK = join(HOOKS, 'activity_memory_capture.py')
const SELFTEST = join(HOOKS, 'activity-memory-capture.selftest.py')

function run(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 120_000 })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Redact one string through the LIVE hook module -- the file settings.json actually wires. */
function redactViaLiveHook(text: string): string {
  const script = [
    'import importlib.util, sys, json',
    `spec = importlib.util.spec_from_file_location("amc", ${JSON.stringify(LIVE_HOOK)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'sys.stdout.write(m._redact(json.loads(sys.argv[1])))',
  ].join('\n')
  const r = spawnSync('python3', ['-c', script, JSON.stringify(text)], {
    encoding: 'utf-8',
    timeout: 60_000,
  })
  expect(r.status, `python failed: ${r.stderr ?? ''}`).toBe(0)
  return r.stdout ?? ''
}

describe('the activity-capture hook selftest actually runs (card 5472cfa9)', () => {
  it('the selftest exists and passes', () => {
    expect(existsSync(SELFTEST)).toBe(true)
    const { code, out } = run('python3', [SELFTEST])
    // Assert on the parts that carry meaning, not the sentence: a count greater than zero and an
    // explicit zero failures. Matching the prose verbatim makes this test break on a reworded
    // summary line, which is noise rather than signal.
    expect(out).toMatch(/OK: all [1-9]\d* /)
    expect(out).toContain('(0 failures)')
    expect(code).toBe(0)
  })

  it('reports a COUNTED number of checks, not a literal', () => {
    // The report line used to read `30 - len(FAILURES)`, so it printed "30" whatever the file
    // contained. A harness that misstates its own coverage is the wrong thing to trust while
    // auditing a redaction path.
    const source = readFileSync(SELFTEST, 'utf-8')
    expect(source).not.toMatch(/\{\s*\d+\s*-\s*len\(FAILURES\)\s*\}/)
  })
})

describe('the LIVE hook module redacts secrets (card 5472cfa9)', () => {
  // Deliberately exercised through the file settings.json names, resolved by absolute path. The
  // defect this card closes was precisely that a fix lived in a file with a nearly identical name
  // that nothing loads, so a test importing "the module" by convenience would have proven nothing.
  it('is the file the PostToolUse hook is wired to', () => {
    const settings = join(ROOT, 'agents', 'backend', '.claude', 'settings.json')
    if (!existsSync(settings)) return // agent dirs are not present in every checkout
    expect(readFileSync(settings, 'utf-8')).toContain('activity_memory_capture.py')
  })

  it.each([
    ['postgres', 'postgres://admin:SuperSecret123@db.internal:5432/cleancore'],
    ['postgresql', 'postgresql://admin:SuperSecret123@db.internal:5432/app'],
    ['mysql', 'mysql://root:SuperSecret123@mysql.internal:3306/app'],
    ['mongodb+srv', 'mongodb+srv://svc:SuperSecret123@cluster.mongodb.net/db'],
    ['redis', 'redis://default:SuperSecret123@redis.internal:6379'],
  ])('never emits a %s connection-string password', (_scheme, uri) => {
    const out = redactViaLiveHook(`psql ${uri}`)
    expect(out).not.toContain('SuperSecret123')
    expect(out).toContain('[REDACTED]')
  })

  it('keeps the host so the trace stays useful', () => {
    const out = redactViaLiveHook('DATABASE_URL=postgres://svc:hunter2hunter2@pg.prod.internal:6432/app')
    expect(out).not.toContain('hunter2hunter2')
    expect(out).toContain('pg.prod.internal')
  })

  it('does not fire on an ordinary URL with no credential', () => {
    const out = redactViaLiveHook('curl https://cleancore.example.com/api/health')
    expect(out).not.toContain('[REDACTED]')
  })

  it('still redacts the token shapes it always did', () => {
    expect(redactViaLiveHook('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123.xyz789sig')).not.toContain(
      'eyJhbGciOiJIUzI1NiJ9',
    )
    expect(redactViaLiveHook('GITHUB_TOKEN=ghp_AAABBBCCCDDDEEEFFFGGGHHH')).not.toContain(
      'ghp_AAABBBCCCDDDEEEFFFGGGHHH',
    )
  })
})

describe('the duplicate that absorbed the misdirected fix is gone (card 5472cfa9)', () => {
  it('no unwired near-twin of the hook remains in scripts/hooks/', () => {
    // While both files existed, a fix could land in the one nothing runs -- and did. This asserts
    // the structural cause is removed, not merely that today's copy is correct.
    expect(existsSync(join(HOOKS, 'activity-memory-capture.py'))).toBe(false)
  })
})
