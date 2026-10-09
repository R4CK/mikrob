// Card 14216622 (Cybered MEDIUM follow-up on da47b612): store/vendored-skill-integrity.py is the
// compensating control the secret-gate exception for the two testing-api-for-broken-object-level-
// authorization JWT-placeholder paths names (DECISIONS.md 2026-09-26) -- but until now nothing ran
// it except its own --selftest against throwaway fixtures (store-selftests-all-run.test.ts). The
// control existed on paper only: a real local tamper on a vendored path would never be reported.
//
// This pins the ALERT:/exit-code CONTRACT a new periodic heartbeat (seed-scheduled-tasks/
// vendored-skill-integrity-heartbeat) depends on, using a throwaway --home fixture -- NOT the live
// machine's actual ~/.claude/skills tree, so this test's result cannot depend on unrelated drift
// on shared live state (the opposite failure mode would make every fleet-test run couple to
// whatever some other agent's live skill directory happens to look like right now).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'vendored-skill-integrity.py')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** A minimal vendored-skill fixture under <home>/.claude/skills/demo, with its own tiny upstream
 *  clone -- enough for skill_roots()/inspect() to find and verify it, same shape as the Python
 *  script's own selftest() fixtures. */
function buildFixture(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'vsi-wired-'))
  const clone = join(home, 'upstream-clone')
  mkdirSync(clone, { recursive: true })
  git(clone, 'init', '-q', '.')
  git(clone, 'config', 'user.email', 't@t')
  git(clone, 'config', 'user.name', 't')
  writeFileSync(join(clone, 'SKILL.md'), 'upstream body\n')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-qm', 'seed')
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf-8' }).trim()

  const skillDir = join(home, '.claude', 'skills', 'demo')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), 'upstream body\n')
  writeFileSync(
    join(skillDir, 'VENDORED.md'),
    `| vendored commit | \`${sha}\` |\n| subdir |  |\n| watch clone | ${clone} |\n| source repo | x |\n`
  )
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function run(home: string, baseline: string, extraArgs: string[] = []): { out: string; code: number } {
  try {
    const out = execFileSync(
      'python3',
      [SCRIPT, '--home', home, '--baseline', baseline, ...extraArgs],
      { encoding: 'utf-8' }
    )
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; status?: number }
    return { out: e.stdout ?? '', code: e.status ?? 1 }
  }
}

describe('vendored-skill-integrity.py: ALERT:/exit-code contract the heartbeat depends on', () => {
  it('an untouched fixture reports ALERT:no and exit 0', () => {
    const { home, cleanup } = buildFixture()
    try {
      const baseline = join(home, 'baseline.json')
      const result = run(home, baseline)
      expect(result.code).toBe(0)
      expect(result.out).toContain('ALERT:no unsanctioned=0')
    } finally {
      cleanup()
    }
  })

  it('MUTATION PROOF: an undocumented local edit flips it to ALERT:yes and exit 1, and --record then clears it', () => {
    const { home, cleanup } = buildFixture()
    try {
      const baseline = join(home, 'baseline.json')
      // Tamper the live copy, same as the da47b612 compensating-control scenario this card closes
      // the gap for: a local edit to a vendored skill with no corresponding sanctioned entry.
      writeFileSync(join(home, '.claude', 'skills', 'demo', 'SKILL.md'), 'tampered body\n')

      const tampered = run(home, baseline)
      expect(tampered.code).toBe(1)
      expect(tampered.out).toContain('ALERT:yes unsanctioned=1')
      expect(tampered.out).toContain('UNSANCTIONED DELTA')

      // Without --record, the tamper must stay visible on a second run -- a transient-only check
      // that quietly waved it through once would defeat the point of a periodic heartbeat.
      const tamperedAgain = run(home, baseline)
      expect(tamperedAgain.code).toBe(1)

      // --record is the deliberate "yes, I accept this delta" act the script's own docstring
      // describes; after it, the SAME tree must report clean.
      const recorded = run(home, baseline, ['--record'])
      expect(recorded.code).toBe(0)
      expect(readFileSync(baseline, 'utf-8')).toContain('changed:SKILL.md@')

      const afterRecord = run(home, baseline)
      expect(afterRecord.code).toBe(0)
      expect(afterRecord.out).toContain('ALERT:no unsanctioned=0')
    } finally {
      cleanup()
    }
  })
})
