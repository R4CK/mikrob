import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { getDb, countTaskRunsBetween } from '../../db.js'
import {
  agentDir, listAgentNames, readAgentDisplayName,
} from '../agent-config.js'
import { readAgentTeam } from '../agent-team.js'
import { isAgentRunning } from '../agent-process.js'
import { jsonMaybeGzip } from '../http-helpers.js'
import { getUpdateStatus, type AggregateUpdateStatus } from '../update-checker.js'
import { refreshUserTurnIndex, turnsOnDay } from '../user-turn-index.js'
import { readQuotaSnapshot, DEFAULT_MAX_AGE_SEC, readFableSnapshot, DEFAULT_FABLE_MAX_AGE_SEC, readModQuotaSnapshot, chooseQuotaSnapshot, type QuotaSnapshot } from '../quota.js'
import { STATE_OBSERVER_STATE_DIR } from '../state-observer.js'
import { agentKeyToAgentId } from '../auth-device-keys.js'
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
 * 6af2e7c) and refreshUpdateStatus is already refreshed periodically by startUpdateChecker
 * (see UPDATE_CHECK_INTERVAL_MS there for the cadence -- deliberately not restated here, the
 * number in this sentence was wrong for months after it changed, card 06bed89a).
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

// The fleet's remaining quota, as the overview strip shows it. Same file and
// the same staleness threshold the quota monitor uses, so the strip and the
// alert can never disagree about what the fleet has left. QUOTAMOD1005: on a
// setup-token install the statusLine block never comes; the
// agent-state-observer mod's readings do. The fresher of the two wins, and the
// snapshot says which one it is. Shared with the operator status
// (DASHOPERATOR1005), so the two surfaces cannot disagree either.
export function readFleetQuota(nowSec: number): QuotaSnapshot {
  const maxAgeSec = Number(process.env.QUOTA_MAX_AGE_SEC) || DEFAULT_MAX_AGE_SEC
  return chooseQuotaSnapshot(
    readQuotaSnapshot(join(PROJECT_ROOT, 'store', '.claude-rate-limits.json'), nowSec, maxAgeSec),
    readModQuotaSnapshot(STATE_OBSERVER_STATE_DIR, nowSec, maxAgeSec),
  )
}

export async function tryHandleOverview(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx

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

    // O1 (RedHat 17520 on 9655494c, card ddeb2e17): the handler used to hand back the fleet-wide
    // activity feed (6 newest memory snippets + 4 newest agent-message bodies) to ANY authenticated
    // caller, dashboard token or agent device key alike. Once per-agent device keys are actually
    // issued, that lets agent A read agent B's private memory content and B's/other agents'
    // inter-agent message bodies through its OWN key -- a cross-agent read the key was never meant
    // to grant (same identity precedent as memories.ts's authenticatedAgentId, card 84dcc5d4). A
    // dashboard-token/session caller (the human operator) is unaffected and keeps the fleet-wide
    // feed, exactly as before.
    const authenticatedAgentId = auth?.kind === 'device' ? agentKeyToAgentId(auth.device) : null

    const activity: Array<{ icon: string; text: string; at: number }> = []
    try {
      const memRows = authenticatedAgentId
        ? db0.prepare("SELECT content, created_at, agent_id FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT 6").all(authenticatedAgentId) as { content: string; created_at: number; agent_id: string }[]
        : db0.prepare("SELECT content, created_at, agent_id FROM memories ORDER BY created_at DESC LIMIT 6").all() as { content: string; created_at: number; agent_id: string }[]
      for (const r of memRows) {
        activity.push({
          icon: 'memory',
          text: `${r.agent_id}: ${r.content.slice(0, 80)}${r.content.length > 80 ? '…' : ''}`,
          at: r.created_at * 1000,
        })
      }
    } catch { /* ignore */ }
    try {
      const msgRows = authenticatedAgentId
        ? db0.prepare("SELECT from_agent, to_agent, content, created_at FROM agent_messages WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC LIMIT 4").all(authenticatedAgentId, authenticatedAgentId) as { from_agent: string; to_agent: string; content: string; created_at: number }[]
        : db0.prepare("SELECT from_agent, to_agent, content, created_at FROM agent_messages ORDER BY created_at DESC LIMIT 4").all() as { from_agent: string; to_agent: string; content: string; created_at: number }[]
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
    const quota = readFleetQuota(Math.floor(Date.now() / 1000))
    // Separate source (scripts/usage-collect.py), separate freshness rule --
    // see src/web/quota.ts for why this isn't folded into readQuotaSnapshot.
    const fableMaxAgeSec = Number(process.env.QUOTA_FABLE_MAX_AGE_SEC) || DEFAULT_FABLE_MAX_AGE_SEC
    const quotaFable = readFableSnapshot(
      join(PROJECT_ROOT, 'store', 'usage-latest.json'),
      Math.floor(Date.now() / 1000),
      fableMaxAgeSec,
    )

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
      quota,
      quotaFable,
    })
    return true
  }

  return false
}
