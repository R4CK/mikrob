import { describe, expect, it } from 'vitest'
import { kanbanMoveInstructions } from '../web/routes/kanban.js'

// A card dispatched to an agent used to just say "drag it to done" -- but a
// headless agent cannot drag, and the run left no record on the card. The
// instructions now give the agent the exact curl to post a REVIEW result
// summary and to move the card to waiting, so the dispatched task's RESULT
// lands on its own card (visible in the dashboard UI) -- the lightweight
// alternative to per-session cards. Card 7fda4058 (2026-08-07): the template
// used to tell every agent to self-close to "done", which collides with the
// standing gate rule (only MikroB/QA close a finished card) -- an agent that
// followed the template literally would have bypassed the gate.
describe('kanbanMoveInstructions', () => {
  it('gives the agent the curl to post a REVIEW result comment AND to move to waiting, never self-close to done', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    // Step 1: a human-readable REVIEW result comment lands on the card.
    expect(out).toContain('/api/kanban/abc123/comments')
    expect(out).toContain('"author":"cody"')
    expect(out).toContain('REVIEW')
    // Step 2: move to waiting, NOT done -- closing is MikroB/gate's job.
    expect(out).toContain('/api/kanban/abc123/move')
    expect(out).toContain('"status":"waiting"')
    expect(out).not.toContain('"status":"done"')
    // It must NOT rely on the agent "dragging" the card (a headless agent can't).
    expect(out).not.toContain('húzd "done"-ra')
  })

  // Without an actor the board cannot tell a self-pickup from an assignment, so
  // every move curl the agent is handed names the agent as the mover -- including
  // the in_progress self-pickup, which is the one the dispatcher used to echo back.
  it('names the agent as the actor on every move it is told to make', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('"status":"done","actor":"cody"')
    expect(out).toContain('"status":"in_progress","actor":"cody"')
  })

  it('keeps the bearer token out of the message (reads it at run time)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('$(cat ')
    expect(out).toContain('.dashboard-token')
  })
})
