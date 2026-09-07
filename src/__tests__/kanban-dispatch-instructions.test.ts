import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { kanbanMoveInstructions } from '../web/routes/kanban.js'

// The one line of the dispatch that is a COMMAND rather than prose.
const probeLine = (out: string): string | undefined =>
  out.split('\n').find((l) => l.includes('/api/kanban |'))

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

  // Upstream ties the `actor` field to a "self-close to done, with actor" flow (kanbanMoveInstructions
  // telling the agent to move done/in_progress with actor="cody"). Our fork's completion step is
  // "waiting", not "done" -- self-close is the exact thing the first test above forbids -- so this
  // function has no "done"/self-pickup-in_progress curl to name an actor on in the first place. The
  // `actor` field itself is real and used (moveKanbanCard/fireKanbanDispatch's self-advance-echo
  // suppression, see kanban.ts), just not through THIS instructional text's completion step.
  it('does not instruct a self-close-to-done actor move (fork policy, not upstream\'s)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).not.toContain('"status":"done","actor":"cody"')
  })

  // The dispatch fires once, when the card enters in_progress, and is correct at
  // that moment -- but the message rides the normal inter-agent queue and a busy
  // session may read it a round later, after the work is already done. The guard
  // cannot live at dispatch time (the card is not `testing` yet when the message
  // is written), so it has to be IN the message. These assert it is there, that it
  // is actionable, and that it is read BEFORE the work rather than after it.
  it('tells the reader to re-check the card status before starting', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('MIELŐTT NEKIKEZDESZ')
    expect(out).toContain('testing')
    expect(out).toContain('NE kezdj bele')
  })

  it('hands over the status check as a runnable command, not as an instruction to compose', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const probe = probeLine(out)
    expect(probe).toBeDefined()
    // Same token discipline as every other command in the message: read at run
    // time, never embedded.
    expect(probe).toContain('$(cat ')
    expect(probe).toContain('.dashboard-token')
  })

  // Text assertions cannot tell a working command from a plausible-looking one,
  // and this line's whole value is that the reader can paste it. So run the
  // program it emits: once against a board (the answer must be THIS card's status,
  // not a neighbour's) and once against the error object the endpoint returns when
  // the token cannot be read -- the shape that made the first draft die on a
  // Python TypeError, which is the one answer a pre-flight check must never give.
  const runProbeProgram = (out: string, stdin: string): string => {
    const probe = probeLine(out)!
    const program = probe.slice(probe.indexOf('python3 -c "') + 'python3 -c "'.length).replace(/"\s*$/, '')
    return execFileSync('python3', ['-c', program], { input: stdin, encoding: 'utf-8' }).trim()
  }

  it('the emitted program reports THIS card status and survives an error response', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const board = JSON.stringify([
      { id: 'zzz999', status: 'in_progress' },
      { id: 'abc123', status: 'testing' },
    ])
    expect(runProbeProgram(out, board)).toBe('testing')
    expect(runProbeProgram(out, JSON.stringify([{ id: 'zzz999', status: 'done' }]))).toBe('nincs ilyen kartya')
    const err = runProbeProgram(out, JSON.stringify({ error: 'Unauthorized' }))
    expect(err).toContain('Unauthorized')
    expect(err).not.toContain('Traceback')
  })

  it('puts the warning BEFORE the completion steps -- it is a pre-flight check', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out.indexOf('MIELŐTT NEKIKEZDESZ')).toBeLessThan(out.indexOf('Amikor VÉGEZTÉL'))
    // And it is the first thing in the block, not buried mid-message.
    expect(out.startsWith('MIELŐTT NEKIKEZDESZ')).toBe(true)
  })

  it('keeps the bearer token out of the message (reads it at run time)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('$(cat ')
    expect(out).toContain('.dashboard-token')
  })
})
