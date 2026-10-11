// Card 2bfa4c67 (F2): the structured kanban_verdicts table is an ADDITIVE OR into
// gateCompletenessGuardVerdict's freshness check -- a gate counts as having verdicted if EITHER
// the existing comment-parse says so OR a fresh structured PASS/GO row exists. Unlike
// kanban-gate-completeness-guard.test.ts (which mocks db.js entirely to pin the comment-parse
// regex machinery in isolation), this file uses the REAL database so the structured path is
// actually exercised end to end, flag included.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, getDb, createKanbanCard, addKanbanVerdict, addKanbanComment } from '../db.js'
import { gateCompletenessGuardVerdict } from '../web/kanban-gate-completeness-guard.js'

describe('gateCompletenessGuardVerdict + structured kanban_verdicts (additive OR)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createKanbanCard({ id: 'c1', title: 'x', status: 'waiting', description: 'Gate: QA + Cybersec' })
  })
  afterEach(() => {
    delete process.env.AGENT_VERDICT_RECORD
  })

  it('flag ON + a fresh structured QA PASS row, zero comments: the close is allowed (QA satisfied via the structured record)', () => {
    process.env.AGENT_VERDICT_RECORD = '1'
    addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'qa', authorVerified: true })
    // Still missing Cybersec -- the OR only satisfies the gate it actually has a row for.
    const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
    expect(v.blocked).toBe(true)
    // "Cybersec" is the MISSING gate named in the message; QA is satisfied, so it must not be
    // named as missing -- but the card's own "Gate: QA + Cybersec" line is echoed verbatim, which
    // legitimately contains "QA" too. Assert on the actual missing-gate wording, not bare substring.
    expect(v.message).toContain('Cybersec verdiktjét is megköveteli')
    expect(v.message).not.toContain('QA verdiktjét is megköveteli')
  })

  it('flag ON + fresh structured rows for BOTH designated gates, zero comments: the close is allowed', () => {
    process.env.AGENT_VERDICT_RECORD = '1'
    addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'qa', authorVerified: true })
    addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
    const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
    expect(v.blocked).toBe(false)
  })

  it('flag OFF: the SAME structured rows do NOT satisfy the guard -- byte-identical to pre-card behavior', () => {
    delete process.env.AGENT_VERDICT_RECORD
    addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'qa', authorVerified: true })
    addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
    const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('QA')
    expect(v.message).toContain('Cybersec')
  })

  it('flag ON but the structured verdict is NO-GO/FAIL: does NOT satisfy the guard (only PASS/GO count)', () => {
    process.env.AGENT_VERDICT_RECORD = '1'
    addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', author: 'qa', authorVerified: true })
    addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'NO-GO', author: 'cybersec', authorVerified: true })
    const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('QA')
    expect(v.message).toContain('Cybersec')
  })

  // Card 2bfa4c67 delta (RedHat B3 + QA FAIL 16564): the measured bypass -- a structured FAIL/NO-GO
  // must never fall back to a forgeable comment-PASS, and a structured GO/PASS a later comment
  // contradicts must block as DISAGREE-SOURCE, not silently resolve to the permissive side.
  describe('DISAGREE-SOURCE (B3)', () => {
    it('structured FAIL + a comment-only PASS for the SAME gate: still blocked, never falls back (QA 16564 repro)', () => {
      process.env.AGENT_VERDICT_RECORD = '1'
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', author: 'qa', authorVerified: true })
      addKanbanComment('c1', 'qa', 'QA PASS')
      addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
      const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
      expect(v.blocked).toBe(true)
      expect(v.message).not.toContain('DISAGREE-SOURCE')
      expect(v.message).toContain('QA verdiktjét is megköveteli')
    })

    it('structured GO + a LATER comment-only NO-GO for the same gate: DISAGREE-SOURCE, not a silent ok', () => {
      process.env.AGENT_VERDICT_RECORD = '1'
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'qa', authorVerified: true })
      addKanbanComment('c1', 'qa', 'QA NO-GO')
      addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
      const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('DISAGREE-SOURCE')
      expect(v.message).toContain('QA')
    })

    it('structured GO + no contradicting comment: ok, no disagreement', () => {
      process.env.AGENT_VERDICT_RECORD = '1'
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'GO', author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
      const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
      expect(v.blocked).toBe(false)
    })
  })

  // B1 (b): defense in depth -- a structured row from an author outside the gate's own role must
  // never be trusted by the guard, even if it somehow reached the table.
  describe('role-allowlist defense in depth (B1/W1)', () => {
    it('a structured PASS row whose author is NOT in the QA role is ignored, card stays missing', () => {
      process.env.AGENT_VERDICT_RECORD = '1'
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'fullstack', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
      const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA verdiktjét is megköveteli')
    })
  })

  // Card 2bfa4c67 round 2 (WhiteHat2 NO-GO on 3d702874, N2 HIGH): the measured bypass -- a
  // VERIFIED FAIL/NO-GO record was silently overridden by a LATER, UNVERIFIED PASS/GO for the
  // same gate, because freshStructuredRow only ever looked at the single newest row.
  describe('verified-negative precedence (N2)', () => {
    it('a VERIFIED FAIL is NOT overridden by a later UNVERIFIED PASS for the same gate', () => {
      process.env.AGENT_VERDICT_RECORD = '1'
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'qa', authorVerified: false })
      addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
      const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA verdiktjét is megköveteli')
    })

    it('CONTROL: a VERIFIED FAIL IS overridden by a later VERIFIED PASS', () => {
      process.env.AGENT_VERDICT_RECORD = '1'
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'qa', authorVerified: true })
      addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
      const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
      expect(v.blocked).toBe(false)
    })

    it('CONTROL: an UNVERIFIED FAIL IS overridden by a later UNVERIFIED PASS (unchanged, neither side authenticated)', () => {
      process.env.AGENT_VERDICT_RECORD = '1'
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'FAIL', author: 'qa', authorVerified: false })
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'qa', authorVerified: false })
      addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
      const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
      expect(v.blocked).toBe(false)
    })
  })

  // Card 2bfa4c67 round 2 (WhiteHat2 NO-GO on 3d702874, N3): the measured bypass -- a genuine,
  // comment-only FAIL written FIRST (right after a REVIEW hand-off) was invisible to the DISAGREE
  // check once a (forgeable) structured PASS arrived LATER, because the old check only looked for
  // a negative comment AT OR AFTER the structured row's own timestamp.
  describe('order-independent comment-negative detection (N3)', () => {
    it('a negative comment BEFORE a later structured PASS still triggers DISAGREE-SOURCE', () => {
      process.env.AGENT_VERDICT_RECORD = '1'
      addKanbanComment('c1', 'qa', 'QA FAIL')
      addKanbanVerdict('c1', { gate: 'QA', verdict: 'PASS', author: 'qa', authorVerified: false })
      // Force a REAL chronological gap between the comment and the structured row -- addKanbanComment
      // and addKanbanVerdict both stamp wall-clock seconds, which a fast unit test cannot reliably
      // separate, so the old (buggy) `afterTs = row.created_at` check and the fixed `sinceTs` check
      // would otherwise both pass by accident (both rows land in the same second). Explicit
      // timestamps make the order deterministic: the comment is unambiguously BEFORE the row.
      const db = getDb()
      db.exec(`UPDATE kanban_comments SET created_at = 100 WHERE card_id = 'c1' AND content = 'QA FAIL'`)
      db.exec(`UPDATE kanban_verdicts SET created_at = 200 WHERE card_id = 'c1' AND gate = 'QA'`)
      addKanbanVerdict('c1', { gate: 'CYBERSEC', verdict: 'GO', author: 'cybersec2', authorVerified: true })
      const v = gateCompletenessGuardVerdict('c1', 'done', false, 'qa')
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('DISAGREE-SOURCE')
    })
  })
})
