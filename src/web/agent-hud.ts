import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { projectsDirFor } from './active-model.js'

// Live "what is this agent doing right now" signals, read from the same session
// transcript that active-model.ts already reads (card e9504aba, adapted from the
// claude-hud concept -- that project is a Claude Code STATUSLINE plugin, so its
// delivery mechanism cannot be ported to a web dashboard; what transfers is which
// signals are worth showing and where the data lives).
//
// Deliberately NOT re-implemented here, because the fleet already computes them:
// context tokens and the live model (readContextTokensFromProjectDir /
// readActiveModelFromProjectDir in active-model.ts), the context-guard percentage
// (context-guard-runner.ts, exposed as GET /api/context-guard), and the whole
// 5-hour + weekly quota chain. This module adds ONLY the two signals nothing else
// derives: which tool is executing, and whether a sub-agent is still running.
//
// SECURITY (binding constraint on card e9504aba): tool NAMES only. Never the tool
// INPUT, and never a quote from the transcript. A dashboard reader must not be able
// to reconstruct session content from this endpoint -- tool arguments routinely
// carry file paths, tenant identifiers and command lines, and the transcript itself
// carries everything. Only derived, non-quoting values leave this module.

const TTL_MS = 3000
const cache = new Map<string, { value: AgentHudSignals; expiresAt: number }>()

// How much of the transcript tail we pair up. A tool_use is only "in flight" if its
// result has not arrived yet, which makes it recent by construction -- an unmatched
// call thousands of lines back is an abandoned or crashed call, not live activity.
// Bounding the scan keeps a dashboard poll cheap on a long session instead of
// re-reading megabytes per agent per refresh. The bound is stated rather than
// silent: `truncated` says whether it was hit, so a caller never mistakes "we
// stopped looking" for "there was nothing there".
const TAIL_LINES = 400

export interface AgentHudSignals {
  /** Name of the tool currently executing (no arguments), or null when the agent is idle/thinking. */
  readonly activeTool: string | null
  /** Sub-agent (Agent/Task) calls dispatched but not yet returned. */
  readonly runningSubAgents: number
  /** True when the tail bound was reached, so the pairing saw only part of the session. */
  readonly truncated: boolean
}

const EMPTY: AgentHudSignals = { activeTool: null, runningSubAgents: 0, truncated: false }

// The tool the fleet dispatches sub-agents with is `Agent` in this codebase; `Task`
// is accepted too because that is the name in other Claude Code versions and a
// rename upstream must not silently zero this counter.
const SUB_AGENT_TOOLS = new Set(['Agent', 'Task'])

function newestTranscript(dir: string): string | null {
  const jsonls = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return jsonls.length > 0 ? join(dir, jsonls[0].f) : null
}

/**
 * Pair `tool_use` blocks against `tool_result` blocks over the transcript tail.
 *
 * Claude Code writes the call as a `tool_use` block (id, name, input) on an assistant
 * message and the completion as a `tool_result` block carrying `tool_use_id` on the
 * following user message. An id with no result yet is a call still in flight -- that
 * is the whole basis for both signals here, and it is why this scans FORWARD over a
 * bounded tail rather than backward: the newest tool_use tells you what was started,
 * not what is still running.
 */
export function pairToolActivity(lines: readonly string[]): AgentHudSignals {
  const inFlight = new Map<string, string>() // tool_use id -> tool name, insertion-ordered
  const finished = new Set<string>()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a partially-written last line is normal on a live transcript
    }
    const content = (entry as { message?: { content?: unknown } })?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown }
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        if (!finished.has(b.id)) inFlight.set(b.id, b.name)
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        finished.add(b.tool_use_id)
        inFlight.delete(b.tool_use_id)
      }
    }
  }
  let activeTool: string | null = null
  let runningSubAgents = 0
  for (const name of inFlight.values()) {
    activeTool = name // last one wins: the most recently dispatched still-open call
    if (SUB_AGENT_TOOLS.has(name)) runningSubAgents += 1
  }
  return { activeTool, runningSubAgents, truncated: false }
}

/** Live tool/sub-agent signals for an agent, or the empty shape when there is no transcript yet. */
export function readHudSignalsFromProjectDir(workingDir: string, configDir?: string): AgentHudSignals {
  const now = Date.now()
  const cacheKey = `${workingDir}:${configDir ?? ''}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.value
  let value: AgentHudSignals = EMPTY
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (existsSync(dir)) {
      const file = newestTranscript(dir)
      if (file) {
        const all = readFileSync(file, 'utf-8').split('\n')
        const tail = all.length > TAIL_LINES ? all.slice(-TAIL_LINES) : all
        value = { ...pairToolActivity(tail), truncated: all.length > TAIL_LINES }
      }
    }
  } catch {
    value = EMPTY // an unreadable transcript is "no signal", never a thrown dashboard request
  }
  cache.set(cacheKey, { value, expiresAt: now + TTL_MS })
  return value
}
