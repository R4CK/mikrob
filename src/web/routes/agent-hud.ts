import { MAIN_AGENT_ID, PROJECT_ROOT } from '../../config.js'
import { agentDir, listAgentNames, readAgentClaudeConfigDir } from '../agent-config.js'
import { readActiveModelFromProjectDir, readContextTokensFromProjectDir } from '../active-model.js'
import { readHudSignalsFromProjectDir } from '../agent-hud.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// GET /api/agent-hud -- one read-only row per agent with the "what is happening right
// now" signals (card e9504aba, adapted from claude-hud).
//
// It AGGREGATES rather than computes. Context tokens and the live model already come
// from active-model.ts; only activeTool and runningSubAgents are new (agent-hud.ts).
// The context-guard percentage stays where it lives, on GET /api/context-guard: it
// carries the guard's own calibration (per-agent/model high-water marks) and
// duplicating that arithmetic here would be a second source of truth for the number
// the guard acts on. A caller wanting liveness pairs this with GET /api/agents rather
// than having process-state logic reimplemented here.
//
// SECURITY (binding constraint on the card): every field is a DERIVED value -- a count,
// a token total, a model id, a tool NAME. No tool arguments, no transcript quotes, no
// todo text. A dashboard reader must not be able to reconstruct session content from
// this response. Auth is the standard gate every other /api/* route sits behind.

export interface AgentHudRow {
  readonly agent: string
  /** Context size of the live session in tokens; null when there is no transcript yet. */
  readonly contextTokens: number | null
  /** Model that answered the most recent turn; null when the session has not answered yet. */
  readonly activeModel: string | null
  /** Tool currently executing (NAME only), or null when the agent is idle/thinking. */
  readonly activeTool: string | null
  /** Sub-agents dispatched but not yet returned. */
  readonly runningSubAgents: number
  /** True when the tail scan hit its bound, so the pairing saw only part of the session. */
  readonly truncated: boolean
}

// Same derivation the context guard uses (context-guard-runner.ts), via the EXPORTED
// helper rather than a third private copy: agentDir() goes through safeJoin, so an
// unsanitized name throws instead of building a traversal path.
function workingDirFor(name: string): string {
  return name === MAIN_AGENT_ID ? PROJECT_ROOT : agentDir(name)
}

export async function buildAgentHudRows(names: readonly string[]): Promise<AgentHudRow[]> {
  // Fan out concurrently (card 9a2fd3f7): each agent's context/model reads are independent
  // non-blocking file I/O, and a name agentDir() refuses is filtered out rather than aborting
  // the rest.
  const rows = await Promise.all(
    names.map(async (agent) => {
      let workingDir: string
      try {
        workingDir = workingDirFor(agent)
      } catch {
        return null // a name agentDir() refuses is not an agent we report on
      }
      const configDir = agent === MAIN_AGENT_ID ? undefined : (readAgentClaudeConfigDir(agent) ?? undefined)
      const [signals, contextTokens, activeModel] = await Promise.all([
        readHudSignalsFromProjectDir(workingDir, configDir),
        readContextTokensFromProjectDir(workingDir, configDir),
        readActiveModelFromProjectDir(workingDir, undefined, configDir),
      ])
      return {
        agent,
        contextTokens,
        activeModel,
        activeTool: signals.activeTool,
        runningSubAgents: signals.runningSubAgents,
        truncated: signals.truncated,
      }
    }),
  )
  return rows.filter((r): r is AgentHudRow => r !== null)
}

export async function tryHandleAgentHud(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/agent-hud' || method !== 'GET') return false
  const names = [MAIN_AGENT_ID, ...listAgentNames().filter((n) => n !== MAIN_AGENT_ID)]
  json(res, { agents: await buildAgentHudRows(names) })
  return true
}
