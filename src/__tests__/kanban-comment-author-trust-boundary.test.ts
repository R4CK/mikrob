// Card 1cdac111 (Cybersec LOW finding on 3906d77b, komment 5475): POST /api/kanban/:id/comments
// takes `author` straight from the request body (kanban.ts:1235), not from any auth-derived
// identity. Every fleet agent authenticates with the SAME shared dashboard Bearer token
// (resolveAuth in auth-gate.ts resolves it to the generic { kind: 'token' }, carrying no caller
// identity at all) -- so any token holder can post a comment claiming to be "qa", "cybersec" or
// any other agent, and the server has no way to tell.
//
// SURVEY (card 1cdac111 step 1): the consumers that read `author` as a signal are
// store/kanban_gate_author_role.py -> gate-closure-check.py (advisory reader) and
// landing-gate-verdict-parse.py (the ENFORCING reader that gates a push to origin/develop) --
// both already fixed by card 48b0dd36 to treat authorship as "the weaker, still useful
// statement: a verdict that does not even CLAIM to come from the gate is not that gate's
// verdict" (gate_author_role.py's own docstring), never as a certificate. The same card also
// closed the matching gap in src/web/kanban-draft-review-guard.ts.
//
// DECISION (card 1cdac111 step 3, the alternative the card itself allows): true server-side
// derivation (step 2 -- reject/override a body `author` that disagrees with an identified
// caller) is NOT CURRENTLY FEASIBLE, because the shared-token architecture gives the server no
// caller identity to compare against; building one is a distinct, larger authentication project,
// out of scope here. The accepted mitigation, already implemented for the roles that matter
// (QA/CYBERSEC/CYBERED verdict authorship) by card 48b0dd36, is: treat `author` as a claim, never
// as proof, everywhere it is consumed as a signal. This test locks that decision in as a
// regression: if a future change makes the comments endpoint derive `author` from real auth
// identity, this test should be the one that fails and forces a conscious update here (and in
// DECISIONS.md), not something that quietly stops being true.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

const getKanbanCard = vi.fn(() => ({ id: 'CARD0001', title: 'valódi kártya' }))
const addKanbanComment = vi.fn((cardId: string, author: string, content: string, automated?: boolean) => ({
  id: 1,
  card_id: cardId,
  author,
  content,
  automated: automated === true,
}))

vi.mock('../db.js', () => ({
  listKanbanCards: vi.fn(() => []),
  createKanbanCard: vi.fn(),
  updateKanbanCard: vi.fn(),
  deleteKanbanCard: vi.fn(),
  moveKanbanCard: vi.fn(),
  archiveKanbanCard: vi.fn(),
  unarchiveKanbanCard: vi.fn(),
  getKanbanComments: vi.fn(() => []),
  addKanbanComment,
  getKanbanCardEvents: vi.fn(() => []),
  listKanbanProjects: vi.fn(() => []),
  getKanbanCard,
  getChildCards: vi.fn(() => []),
  getDb: vi.fn(),
  createAgentMessage: vi.fn(),
  markKanbanCardDispatched: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn(() => undefined),
  listLabels: vi.fn(() => []),
  getLabel: vi.fn(),
  createLabel: vi.fn(),
  updateLabel: vi.fn(),
  deleteLabel: vi.fn(),
  addLabelToCard: vi.fn(),
  removeLabelFromCard: vi.fn(),
  getLabelsForAllCards: vi.fn(() => ({})),
  getLabelsForCard: vi.fn(() => []),
  listArchivedKanbanCards: vi.fn(() => []),
  revertIdeaFromKanban: vi.fn(),
  getHeartbeatKanbanSummary: vi.fn(() => ({})),
}))

const { tryHandleKanban } = await import('../web/routes/kanban.js')

function postComment(cardId: string, payload: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as any
  const captured: { status?: number; body?: string } = {}
  const res: any = {
    writeHead: (status: number) => { captured.status = status; return res },
    end: (chunk?: unknown) => { if (chunk !== undefined) captured.body = String(chunk) },
    setHeader: () => {},
  }
  const path = `/api/kanban/${cardId}/comments`
  return tryHandleKanban({
    req, res, path, method: 'POST',
    url: new URL(`http://localhost${path}`),
  } as unknown as Parameters<typeof tryHandleKanban>[0]).then(handled => ({ handled, ...captured }))
}

describe('POST /api/kanban/:id/comments -- author trust boundary (card 1cdac111)', () => {
  beforeEach(() => {
    addKanbanComment.mockClear()
  })

  it('ACCEPTS a body author claiming to be a gate role, with no auth-identity cross-check -- documented, not a bug', async () => {
    // Nothing in the request distinguishes this from a genuine QA comment: no per-caller
    // header, no device key, nothing but the same shared Bearer token every agent has. This
    // is the finding itself, reproduced as a standing regression check.
    const out = await postComment('CARD0001', { author: 'qa', content: 'QA PASS -- forged by any token holder' })

    expect(out.handled).toBe(true)
    expect(out.status).toBe(200)
    expect(addKanbanComment).toHaveBeenCalledWith('CARD0001', 'qa', 'QA PASS -- forged by any token holder', false)
  })

  // MUTATION CHECK: if someone "fixes" this by making the endpoint silently rewrite an
  // untrusted author to something safe, the two tests above would also go green on a
  // half-fix that breaks the documented fallback (every genuine agent comment authored
  // exactly as sent) -- this control catches a free-text author passing through unmolested.
  it('POZITÍV KONTROLL: a genuine author string still reaches storage byte-for-byte', async () => {
    const out = await postComment('CARD0001', { author: 'backend', content: 'valódi REVIEW' })

    expect(out.status).toBe(200)
    expect(addKanbanComment).toHaveBeenCalledWith('CARD0001', 'backend', 'valódi REVIEW', false)
  })
})
