import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { getDb, countTaskRunsBetween } from '../../db.js'
import {
  agentDir, listAgentNames, readAgentDisplayName,
} from '../agent-config.js'
import { readAgentTeam } from '../agent-team.js'
import { isAgentRunning } from '../agent-process.js'
import { json, jsonMaybeGzip } from '../http-helpers.js'
import { getUpdateStatus, type AggregateUpdateStatus } from '../update-checker.js'
import { refreshUserTurnIndex, turnsOnDay } from '../user-turn-index.js'
import type { RouteContext } from './types.js'

// The per-day user-turn tallies now come from src/web/user-turn-index.ts (card ba0d218f): the inline
// full-scan counter that used to live here re-read every transcript on every request.

export interface UpstreamUpdateState {
  behind: number
  upstreamBranch: string | null
  remote: string | null
  checkedAt: number
  ok: boolean
}

/**
 * How far our fork is BEHIND the UPSTREAM base (Szotasz/marveen), for the overview
 * FRISSÍTÉS-BANNER (card 3c09ba6b / FÁZIS3). Rule 10 (GitHub-first, don't reinvent):
 * this REUSES the existing {@link getUpdateStatus} cache -- update-checker.ts already
 * computes the per-repo `behind` for BOTH the upstream Marveen and our fork (commit
 * 6af2e7c) and refreshUpdateStatus already runs every 15 min via startUpdateChecker.
 * The ONLY thing that was missing was surfacing the upstream repo's `behind` on the
 * overview; this reads the `marveen` repo out of the aggregate. Fail-safe: null on any
 * error, absent repo, error status, or never-checked -> the banner simply does not render
 * (never a false or stale-on-error banner). `agg` is injectable for tests.
 */
export function readUpstreamUpdate(
  agg: AggregateUpdateStatus = getUpdateStatus(),
): UpstreamUpdateState | null {
  try {
    const marveen = agg.repos.find((r) => r.key === 'marveen')
    if (!marveen) return null
    // Only surface a check that actually ran cleanly -- an errored or never-run check
    // must not produce a banner (fail-closed against a false "N updates available").
    const ok = !marveen.error && marveen.lastChecked > 0
    return {
      behind: Number(marveen.behind) || 0,
      upstreamBranch: typeof marveen.branch === 'string' ? marveen.branch : null,
      remote: typeof marveen.remote === 'string' ? marveen.remote : null,
      checkedAt: Number(marveen.lastChecked) || 0,
      ok,
    }
  } catch {
    return null
  }
}

export async function tryHandleOverview(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/overview' && method === 'GET') {
    const subAgents = listAgentNames()
    const running = subAgents.filter(n => isAgentRunning(n)).length + 1
    const total = subAgents.length + 1

    const db0 = getDb()
    const memStats = db0.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }
    const memCats = db0.prepare("SELECT COUNT(DISTINCT category) as c FROM memories").get() as { c: number }

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startTs = startOfDay.getTime()
    const yesterday = startTs - 24 * 60 * 60 * 1000
    const schedToday = countTaskRunsBetween(startTs)
    const schedYesterday = countTaskRunsBetween(yesterday, startTs)
    // Card ba0d218f: these two numbers used to be computed by re-reading and JSON-parsing every
    // transcript modified since the window start -- measured at 930 MB + 1.01 GB per request on this
    // host, which is where ~8 of the ~12 seconds went, and it got worse precisely when the fleet was
    // busy. The index reads only what has been APPENDED since the last pass (transcripts are
    // append-only), so an idle-ish minute costs a stat() per file and nothing else.
    const { days: turnDays } = refreshUserTurnIndex()
    const userTurns = turnsOnDay(turnDays, startTs)
    const userTurnsPrev = turnsOnDay(turnDays, yesterday)
    const tasksToday = schedToday + userTurns
    const tasksYesterday = schedYesterday + userTurnsPrev

    let skillCount = 0
    let skillsToday = 0
    const skillsDir = join(homedir(), '.claude', 'skills')
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir)) {
        const skillFile = join(skillsDir, entry, 'SKILL.md')
        if (existsSync(skillFile)) {
          skillCount++
          try {
            const mtime = statSync(skillFile).mtimeMs
            if (mtime >= startTs) skillsToday++
          } catch { /* ignore */ }
        }
      }
    }

    const activity: Array<{ icon: string; text: string; at: number }> = []
    try {
      const memRows = db0.prepare("SELECT content, created_at, agent_id FROM memories ORDER BY created_at DESC LIMIT 6").all() as { content: string; created_at: number; agent_id: string }[]
      for (const r of memRows) {
        activity.push({
          icon: 'memory',
          text: `${r.agent_id}: ${r.content.slice(0, 80)}${r.content.length > 80 ? '…' : ''}`,
          at: r.created_at * 1000,
        })
      }
    } catch { /* ignore */ }
    try {
      const msgRows = db0.prepare("SELECT from_agent, to_agent, content, created_at FROM agent_messages ORDER BY created_at DESC LIMIT 4").all() as { from_agent: string; to_agent: string; content: string; created_at: number }[]
      for (const r of msgRows) {
        activity.push({
          icon: 'delegate',
          text: `${r.from_agent} → ${r.to_agent}: ${r.content.slice(0, 60)}${r.content.length > 60 ? '…' : ''}`,
          at: r.created_at * 1000,
        })
      }
    } catch { /* ignore */ }
    activity.sort((a, b) => b.at - a.at)

    const agentsForTeam: Array<{ id: string; label: string; role: string; running: boolean; hasAvatar: boolean; avatarUrl: string }> = []
    const mainHasAvatar = [
      join(PROJECT_ROOT, 'store', 'marveen-avatar.png'),
      join(PROJECT_ROOT, 'store', 'marveen-avatar.jpg'),
    ].some(existsSync)
    agentsForTeam.push({
      id: MAIN_AGENT_ID,
      label: currentBotName(),
      role: 'main',
      running: true,
      hasAvatar: mainHasAvatar,
      avatarUrl: `/api/marveen/avatar`,
    })
    for (const a of subAgents) {
      const team = readAgentTeam(a)
      agentsForTeam.push({
        id: a,
        label: readAgentDisplayName(a),
        role: team.role,
        running: isAgentRunning(a),
        hasAvatar: existsSync(join(agentDir(a), 'avatar.png')),
        avatarUrl: `/api/agents/${encodeURIComponent(a)}/avatar`,
      })
    }
    jsonMaybeGzip(req, res, {
      agents: { total, running },
      tasksToday,
      tasksYesterday,
      memories: { count: memStats.c, categories: memCats.c },
      skills: { count: skillCount, today: skillsToday },
      team: agentsForTeam,
      activity: activity.slice(0, 8),
      // Card 3c09ba6b (FÁZIS3): how many commits our fork is BEHIND the upstream base
      // (Szotasz/marveen). Written by the daily store/upstream-update-check.sh; the
      // overview shows a FRISSÍTÉS-BANNER when behind > 0. Null when never checked.
      upstreamUpdate: readUpstreamUpdate(),
    })
    return true
  }

  return false
}
