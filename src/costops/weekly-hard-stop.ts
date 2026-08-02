// The weekly HARD STOP flag (card d08b98f4, Peti decision).
//
// The existing weekly rule only ever stopped NEW development: in-flight cards finished and the
// QA/Cybersec/Cybered gates kept running, which is right at 90% and wrong at 98% -- gate work is
// Claude work too, and at that point the fleet is spending the last of the week's quota on it.
//
// So there is now a second, harder level (testStop, default 97). At or above it EVERY role agent is
// parked and no gate work is dispatched; only MikroB stays alive, because rule 7 makes it the one
// agent that must keep monitoring, answering Peti and restarting the fleet afterwards.
//
// store/pre-dispatch-check.sh WRITES this file on every run (it is the one place that already knows
// the weekly percentage). This module is the READ side for the TypeScript half -- the dashboard panel
// and any orchestrator code -- so both halves agree on what is true without re-deriving it.
//
// FAIL-OPEN ON PURPOSE, and only here: an unreadable/missing flag reports `active: false`. The flag is
// a STOP signal, not a permission; treating "I could not read it" as "everything is stopped" would
// park the whole fleet on a corrupt file. The weekly percentage itself is still checked by the gate
// script before any dispatch, so a lost flag costs a tick, not the control.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

const FLAG_PATH = join(PROJECT_ROOT, 'store', 'weekly-hard-stop.json')

export interface WeeklyHardStop {
  /** True when gate work must stop too and every role agent should be parked. */
  readonly active: boolean
  /** The weekly percentage the decision was made on (-1 when unknown). */
  readonly percent: number
  /** The testStop threshold it was compared against. */
  readonly testStop: number
  /** The newDevStop threshold (softer level: no NEW dispatch, in-flight + gates continue). */
  readonly newDevStop: number
  /** True when `percent >= newDevStop` (implied true whenever `active` is true). */
  readonly newDevStopActive: boolean
  /** Agents that are NEVER parked by this (rule 7: MikroB monitors and restarts the fleet). */
  readonly exemptAgents: readonly string[]
  /** Human-readable reason, empty when not active. */
  readonly reason: string
  readonly updatedAt: number | null
}

const INACTIVE: WeeklyHardStop = {
  active: false,
  percent: -1,
  testStop: 97,
  newDevStop: 90,
  newDevStopActive: false,
  exemptAgents: ['mikrob'],
  reason: '',
  updatedAt: null,
}

const intOr = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

/** Read the flag. Never throws; an unreadable flag reads as INACTIVE (see the file header). */
export function readHardStop(path: string = FLAG_PATH): WeeklyHardStop {
  try {
    if (!existsSync(path)) return INACTIVE
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const exempt = Array.isArray(raw['exemptAgents'])
      ? (raw['exemptAgents'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : []
    return {
      active: raw['active'] === true,
      percent: intOr(raw['percent'], -1),
      testStop: intOr(raw['testStop'], INACTIVE.testStop),
      newDevStop: intOr(raw['newDevStop'], INACTIVE.newDevStop),
      // A file written before this field existed has no opinion -- fall back to comparing
      // percent against newDevStop ourselves rather than silently reporting "not active".
      newDevStopActive:
        raw['newDevStopActive'] === true ||
        (raw['active'] === true) ||
        intOr(raw['percent'], -1) >= intOr(raw['newDevStop'], INACTIVE.newDevStop),
      // MikroB is exempt whatever the file says: a flag that forgot it (hand-edited, or written by an
      // older script) must not become an instruction to park the agent that undoes the stop.
      exemptAgents: exempt.includes('mikrob') ? exempt : [...exempt, 'mikrob'],
      reason: typeof raw['reason'] === 'string' ? raw['reason'] : '',
      updatedAt: Number.isFinite(Number(raw['updatedAt'])) ? Number(raw['updatedAt']) : null,
    }
  } catch {
    return INACTIVE
  }
}

/** True when this agent must be parked by the hard stop. MikroB never is. */
export function isParkedByHardStop(agentId: string, flag: WeeklyHardStop = readHardStop()): boolean {
  if (!flag.active) return false
  return !flag.exemptAgents.includes(agentId.trim().toLowerCase())
}

/**
 * Pure predicate for the NEW-DEV stop (Peti 2026-08-01): a `planned` card moving to `in_progress` OR
 * straight to `waiting` IS the start of new development and must be refused once the weekly
 * newDevStop threshold is crossed. A direct `planned -> waiting` skip was added 2026-08-02: after the
 * `force`-actor fix closed the `planned -> in_progress` bypass, a role-agent (`backend`, card
 * `adaa5217`) got a 409 on `{"status":"in_progress","force":true}` and simply sent
 * `{"status":"waiting"}` instead -- since the guard only ever checked `nextStatus === 'in_progress'`,
 * a card that already had real (uncommitted-until-then) work skipped the checkpoint entirely and
 * landed straight on `waiting+REVIEW`, gate-eligible, with zero rows in between. In the intended
 * lifecycle (planned -> in_progress -> waiting -> done) a planned card has no legitimate reason to
 * reach `waiting` without passing through `in_progress` first, so both target statuses are guarded
 * the same way. `waiting -> in_progress` (a FAIL-fix / gate resume) is NOT new dev and stays allowed.
 * `force` is meant as MikroB's deliberate override for a critical-infra exception (kanban.ts:27) --
 * it only overrides when the caller is one of `flag.exemptAgents` (mikrob); everyone else's force is
 * ignored. Pure so the status-write endpoints can test the decision without a file/DB.
 */
export function isNewDevStartBlocked(
  prevStatus: string | undefined,
  nextStatus: unknown,
  force: boolean,
  flag: WeeklyHardStop,
  actor?: string,
): boolean {
  const exemptOverride = force && !!actor && flag.exemptAgents.includes(actor.trim().toLowerCase())
  const isNewDevTarget = nextStatus === 'in_progress' || nextStatus === 'waiting'
  return !exemptOverride && flag.newDevStopActive === true && isNewDevTarget && prevStatus === 'planned'
}
