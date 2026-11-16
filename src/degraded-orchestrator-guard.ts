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

export const DEGRADED_ORCHESTRATOR_SWITCH_PATH = `${PROJECT_ROOT}/store/degraded-orchestrator-enabled.json`

export type DegradedOrchestratorState = 'off' | 'on' | 'unreadable'

export function readDegradedOrchestratorState(
  path: string = DEGRADED_ORCHESTRATOR_SWITCH_PATH
): DegradedOrchestratorState {
  if (!existsSync(path)) return 'off'
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed?.enabled === true ? 'on' : 'off'
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
    ? `degraded-orchestrator guard: ${DEGRADED_ORCHESTRATOR_SWITCH_PATH} is unreadable/corrupt -- refusing ${actionLabel} fail-closed (card d5638d28)`
    : `degraded-orchestrator guard: degraded mode is ON -- refusing ${actionLabel} (card d5638d28). Owner override: force:true with actor:"mikrob".`
}
