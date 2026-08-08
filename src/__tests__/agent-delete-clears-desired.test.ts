// Deleting an agent must clear its desired run-state.
//
// Found by reading the code during the #842 verify, 2026-08-03: routes/agents.ts
// has exactly three Desired call sites -- the import, addDesiredAgent in the
// START branch, removeDesiredAgent in the STOP branch. The DELETE branch has
// neither. So the name outlives the directory in agents-desired.json.
//
// What that costs, precisely (startAgentProcess returns 'Agent not found' on a
// missing dir, so the deleted agent is NOT resurrected while it stays deleted):
//   1. the reconciler retries the name on every pass and logs an error-level
//      line forever, for a machine that is behaving correctly;
//   2. the sharper one -- create an agent with the SAME NAME later and the
//      stale entry starts it immediately, without anyone asking for it.
//
// Measured on the live host the same day: agents-desired.json held 9 names and
// all 9 had a directory, so the defect had not fired there yet. This test is
// what keeps it from firing.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { addDesiredAgent, getDesiredAgents, removeDesiredAgent } from '../web/agent-desired-state.js'
import { agentSessionName } from '../web/agent-process.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

const hasTmuxSession = (session: string): boolean => {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// A name no live fleet member can collide with. The card is explicit about
// this: prove it with a throwaway name, never with a running fleet agent.
const THROWAWAY = 'zz-desired-state-probe'

function fakeCtx(path: string, method: string): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> | null }
} {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(chunk?: string) {
      if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown>
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req: {} as RouteContext['req'], res, path: url.pathname, method, url } as RouteContext,
    out,
  }
}

afterEach(() => {
  rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
  removeDesiredAgent(THROWAWAY)
  // Belt-and-braces: if a test's own cleanup didn't reach the kill (an assertion threw first),
  // a leaked session must not survive to the next test file/run.
  try { execFileSync('tmux', ['kill-session', '-t', agentSessionName(THROWAWAY)], { stdio: 'ignore' }) } catch {}
})

describe('DELETE /api/agents/:name and the desired run-state', () => {
  it('removes the name from agents-desired.json, not just the directory', async () => {
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    mkdirSync(STORE_DIR, { recursive: true })
    addDesiredAgent(THROWAWAY)

    // Positive control on the instrument itself: if the desired-state file did
    // not hold the name to begin with, the assertion below would pass on a
    // machine where the write silently failed, and prove nothing.
    expect(getDesiredAgents().has(THROWAWAY)).toBe(true)

    const { ctx, out } = fakeCtx(`/api/agents/${THROWAWAY}`, 'DELETE')
    const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))

    expect(handled).toBe(true)
    expect(out.body?.ok).toBe(true)
    expect(existsSync(agentDir(THROWAWAY))).toBe(false)
    expect(getDesiredAgents().has(THROWAWAY)).toBe(false)
  })

  it('leaves other agents alone', async () => {
    const bystander = 'zz-desired-state-bystander'
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    mkdirSync(STORE_DIR, { recursive: true })
    addDesiredAgent(THROWAWAY)
    addDesiredAgent(bystander)
    try {
      const { ctx } = fakeCtx(`/api/agents/${THROWAWAY}`, 'DELETE')
      await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
      // The delete must be surgical: clearing the whole file would "pass" the
      // test above while silently un-desiring the entire fleet.
      expect(getDesiredAgents().has(bystander)).toBe(true)
    } finally {
      removeDesiredAgent(bystander)
    }
  })

  it('stops the live tmux session before deleting, and reports it (card 82762751)', async () => {
    // The exact regression Cybered found: rmSync alone left the session running, a ghost that
    // burns quota and is invisible everywhere else once the directory it enumerates from is gone.
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    mkdirSync(STORE_DIR, { recursive: true })
    const session = agentSessionName(THROWAWAY)
    execFileSync('tmux', ['new-session', '-d', '-s', session, 'sleep 300'])

    // Positive control on the instrument: prove the session is really up before deleting through
    // it, or the assertion below would pass on a session that never existed.
    expect(hasTmuxSession(session)).toBe(true)

    const { ctx, out } = fakeCtx(`/api/agents/${THROWAWAY}`, 'DELETE')
    const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))

    expect(handled).toBe(true)
    expect(out.body?.ok).toBe(true)
    expect(out.body?.stoppedRunningAgent).toBe(true)
    expect(hasTmuxSession(session)).toBe(false)
    expect(existsSync(agentDir(THROWAWAY))).toBe(false)
  })

  it('reports stoppedRunningAgent:false when there was nothing to stop', async () => {
    // The other half: a delete on an already-stopped agent must not claim a stop that never
    // happened, and must not regress into trying to stop something that isn't running.
    mkdirSync(agentDir(THROWAWAY), { recursive: true })
    mkdirSync(STORE_DIR, { recursive: true })
    expect(hasTmuxSession(agentSessionName(THROWAWAY))).toBe(false)

    const { ctx, out } = fakeCtx(`/api/agents/${THROWAWAY}`, 'DELETE')
    await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))

    expect(out.body?.ok).toBe(true)
    expect(out.body?.stoppedRunningAgent).toBe(false)
  })

  it('does not touch the desired state when the agent does not exist', async () => {
    mkdirSync(STORE_DIR, { recursive: true })
    addDesiredAgent(THROWAWAY)

    // 404 path: no directory to delete, so nothing was decided about intent.
    // Clearing here would let a stray DELETE of a mistyped name knock a running
    // agent out of the desired set.
    const { ctx, out } = fakeCtx(`/api/agents/${THROWAWAY}`, 'DELETE')
    await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))

    expect(out.status).toBe(404)
    expect(getDesiredAgents().has(THROWAWAY)).toBe(true)
  })
})
