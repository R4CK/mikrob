// Scaffold-section sweeper (card 75a6fbe6).
//
// THE GAP. The generated CLAUDE.md sections -- autonomy, skills-path-trap, fleet roster,
// local-first, and the system-directive VERIFICATION RECIPE -- are written at exactly two moments:
// server start (main agent, web.ts) and agent start (sub-agents, agent-process.ts). A long-lived,
// rarely-restarted agent therefore keeps whatever it was given the day it started. If a section is
// changed for a SECURITY reason, the agents still running never see it.
//
// MEASURED, which is why this exists rather than being argued about: on 2026-09-04 the
// system-directive-auth block had reached 6 of 15 agents. The other 9 -- including the one that
// reported this -- had been running without the directive-verification recipe since the capability
// landed the previous evening, and would have kept running without it indefinitely. Nothing had
// regressed; every absent agent simply predated the feature and had not restarted since. That is
// the whole failure: the coverage of a security control was decided by restart luck.
//
// WHY IN-PROCESS AND NOT A SCHEDULED TASK. The two options on the table were a section inside the
// heartbeat prompt or a separate scheduled task. Both are prompt-mediated: an agent reads them and
// decides. This operation needs no judgment -- it is an idempotent function call with a fixed
// argument list -- and prompt-mediated sweeps can be skipped, misread, or starved when the runner
// is busy. A timer cannot. CLAUDE.md's own rule is structural protection over discipline, and this
// follows the startInboxNudgeWatcher precedent exactly.
//
// WHY IT IS CHEAP ENOUGH TO RUN ON A TIMER. Every writer reads, rebuilds its block, compares, and
// returns WITHOUT writing when the result is identical (`if (updated === existing) return`). In the
// steady state a sweep is N file reads and zero writes, so it does not churn mtimes and cannot
// disturb a running agent. A write happens only when the section genuinely changed -- which is the
// event this exists to propagate.
//
// SCOPE, deliberately narrow: the sweep applies the SAME writers to the SAME targets that start
// time already applies -- three for the main agent (as web.ts does) and every marker-producing
// writer startAgentProcess applies to a sub-agent (fifteen, as of card 4af036ab; the import list
// above is the current count, not a number worth repeating here since it will drift again the
// moment someone edits one list and not the other). It introduces no new section anywhere. The
// only new thing is that it happens more than once.
//
// CARD 4af036ab (2026-11-25): the sub-agent list above had silently fallen behind
// startAgentProcess's -- ten writers (agent-id-header, memory-search-label, fleet-auth-rule,
// evidence-rule, mcp-list-channel-warning, message-close, skill-usage, agent-to-agent-language,
// memory-save, daily-log) had been added to agent-process.ts over time and never added here, so
// any sub-agent that had not restarted since one of them was introduced stayed missing that
// section forever -- the exact 75a6fbe6 failure mode, reopened by list drift instead of a missing
// timer. src/__tests__/scaffold-section-sweeper-parity.test.ts now asserts the two lists match, so
// a future addition to one without the other fails loudly instead of waiting for someone to notice
// a live CLAUDE.md missing a section. ensureThinChiefHandoffSection is NOT included: it is
// profile-conditional at start time (`if (profileWantsThinChiefHandoff(profile))`), and the sweep
// has no per-agent profile to consult -- a separate design question, not fixed by this card.
//
// EXCEPTION, added by card 8c6f30fb (HOSTMOVE923): ensureProjectRootAnchor is NOT one of the
// section writers above -- it re-anchors already-baked literal PROJECT_ROOT paths in CLAUDE.md
// and settings.json after a host move, rather than writing a marked section. It runs here (not
// at agent start only) for the same reason as the rest of this file: a long-lived agent that
// never restarts after a host move would otherwise keep naming the dead root until someone
// hand-edits it. Main agent is excluded inside the function itself (git-tracked files).
import {
  ensureFleetRosterSection,
  ensureAutonomySection,
  ensureLocalFirstSection,
  ensureSkillsPathTrapSection,
  ensureSystemDirectiveAuthSection,
  ensureProjectRootAnchor,
  ensureAgentIdHeaderSection,
  ensureMemorySearchLabelSection,
  ensureFleetAuthSection,
  ensureEvidenceSection,
  ensureMcpListChannelSection,
  ensureMessageCloseSection,
  ensureSkillUsageSection,
  ensureLanguageSection,
  ensureMemorySaveSection,
  ensureDailyLogSection,
} from './agent-scaffold.js'
import { listAgentNames } from './agent-config.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'

/** Default cadence. The sections only change when a deploy changes them, so this is about bounding
 *  how long a running agent can hold a stale copy, not about reacting quickly. */
export const SCAFFOLD_SWEEP_INTERVAL_MS = 15 * 60 * 1000

/**
 * One pass. Returns the number of agents swept, for the log line and for tests.
 *
 * FAIL-SOFT PER AGENT, on purpose: one unreadable or oddly-shaped CLAUDE.md must not stop the other
 * fourteen from being brought up to date. A sweep that aborts halfway would reintroduce exactly the
 * partial-coverage state it exists to end -- and silently, since the remaining agents would look
 * untouched rather than failed.
 */
export function sweepScaffoldSections(): number {
  let swept = 0
  try {
    ensureAutonomySection(MAIN_AGENT_ID)
    ensureSkillsPathTrapSection(MAIN_AGENT_ID)
    ensureSystemDirectiveAuthSection(MAIN_AGENT_ID)
    swept += 1
  } catch (err) {
    logger.warn({ err, agent: MAIN_AGENT_ID }, 'scaffold-sweep: main agent section refresh failed (continuing)')
  }
  for (const name of listAgentNames()) {
    if (name === MAIN_AGENT_ID) continue
    try {
      ensureFleetRosterSection(name)
      ensureAutonomySection(name)
      ensureLocalFirstSection(name)
      ensureSkillsPathTrapSection(name)
      ensureSystemDirectiveAuthSection(name)
      ensureAgentIdHeaderSection(name)
      ensureMemorySearchLabelSection(name)
      ensureFleetAuthSection(name)
      ensureEvidenceSection(name)
      ensureMcpListChannelSection(name)
      ensureMessageCloseSection(name)
      ensureSkillUsageSection(name)
      ensureLanguageSection(name)
      ensureMemorySaveSection(name)
      ensureDailyLogSection(name)
      ensureProjectRootAnchor(name)
      swept += 1
    } catch (err) {
      logger.warn({ err, agent: name }, 'scaffold-sweep: agent section refresh failed (continuing)')
    }
  }
  return swept
}

export function startScaffoldSectionSweeper(intervalMs: number = SCAFFOLD_SWEEP_INTERVAL_MS): NodeJS.Timeout {
  // No immediate pass here: server start already writes the main agent's sections a few lines
  // earlier in web.ts, and running the full fleet sweep synchronously during boot would put N file
  // reads on the startup path for no benefit. The first tick is soon enough.
  const timer = setInterval(() => {
    try {
      const n = sweepScaffoldSections()
      logger.debug({ agents: n }, 'scaffold-sweep: sections refreshed')
    } catch (err) {
      logger.warn({ err }, 'scaffold-sweep: tick failed (continuing)')
    }
  }, intervalMs)
  timer.unref?.()
  return timer
}
