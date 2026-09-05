// Project-level dispatch priority (card 2d6587fe, Peti screenshot request 2026-08-08 09:46).
//
// A settable dashboard preference for project-level dispatch order: when EMPTY there is no
// project-level preference at all and dispatch runs on ordinary card priority (CLAUDE.md rule 6,
// urgent > high > normal > low, with rule 6b putting any `planned` card older than two days first);
// when set, the named project(s) go first at every dispatch decision (fleet-nudger self-advance,
// folyamatos-munka-orchestrator, MikroB's own gate-reconciler), in the order given, until cleared
// back to empty.
//
// The comments here used to say this generalizes "CLAUDE.md rule 14", which -- they claimed --
// hardcodes "project cards (CleanCore) before non-project (marveen-infra)". Card 43d933b1 checked
// that attribution and it is false twice over: rule 14 has never said anything about dispatch order
// (before the 2026-09-05 renumbering it was the mandatory /clear between two cards; it is now the
// noisy-command hook), and NO rule anywhere -- CLAUDE.md or the scheduled-task prompts -- states a
// CleanCore-first default. The default this code implements is the one described above, which is
// simply "no project preference", and the empty case has always behaved that way. Nothing about
// the behaviour changed; only the sentence that claimed a source for it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { listKanbanProjects } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { setStoreWriteActor } from '../../store-watcher.js'
import type { RouteContext } from './types.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'project-dispatch-priority.json')

interface ProjectPriorityConfig {
  // Order = priority order. Empty = no project preference; ordinary card priority decides.
  priority: string[]
  updated_at: number
}

function loadConfig(): ProjectPriorityConfig {
  if (!existsSync(CONFIG_PATH)) return { priority: [], updated_at: 0 }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<ProjectPriorityConfig>
    return {
      priority: Array.isArray(parsed.priority) ? parsed.priority.filter((p) => typeof p === 'string') : [],
      updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : 0,
    }
  } catch {
    // A corrupt file must not crash every dispatch-decision reader -- empty is the safe fallback
    // (no project preference, ordinary card priority), same direction as "no file yet".
    return { priority: [], updated_at: 0 }
  }
}

function saveConfig(config: ProjectPriorityConfig): void {
  setStoreWriteActor('dashboard')
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export async function tryHandleProjectPriority(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/config/project-priority' && method === 'GET') {
    json(res, loadConfig())
    return true
  }

  if (path === '/api/config/project-priority' && method === 'PUT') {
    let body: { priority?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    if (!Array.isArray(body.priority) || body.priority.some((p) => typeof p !== 'string')) {
      json(res, { error: 'priority must be an array of project name strings (empty array clears it to the default order)' }, 400)
      return true
    }
    // Validated against the REAL project list (listKanbanProjects, derived from the actual kanban
    // data), not a hand-maintained allowlist that could drift from it -- a stale allowlist here
    // would either reject a real project or silently accept a typo that never matches any card.
    const known = new Set(listKanbanProjects())
    const unknown = body.priority.filter((p) => !known.has(p))
    if (unknown.length > 0) {
      json(res, { error: `Unknown project(s): ${unknown.join(', ')}. Known projects: ${[...known].sort().join(', ') || '(none yet)'}` }, 400)
      return true
    }
    // Dedup, preserving the caller's order (that order IS the priority order).
    const priority = [...new Set(body.priority)]
    const config: ProjectPriorityConfig = { priority, updated_at: Math.floor(Date.now() / 1000) }
    try {
      saveConfig(config)
      logger.info({ priority }, 'Project dispatch priority updated')
      json(res, { ok: true, ...config })
    } catch (err) {
      logger.error({ err }, 'Failed to save project-dispatch-priority.json')
      json(res, { error: 'Failed to save' }, 500)
    }
    return true
  }

  return false
}
