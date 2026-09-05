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
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'local-llm.sh')

// A CONFIGURED state dir of our own (card 4c5c540c). read_model() runs BEFORE the --task
// allowlist and dies with "no model configured" when the model file is missing, so these cases
// only ever reached the allowlist because the script was reading the LIVE install's state --
// the same coupling that had the suite appending test rows to the production usage ledger.
// Borrowing a precondition from the running install makes a test pass for a reason it does not
// state; this sets it explicitly. The ordering under test (charset check before the `[[ -f ]]`
// existence probe) is unchanged and still what the assertions below pin.
let stateDir: string

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'local-llm-task-allowlist-'))
  writeFileSync(join(stateDir, 'local-llm-model'), 'qwen2.5-coder:7b\n')
})

/** Run local-llm.sh and return { status, stderr }. execFileSync throws on non-zero exit, so a
 *  rejection lands in the catch with the child's status + captured stderr. */
function run(task: string): { status: number; stderr: string } {
  try {
    execFileSync('bash', [SCRIPT, '--task', task, 'a prompt'], {
      encoding: 'utf-8', stdio: 'pipe',
      env: { ...process.env, LOCAL_LLM_STATE_DIR: stateDir },
    })
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
