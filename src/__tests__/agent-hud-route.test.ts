import { describe, it, expect } from 'vitest'
import { requiresAuth } from '../web/auth-gate.js'
import { buildAgentHudRows } from '../web/routes/agent-hud.js'

// Card e9504aba. Two properties of the aggregate endpoint that are worth pinning, and
// one that is deliberately NOT tested here.
//
// The signal extraction itself is covered in agent-hud.test.ts against fixture lines.
// buildAgentHudRows reads the real filesystem (that is its job -- it locates each
// agent's transcript), so testing it against live transcripts would make assertions
// depend on whatever the fleet happens to be doing. What IS testable without that
// coupling is how it behaves for names that have no transcript and for names the path
// helper refuses -- which is exactly where a reader like this tends to throw and take
// a dashboard request down with it.

describe('GET /api/agent-hud is behind the auth gate', () => {
  it('requires auth -- it exposes live session signals', () => {
    // Asserted at the gate rather than trusted from a comment: requiresAuth is
    // deny-by-default for /api/* with a short public allowlist, and this route must
    // never join that list. A dashboard reader gets tool names and context sizes.
    expect(requiresAuth('/api/agent-hud', 'GET')).toBe(true)
  })

  it('is not in the public allowlist that the health digest and login sit in', () => {
    // Guards against someone widening the allowlist pattern later: these three ARE
    // public by design, and the assertion above stays meaningful only while this
    // route is not one of them.
    expect(requiresAuth('/api/public-digest', 'GET')).toBe(false)
    expect(requiresAuth('/api/auth/status', 'GET')).toBe(false)
    expect(requiresAuth('/api/agent-hud', 'GET')).toBe(true)
  })
})

describe('buildAgentHudRows -- degrades instead of throwing', () => {
  it('returns a row with empty signals for an agent that has no transcript', () => {
    const rows = buildAgentHudRows(['definitely-not-an-agent-e9504aba'])
    expect(rows).toHaveLength(1)
    expect(rows[0].agent).toBe('definitely-not-an-agent-e9504aba')
    expect(rows[0].activeTool).toBeNull()
    expect(rows[0].runningSubAgents).toBe(0)
    expect(rows[0].contextTokens).toBeNull()
  })

  it('SKIPS a name the path helper refuses instead of throwing', () => {
    // agentDir() goes through safeJoin, which throws on a traversal component. A HUD
    // request must not 500 because one registry entry is malformed -- the other agents
    // still have to render. The `..` name is the shape safeJoin rejects.
    const rows = buildAgentHudRows(['..', 'definitely-not-an-agent-e9504aba'])
    expect(rows.map((r) => r.agent)).toEqual(['definitely-not-an-agent-e9504aba'])
  })

  it('never emits a field beyond the derived contract', () => {
    // The binding constraint on the card, asserted on the row SHAPE: a future field
    // that carried tool input or a transcript quote would show up here.
    const rows = buildAgentHudRows(['definitely-not-an-agent-e9504aba'])
    expect(Object.keys(rows[0]).sort()).toEqual([
      'activeModel',
      'activeTool',
      'agent',
      'contextTokens',
      'runningSubAgents',
      'truncated',
    ])
  })
})
