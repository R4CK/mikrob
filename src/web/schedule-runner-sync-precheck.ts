import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { logger } from '../logger.js'
import type { ScheduledTask } from './scheduled-tasks-io.js'
import { resolvePreCheckPath, preCheckInvocation, PRECHECK_TIMEOUT_MS, type PreCheckResult } from './schedule-runner.js'

// The synchronous form. Since CRONPRECHECKSYNC1007 the runner calls it from nowhere: both loops
// use runPreCheckAsync (schedule-runner.ts). Kept only as the reference the async form's
// contract tests compare against; do not call it from the runner (it holds the event loop, and
// its timeout ends only the direct child).
//
// Lives in its OWN file, not schedule-runner.ts: card 92e2bb1b's scheduler-tick-nonblocking
// guard does a source-level scan of schedule-runner.ts for spawnSync/execSync/execFileSync,
// because that file's own setInterval tick must never call one synchronously -- this function
// is dead code on that path, but the guard scans TEXT, not the call graph, so the literal
// spawnSync( here would still trip it if it stayed in that file.
export function runPreCheck(task: ScheduledTask): PreCheckResult {
  if (!task.preCheck) return { skip: false }
  // dirName, not name: a relative preCheck lives in the task's OWN directory,
  // which is also what the registry hashed. `name` can come from
  // the SKILL.md frontmatter and point at a different directory.
  const scriptPath = resolvePreCheckPath(task.dirName ?? task.name, task.preCheck)
  if (!existsSync(scriptPath)) {
    logger.warn({ task: task.name, scriptPath }, 'pre-check script not found, running LLM anyway')
    return { skip: false }
  }
  const inv = preCheckInvocation(task, scriptPath)
  if ('result' in inv) return inv.result
  try {
    const r = spawnSync('bash', inv.args, { timeout: PRECHECK_TIMEOUT_MS, encoding: 'utf-8' })
    if (r.error) {
      logger.warn({ task: task.name, error: r.error.message }, 'pre-check script spawn error, running LLM anyway')
      return { skip: false }
    }
    if (r.status !== 0) {
      logger.warn({ task: task.name, status: r.status, stderr: (r.stderr || '').trim().slice(0, 200) }, 'pre-check script exited non-zero, running LLM anyway')
      return { skip: false }
    }
    const out = (r.stdout || '').trim()
    if (out === 'SKIP') {
      logger.info({ task: task.name }, 'pre-check: nothing actionable, skipping LLM')
      return { skip: true }
    }
    if (out) return { skip: false, prefix: out }
    return { skip: false }
  } catch (err) {
    logger.warn({ err, task: task.name }, 'pre-check script threw, running LLM anyway')
    return { skip: false }
  }
}
