// Guard: a scheduled task's own config must not guarantee it never runs (card 7cc8641a).
//
// Three more tasks were found dead by the canary, each for a config reason, not a code one:
//   bumblebee-hygiene-scan  weekly (Mon 09:00) with skipIfBusy=true -> 13 of 13 ticks DROPPED, never
//                           ran once. schedule-runner's own comment states the rule: "Daily/weekly
//                           schedules keep skipIfBusy=false so the queue + alert path catches a
//                           long-running busy state." The config contradicted the scheduler's design.
//   dream-engine            02:07, unknown `type` -> falls back to the 180-minute task budget
//   skill-besorolas-napi    05:23, heartbeat -> 30-minute budget
// The last two are the offload-overnight-batch shape: the host is asleep at that hour, so by the time
// the scheduler is up the occurrence is hours stale and correctly discarded as `missed`. Both HAD
// fired before (3 times each), so nothing was broken -- the budget was simply smaller than the gap.
//
// These are seeded now, so an update cannot quietly restore the broken values.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed-scheduled-tasks')

interface TaskCfg {
  schedule?: string
  type?: string
  enabled?: boolean
  skipIfBusy?: boolean
  catchUpMaxAgeMinutes?: number
}

// schedule-runner's DEFAULT_CATCHUP_MAX_AGE_MIN. `command` already gets a full day, so an overnight
// command task needs no explicit budget -- demanding one would flag auto-update, which is fine.
const TYPE_DEFAULT_BUDGET_MIN: Record<string, number> = { command: 1440, heartbeat: 30, task: 180 }
const budgetFor = (t?: string) => TYPE_DEFAULT_BUDGET_MIN[t ?? 'task'] ?? TYPE_DEFAULT_BUDGET_MIN.task

const seeds = (): Array<[string, TaskCfg]> =>
  readdirSync(SEED_DIR)
    .filter((n) => existsSync(join(SEED_DIR, n, 'task-config.json')))
    .map((n) => [n, JSON.parse(readFileSync(join(SEED_DIR, n, 'task-config.json'), 'utf-8')) as TaskCfg])

/** True when the cron fires at most once a day (no minute/hour wildcards or steps). */
function runsAtMostDaily(cron: string): boolean {
  const [min = '', hour = ''] = cron.trim().split(/\s+/)
  const wild = (f: string) => f === '*' || f.includes('/') || f.includes(',') || f.includes('-')
  return !wild(min) && !wild(hour)
}

/** Cron hours when this host is typically asleep, so an occurrence cannot be served on time. */
function firesWhileHostAsleep(cron: string): boolean {
  const hour = Number.parseInt(cron.trim().split(/\s+/)[1] ?? '', 10)
  return Number.isFinite(hour) && hour >= 0 && hour < 6
}

/** `0 0 1 1 *` and friends: a fixed day AND month is a yearly sentinel, i.e. "effectively never". */
function isYearlySentinel(cron: string): boolean {
  const [, , dom = '*', mon = '*'] = cron.trim().split(/\s+/)
  return dom !== '*' && mon !== '*'
}

describe('seeded schedules can actually run (card 7cc8641a)', () => {
  it('parses a non-trivial number of seeds', () => {
    // an empty or mis-parsed directory would make every assertion below vacuous
    expect(seeds().length).toBeGreaterThan(5)
  })

  // The scheduler's documented rule, enforced. skipIfBusy exists so a 30-minute heartbeat can drop a
  // tick harmlessly -- the next one is already coming. On a daily or weekly schedule the next one is
  // a day or a week away, so dropping it silently is how a task runs zero times in three months.
  it.each(seeds().filter(([, c]) => c.schedule && runsAtMostDaily(c.schedule)))(
    '%s runs at most daily, so it must not set skipIfBusy',
    (_name, cfg) => {
      expect(cfg.skipIfBusy ?? false).toBe(false)
    },
  )

  // A task due while the box is off can only ever run as a catch-up, and the per-type defaults
  // (heartbeat 30 min, task 180 min) are far smaller than a night.
  // Scoped honestly: only where the TYPE default is too small to survive a night, and not for yearly
  // sentinels. post-rollback-diagnose (`0 0 1 1 *`, disabled) is such a sentinel -- flagging it would
  // be a false positive, and a guard that cries wolf gets switched off.
  it.each(seeds().filter(([, c]) =>
    c.schedule && firesWhileHostAsleep(c.schedule) && !isYearlySentinel(c.schedule) && budgetFor(c.type) < 720,
  ))(
    '%s fires overnight with a short type budget, so it needs an explicit catch-up budget',
    (_name, cfg) => {
      expect(cfg.catchUpMaxAgeMinutes ?? 0).toBeGreaterThanOrEqual(720)
    },
  )

  // Pinned: these three are the ones this card fixed. If a future edit drops them from the seed the
  // generic rules above stop covering them, and the fix would live on one host only.
  it.each(['bumblebee-hygiene-scan', 'dream-engine', 'skill-besorolas-napi'])(
    '%s is seeded, so the fix survives a reinstall',
    (name) => {
      expect(existsSync(join(SEED_DIR, name, 'task-config.json'))).toBe(true)
    },
  )
})
