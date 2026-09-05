// store/skill-merge-check.py catches a merge that PRESERVED a superseded command form
// (card 30b76a8d, Cybersec NO-GO comment 20441).
//
// The defect it exists for: un-shadowing a per-agent skill copy is a merge under the invariant
// "no line from either side may be lost". That is right for ADDITIVE content and wrong for
// SUPERSEDED content, and nothing in the invariant separates the two. On gate-worktree-pattern the
// project side had no own content at all -- its five "project-only" lines were the OLD
// two-argument cc-gate-worktree.sh call that card a7da80d6 replaced and that exits 2 today. The
// merge kept them AHEAD of the working --agent form, so four gate agents were shown a dead command
// first.
//
// The signal is NOT "the result mentions a script more often": project-only content legitimately
// does that (measured: five identical, correct invocations in i18n-parity-sweep, which a
// count-based first attempt flagged). It is "the same script invoked in two forms where one is the
// other MINUS some arguments" -- which is exactly what a required new flag leaves behind.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const TOOL = join(REPO_ROOT, 'store/skill-merge-check.py')

function run(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('python3', [TOOL, ...args], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    return { code: err.status ?? -1, out: err.stdout ?? '' }
  }
}

function pair(result: string, source: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mergecheck-'))
  try {
    writeFileSync(join(dir, 'result.md'), result)
    writeFileSync(join(dir, 'source.md'), source)
    return run([join(dir, 'result.md'), join(dir, 'source.md')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SOURCE = [
  'WT=$(bash store/cc-gate-worktree.sh --agent <you> --path <card> <sha>)',
  'bash store/cc-gate-worktree.sh --agent <you> --remove "$WT"',
  '',
].join('\n')

describe('store/skill-merge-check.py (card 30b76a8d)', () => {
  it('passes its own selftest -- a guard never run against its founding case is not evidence', () => {
    const r = run(['--selftest'])
    expect(r.out).toMatch(/selftest: PASS/)
    expect(r.code).toBe(0)
  })

  it('THE DEFECT: the superseded two-argument form kept beside the --agent one is flagged', () => {
    const merged = 'WT=$(bash store/cc-gate-worktree.sh --path <card> <sha>)\n' + SOURCE
    const r = pair(merged, SOURCE)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/cc-gate-worktree\.sh is invoked BOTH ways/)
    expect(r.out, 'the report must name the arguments that went missing').toMatch(/--agent/)
  })

  it('CONTROL: using the same script MORE OFTEN, in the one correct form, is clean', () => {
    // The first implementation was count-based and failed exactly here, on real content:
    // project-only material may legitimately invoke a script several times.
    const merged = SOURCE + SOURCE + SOURCE
    expect(pair(merged, SOURCE).code).toBe(0)
  })

  it('CONTROL: a pair that ALREADY exists in the source is not the merge\'s doing', () => {
    // Otherwise the check would fire forever on a file whose authoritative copy documents both
    // an old and a new form on purpose, and nobody would read its output twice.
    const both = 'bash store/x.sh --path a b\nbash store/x.sh --agent me --path a b\n'
    expect(pair(both, both).code).toBe(0)
  })

  it('CONTROL: an unrelated prose addition with no invocation is clean', () => {
    expect(pair(SOURCE + '\nSome added guidance, no command in it.\n', SOURCE).code).toBe(0)
  })
})
