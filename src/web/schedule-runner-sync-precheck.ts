import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { logger } from '../logger.js'
import type { ScheduledTask } from './scheduled-tasks-io.js'
import { resolvePreCheckPath, preCheckInvocation, PRECHECK_TIMEOUT_MS, type PreCheckResult } from './schedule-runner.js'

// The synchronous reference form. The runner itself calls nowhere but
// runPreCheckAsync (schedule-runner.ts) -- kept so schedule-source-registry.test.ts can assert
// the registry-verified preCheckInvocation/resolvePreCheckPath wiring agrees whether driven
// synchronously or off the event loop; do not call it from the runner (it holds the event loop,
// and its timeout ends only the direct child).
//
// Lives in its OWN file, not schedule-runner.ts: card 92e2bb1b's scheduler-tick-nonblocking
// guard does a source-level scan of schedule-runner.ts for spawnSync/execSync/execFileSync,
// because that file's own setInterval tick must never call one synchronously. This function is
// never reached from that tick, but the guard scans TEXT, not the call graph, so a literal
// spawnSync( staying in that file would still trip it.
export function runPreCheck(task: ScheduledTask): PreCheckResult {
  if (!task.preCheck) return { skip: false }
  // dirName, not name: a relative preCheck lives in the task's OWN directory,
  // which is also what the registry hashed. `name` can come from
  // the SKILL.md frontmatter and point at a different directory.
  const scriptPath = resolvePreCheckPath(task.dirName ?? task.name, task.preCheck)
  // Koteg 24 (card 57044a66): a preCheck that is not a non-empty string (resolvePreCheckPath's
  // own "ignore it, the registry hash ignores it too" contract, mirrored by the async form's
  // NOT_A_PRECHECK_PATH_MSG in schedule-runner.ts) resolves to null -- existsSync(null) itself
  // throws a TypeError, which would surface as an unrelated-looking crash instead of the same
  // "running LLM anyway" degrade every other branch here gives.
  if (scriptPath == null) {
    // Log the TYPE only, never the value: a task's preCheck field is operator-authored config,
    // not something this gate should echo into the log verbatim (card 5dd0842a, caught by a
    // fleet-test case added this round -- the value can carry content that should not be logged).
    logger.warn({ task: task.name, preCheckType: typeof task.preCheck }, 'pre-check is not a script path (not a non-empty string); running LLM anyway')
    return { skip: false }
  }
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
