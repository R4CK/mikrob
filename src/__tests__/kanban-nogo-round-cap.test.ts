// F5 (card a577d0a4, phase b8ac0ef1): NO-GO round cap. Contract under test:
//   - the check is a pure no-op (zero side effects) when AGENT_VERDICT_ROUND_CAP is off --
//     fresh/default install behavior unchanged (code-quality rule 9);
//   - trailingFailedRounds counts consecutive FAILED rounds backward from the latest, stopping at
//     the first round where any designated gate passed -- not a literal round-number arithmetic,
//     so gaps in round numbering don't break or evade the cap;
//   - reaching the cap (3) moves the card to waiting, tags the title with
//     "[BLOKKOLT-Peti-dontes]", posts a findings-summary comment, and files exactly one Approvals
//     request -- a repeat check while that approval is still pending must not file a second one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, createKanbanCard, addKanbanVerdict, getKanbanCard, getKanbanComments, listApprovals, type KanbanVerdict } from '../db.js'
import { noGoRoundCapCheck, trailingFailedRounds, summarizeFailedRounds, isNoGoRoundCapEnabled, NOGO_ROUND_CAP } from '../web/kanban-nogo-round-cap.js'

function v(round: number, gate: KanbanVerdict['gate'], verdict: KanbanVerdict['verdict']): KanbanVerdict {
  return { id: 0, card_id: 'c1', gate, verdict, sha: null, round, findings_ref: null, proposer: null, author: 'x', author_verified: 1, created_at: 0 }
}

describe('kanban-nogo-round-cap', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1', title: 'x', status: 'in_progress' })
  })
  afterEach(() => {
    delete process.env.AGENT_VERDICT_ROUND_CAP
  })

  describe('trailingFailedRounds (pure)', () => {
    it('no verdicts: 0', () => {
      expect(trailingFailedRounds([])).toBe(0)
    })

    it('every round failed: counts all of them', () => {
      const vs = [v(1, 'QA', 'FAIL'), v(2, 'QA', 'NO-GO'), v(3, 'QA', 'FAIL')]
      expect(trailingFailedRounds(vs)).toBe(3)
    })

    it('a round with a PASS stops the streak, even with an earlier FAIL in the same round', () => {
      const vs = [v(1, 'QA', 'FAIL'), v(2, 'QA', 'FAIL'), v(2, 'CYBERSEC', 'PASS'), v(3, 'QA', 'FAIL')]
      // round 3 failed (count 1), round 2 has a PASS -> stop. Round 1 never reached.
      expect(trailingFailedRounds(vs)).toBe(1)
    })

    it('a passed round earlier resets what counts as the CURRENT streak', () => {
      const vs = [v(1, 'QA', 'FAIL'), v(2, 'QA', 'GO'), v(3, 'QA', 'FAIL'), v(4, 'QA', 'NO-GO')]
      // latest-first: 4 FAIL (1), 3 FAIL (2), 2 PASS -> stop. Round 1 never reached.
      expect(trailingFailedRounds(vs)).toBe(2)
    })

    it('tolerates gaps in round numbering -- counts by distinct failed rounds present, not arithmetic', () => {
      const vs = [v(1, 'QA', 'FAIL'), v(2, 'QA', 'NO-GO'), v(4, 'QA', 'FAIL')] // round 3 never written
      expect(trailingFailedRounds(vs)).toBe(3)
    })
  })

  describe('summarizeFailedRounds (pure)', () => {
    it('one line per round, oldest first, gate=verdict pairs', () => {
      const vs = [v(1, 'QA', 'FAIL'), v(2, 'QA', 'NO-GO'), v(3, 'CYBERED', 'NO-GO')]
      expect(summarizeFailedRounds(vs, 3)).toBe('round 1: QA=FAIL; round 2: QA=NO-GO; round 3: CYBERED=NO-GO')
    })

    it('limits to the last N rounds', () => {
      const vs = [v(1, 'QA', 'FAIL'), v(2, 'QA', 'FAIL'), v(3, 'QA', 'FAIL'), v(4, 'QA', 'FAIL')]
      expect(summarizeFailedRounds(vs, 2)).toBe('round 3: QA=FAIL; round 4: QA=FAIL')
    })
  })

  describe('noGoRoundCapCheck (flag gating)', () => {
    it('AGENT_VERDICT_ROUND_CAP unset/off: zero side effects even past the cap', () => {
      delete process.env.AGENT_VERDICT_ROUND_CAP
      expect(isNoGoRoundCapEnabled()).toBe(false)
      for (let r = 1; r <= NOGO_ROUND_CAP; r++) addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', round: r, author: 'qa', authorVerified: true })
      noGoRoundCapCheck('c1')
      const card = getKanbanCard('c1')!
      expect(card.status).toBe('in_progress')
      expect(card.title).toBe('x')
      expect(listApprovals({ category: 'kanban-nogo-round-cap' })).toHaveLength(0)
    })
  })

  describe('noGoRoundCapCheck (enabled)', () => {
    beforeEach(() => {
      process.env.AGENT_VERDICT_ROUND_CAP = '1'
    })

    it('below the cap: no escalation', () => {
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', round: 1, author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'NO-GO', round: 2, author: 'qa', authorVerified: true })
      noGoRoundCapCheck('c1')
      const card = getKanbanCard('c1')!
      expect(card.status).toBe('in_progress')
      expect(listApprovals({ category: 'kanban-nogo-round-cap' })).toHaveLength(0)
    })

    it('an earlier PASS among the trailing rounds prevents escalation, even past 3 total rounds', () => {
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', round: 1, author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', round: 2, author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', round: 3, author: 'qa', authorVerified: true })
      noGoRoundCapCheck('c1')
      expect(getKanbanCard('c1')!.status).toBe('in_progress')
      expect(listApprovals({ category: 'kanban-nogo-round-cap' })).toHaveLength(0)
    })

    it('cap reached: moves to waiting, tags the title, comments, and files one approval', () => {
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', round: 1, author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'NO-GO', round: 2, author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'NO-GO', round: 3, author: 'qa', authorVerified: true })
      noGoRoundCapCheck('c1')

      const card = getKanbanCard('c1')!
      expect(card.status).toBe('waiting')
      expect(card.title).toBe('[BLOKKOLT-Peti-dontes] x')

      const comments = getKanbanComments('c1')
      expect(comments.some((c) => c.author === 'nogo-round-cap-guard' && c.content.includes('NO-GO ROUND CAP REACHED'))).toBe(true)

      const approvals = listApprovals({ category: 'kanban-nogo-round-cap' })
      expect(approvals).toHaveLength(1)
      expect(approvals[0].status).toBe('pending')
      expect(approvals[0].action_description).toContain('c1')
    })

    it('repeat checks while the approval is still pending do not file a second one or re-tag', () => {
      for (let r = 1; r <= NOGO_ROUND_CAP; r++) addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', round: r, author: 'qa', authorVerified: true })
      noGoRoundCapCheck('c1')
      noGoRoundCapCheck('c1')
      noGoRoundCapCheck('c1')

      expect(getKanbanCard('c1')!.title).toBe('[BLOKKOLT-Peti-dontes] x')
      expect(listApprovals({ category: 'kanban-nogo-round-cap' })).toHaveLength(1)
    })

    it('a missing card is a silent no-op (fail-open, same contract as the spec-template guard)', () => {
      expect(() => noGoRoundCapCheck('no-such-card')).not.toThrow()
    })
  })
})
