// Structural refusal guard for the degraded-orchestrator kill switch (card d5638d28).
//
// MikroB decision (inter-agent msg 19506, overriding the card's own "loop chooses not to call
// these" framing): the "no done/land/agent-start while degraded" restriction must be enforced AT
// THE ENDPOINTS themselves, not trusted to the (not-yet-built) degraded-orchestrator loop's own
// self-restraint -- a bug, a stale process, or a second copy started by mistake would otherwise
// still hold full write privileges. This module is the single place that answers "is degraded
// mode on, and does this caller get to act anyway", reused by the kanban move guard, the
// POST /api/agents/:name/start route and store/marveen-land.sh's own bash port of the same check.
//
// Kész, ha #1 (card text): "store/degraded-orchestrator-enabled.json missing = OFF". A missing
// file is the default, safe state (matches today's behaviour before this card existed).
//
// Fail-closed on an UNREADABLE/corrupt file (MikroB msg 19506, explicit): a file that exists but
// cannot be parsed is an ANOMALY, not evidence the owner turned degraded mode off, so it is
// treated as degraded (refusing the 3 gated actions) rather than silently falling back to OFF.
import { existsSync, readFileSync } from 'fs'
import { PROJECT_ROOT } from './config.js'
import { isForceActor } from './kanban-force-actors.js'

// Round 2 LOW (CYBERED NO-GO 32207, residual 3): an env override, same variable name
// store/marveen-land.sh already reads (DEGRADED_ORCHESTRATOR_SWITCH), so a test can point this at
// a temp file instead of writing/removing the real switch path of the tree under test -- the
// previous HTTP guard tests did the latter, a hazard (harmless in a throwaway worktree, but it
// would delete an owner-set switch file if ever run against the live checkout). A FUNCTION, not a
// frozen top-level const: every default-parameter use below calls it fresh, so a test can set the
// env var at runtime (no module-load-time snapshot to go stale).
export function degradedOrchestratorSwitchPath(): string {
  return process.env.DEGRADED_ORCHESTRATOR_SWITCH || `${PROJECT_ROOT}/store/degraded-orchestrator-enabled.json`
}

export type DegradedOrchestratorState = 'off' | 'on' | 'unreadable'

// Card d5638d28 round 2 (CYBERED NO-GO 32207 F3, MikroB Fix-Direction 32209 #3): ONE switch-file
// contract, fail-closed. The ONLY valid shape is an object with exactly one key, `enabled`, whose
// value is a real JSON boolean -- {"enabled": true} or {"enabled": false}. Everything else that
// parses as JSON (wrong type, wrong/extra/typo key, truthy-but-not-boolean like 1/"on"/[]) is
// treated the same as a parse failure: 'unreadable', which blocks the same as 'on'. The previous
// version's `parsed?.enabled === true ? 'on' : 'off'` silently read every one of those malformed
// shapes as OFF -- a kill switch that fails open on a typo is not a kill switch (RedHat's measured
// split: the bash port of this same contract, in store/marveen-land.sh, already read them as ON).
function classifySwitchPayload(parsed: unknown): DegradedOrchestratorState {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable'
  const keys = Object.keys(parsed as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'enabled') return 'unreadable'
  const value = (parsed as Record<string, unknown>).enabled
  if (typeof value !== 'boolean') return 'unreadable'
  return value ? 'on' : 'off'
}

export function readDegradedOrchestratorState(
  path: string = degradedOrchestratorSwitchPath()
): DegradedOrchestratorState {
  if (!existsSync(path)) return 'off'
  try {
    return classifySwitchPayload(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return 'unreadable'
  }
}

/** True when the 3 gated actions (done, land, agent-start) must be refused. */
export function isDegradedOrchestratorBlocking(path?: string): boolean {
  return readDegradedOrchestratorState(path) !== 'off'
}

/**
 * Owner/Peti actions must still pass (MikroB msg 19506). mikrob is the only Telegram-facing relay
 * for Peti, and the degraded-orchestrator loop -- when it is eventually built -- will self-report
 * its OWN actor id, never `mikrob`'s, for exactly the actions this guard restricts (it is the
 * thing being kept OUT). So reusing the existing force-actor allowlist (kanban-force-actors.ts,
 * already `{mikrob}`, already the established "deliberate, attributable override" convention for
 * every other status guard on the board) tells the two apart without inventing a second mechanism.
 * Same caveat as that module's own doc comment: `actor` is self-declared, not authenticated. This
 * defends against an unattended/stale/buggy caller (this card's actual threat today, no night loop
 * exists yet), NOT against a process that already holds the shared dashboard token and lies about
 * its actor -- elemzo's plan-grilling (card d5638d28 comment 32144) flagged exactly this gap and
 * proposed a deny-by-default credential-scope fence (auth-device-keys.ts/operator-gate.ts pattern)
 * instead. MikroB (msg 19527): ship this guard as-is, track the fence as card 2ba008f2, and make it
 * a hard precondition before any degraded-orchestrator loop is ever wired to call these endpoints.
 */
export function degradedOrchestratorRefusal(
  actionLabel: string,
  force: boolean,
  actor?: string,
  path?: string
): string | null {
  if (isForceActor(force, actor)) return null
  const state = readDegradedOrchestratorState(path)
  if (state === 'off') return null
  return state === 'unreadable'
    ? `degraded-orchestrator guard: ${degradedOrchestratorSwitchPath()} is unreadable/corrupt -- refusing ${actionLabel} fail-closed (card d5638d28)`
    : `degraded-orchestrator guard: degraded mode is ON -- refusing ${actionLabel} (card d5638d28). Owner override: force:true with actor:"mikrob".`
}
