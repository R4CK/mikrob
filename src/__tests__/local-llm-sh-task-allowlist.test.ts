// store/local-llm.sh --task path-traversal guard (card 2de47a4e; the shell sibling of 18a0acb9,
// which closed the same class on POST /api/local-llm/categories).
//
// The finding: `TASK` was joined into "$SKILL_DIR/$TASK.txt" and only checked with `[[ -f ]]`, which
// tests existence, not charset. A `--task ../../something` could read a .txt OUTSIDE the skills dir
// into the local model's prompt. The fix is a charset allowlist that runs BEFORE the join, matching
// isValidCategoryName in the API route.
//
// Behavioural, not source-level: the allowlist `die` fires right after the prompt is gathered and
// BEFORE any template read or ollama call, so we can run the real script and prove the rejection with
// no local model up. We assert both that it exits non-zero AND that it failed on the allowlist
// ("invalid --task"), not on the later existence probe ("unknown --task") -- that ordering is the fix.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'local-llm.sh')

/** Run local-llm.sh and return { status, stderr }. execFileSync throws on non-zero exit, so a
 *  rejection lands in the catch with the child's status + captured stderr. */
function run(task: string): { status: number; stderr: string } {
  try {
    execFileSync('bash', [SCRIPT, '--task', task, 'a prompt'], { encoding: 'utf-8', stdio: 'pipe' })
    return { status: 0, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stderr?: string }
    return { status: err.status ?? -1, stderr: String(err.stderr ?? '') }
  }
}

describe('local-llm.sh --task allowlist (card 2de47a4e)', () => {
  it('rejects a path-traversal task on the allowlist, BEFORE the filesystem probe', () => {
    const r = run('../../etc/passwd')
    expect(r.status).not.toBe(0) // did not proceed
    expect(r.stderr).toContain('invalid --task') // failed on the charset allowlist...
    expect(r.stderr).not.toContain('unknown --task') // ...not on the later `[[ -f ]]` existence check
  })

  it('rejects every traversal / metacharacter variant', () => {
    for (const bad of ['../foo', 'a/b', 'foo.txt', '..', 'a b', 'UP', 'foo;id', 'a'.repeat(65)]) {
      const r = run(bad)
      expect(r.status, `${bad} should be rejected`).not.toBe(0)
      expect(r.stderr, `${bad} should hit the allowlist`).toContain('invalid --task')
    }
  })
})
