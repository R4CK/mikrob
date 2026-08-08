// Project-level dispatch priority (card 2d6587fe, Peti screenshot request 2026-08-08 09:46).
//
// CLAUDE.md rule 14 hardcodes "project cards (CleanCore) before non-project (marveen-infra)" --
// this generalizes that into a real, settable dashboard preference: when EMPTY, rule 14's default
// order applies unchanged; when set, the named project(s) go first at every dispatch decision
// (fleet-nudger self-advance, folyamatos-munka-orchestrator, MikroB's own gate-reconciler), in the
// order given, until cleared back to empty.
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
  // Order = priority order. Empty = default mode (rule 14's hardcoded CleanCore > MikroB).
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
    // A corrupt file must not crash every dispatch-decision reader -- empty/default is the safe
    // fallback (rule 14's own hardcoded order), same direction as "no file yet".
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
