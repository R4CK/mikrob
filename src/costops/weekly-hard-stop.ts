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
