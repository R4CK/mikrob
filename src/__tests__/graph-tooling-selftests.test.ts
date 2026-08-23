// The graph-tooling selftests, enforced in CI (cards 398f351b, 44477615).
//
// WHY THIS FILE EXISTS. Three selftests carry 62 controls between them -- the blast-radius
// measurement, the PreToolUse guard that enforces it, and the code-graph node resolver that feeds
// the local model's dispatch-time context. Nothing ran any of them. That is the same shape as
// llm-catalog-contract.test.ts's stated reason, and the same shape as the defect BOTH those cards
// were opened to fix: a capability that exists, is documented, and is never invoked.
//
// A selftest that only executes when someone types its name is documentation, not a gate: every
// defect it pins can return in a commit that never invokes it. So they run here, on every change.
//
// Cost is real and deliberate: the guard selftest builds throwaway git repos and spawns the hook
// once per case. It is the price of the controls being live rather than decorative.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

function run(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    timeout: 300_000,
    // The guard resolves its measurement library from its own tree; keep both halves in THIS
    // checkout so the suite tests the code under review, not whatever is installed elsewhere.
    env: { ...process.env, BLAST_RADIUS_STORE: join(ROOT, 'store') },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * "N/N passed", with a FLOOR on N.
 *
 * The floor is the point. Without it a selftest could lose half its cases and still report a green
 * "5/5 passed" here -- and a control that quietly stops covering something is worse than one that
 * goes red, because nothing announces it. Floors are the counts at the time each suite landed;
 * ADDING cases is free, removing them is a failure that names itself.
 *
 * The guard's floor is 25 rather than its current 27: two of its cases need a CleanCore agent
 * worktree that is not guaranteed to exist on every box, and a floor that depends on the
 * environment would be a flake, not a control. Raise the floor whenever cases are added, or the
 * ratchet only ever protects the coverage that existed on day one.
 */
function expectAllPassed(out: string, floor: number): void {
  expect(out).not.toContain('FAIL:')
  const m = out.match(/(\d+)\/(\d+) passed/)
  expect(m, `no "N/N passed" summary in output:\n${out}`).not.toBeNull()
  expect(m![1]).toBe(m![2])
  expect(Number(m![2]), `selftest shrank below its floor:\n${out}`).toBeGreaterThanOrEqual(floor)
}

describe('graph tooling: the selftests actually run in CI', () => {
  it('blast-radius measurement selftest passes', () => {
    const { code, out } = run('python3', [join(ROOT, 'store', 'blast-radius-check.py'), '--selftest'])
    expectAllPassed(out, 13)
    expect(code).toBe(0)
  }, 300_000)

  it('blast-radius PreToolUse guard selftest passes', () => {
    const { code, out } = run('python3', [join(ROOT, 'scripts', 'hooks', 'blast-radius-guard.selftest.py')])
    expectAllPassed(out, 25)
    expect(code).toBe(0)
  }, 300_000)

  it('code-graph node resolver selftest passes', () => {
    const { code, out } = run('python3', [join(ROOT, 'store', 'graphify-resolve.py'), '--selftest'])
    expectAllPassed(out, 27)
    expect(code).toBe(0)
  }, 300_000)
})

// The offload path imports the resolver by PATH at dispatch time; a rename or a lost exec bit makes
// it fail open and silently stop giving the local model any code context -- with nothing to notice.
describe('the files the offload path resolves at runtime', () => {
  it.each([
    ['store/graphify-resolve.py'],
    ['store/blast-radius-check.py'],
    ['scripts/hooks/blast-radius-guard.py'],
  ])('%s exists and is executable', (rel) => {
    const p = join(ROOT, rel)
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o111).toBeGreaterThan(0)
  })

  it('offload-dispatch.sh actually calls the resolver and emits both flags', () => {
    const src: string = require('node:fs').readFileSync(join(ROOT, 'store', 'offload-dispatch.sh'), 'utf-8')
    // Deliberately NOT `toContain('--graph-node')` on the whole file. Every one of these strings
    // also appears in this file's own comments, so a substring check over the file would stay green
    // while the code stopped emitting the flag -- the failure mode these two cards exist to fix.
    // Assert on CODE: the resolver invocation, and the printf that emits the flag pair.
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    expect(code).toMatch(/python3 "\$RESOLVE"/)
    expect(code).toMatch(/printf[^\n]*--graph-repo[^\n]*--graph-node/)
    // ...and that the pair is actually handed to the RAG wrapper, not just built.
    expect(code).toMatch(/CARD_GRAPH\[@\]/)
    expect(code).toMatch(/SUB_GRAPH\[@\]/)
  })
})
