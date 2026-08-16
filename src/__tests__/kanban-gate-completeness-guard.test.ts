// Card fca19f33 (Cybered's finding on 243de9b9): a `Gate: QA + Cybersec + Cybered` card was closed
// to done by QA alone, on its own PASS, while Cybersec and Cybered had said nothing -- both later
// gave NO-GO on a real, shipped, page-breaking regression. These tests hold the guard to being
// narrow, mirroring kanban-landed-guard.test.ts's own discipline: it must block the one case it
// claims and stay out of the way everywhere else.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = { id: 'c1', description: null as string | null }
let comments: Array<{ author: string; content: string; created_at: number }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: () => card,
  getKanbanComments: () => comments,
}))
export let infoLogs: Array<Record<string, unknown>> = []
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: (o: Record<string, unknown>) => infoLogs.push(o) },
}))

const { gateCompletenessGuardVerdict, extractGateLine, parseGateDesignation } = await import(
  '../web/kanban-gate-completeness-guard.js'
)

beforeEach(() => {
  card.description = null
  comments = []
  infoLogs = []
})

describe('extractGateLine', () => {
  it('takes the LAST Gate: line, not the first (card 84fd2839 shape -- a superseded tier decision)', () => {
    expect(extractGateLine('Gate: QA\n\nmore text\n\nGate: QA + Cybersec + Cybered (current)')).toBe(
      'QA + Cybersec + Cybered (current)',
    )
  })

  it('null description or no Gate: line at all -> null', () => {
    expect(extractGateLine(null)).toBeNull()
    expect(extractGateLine('no gate mentioned here')).toBeNull()
  })
})

describe('parseGateDesignation (ported from gate-dispatch-check.sh, same fixtures)', () => {
  it('241532d8-shape: an excluded gate named in its own parenthetical reasoning stays excluded', () => {
    const line =
      'QA + Cybersec (a kartya uj UNAUTH statikus route-ot vezet be, ami fajlnevet vesz at az URL-bol -- trust boundary, ezert Cybersec, nem Cybered).'
    const d = parseGateDesignation(line)
    expect(d).toEqual(new Set(['qa', 'qa2', 'cybersec']))
    expect(d?.has('cybered')).toBe(false)
  })

  it('35533cca-shape: an excluded gate named in a trailing exclusion sentence stays excluded', () => {
    const line =
      'QA + Cybered (Cybered a 9f74a0da 8232-es kommentjeben EXPLICIT utokort kert magara az ELESITESRE -- a dry-run-ra kapott GO nem fedi az elo hatast). Cybersec kimarad: az elesites nem nyit uj tamadasi feluletet.'
    const d = parseGateDesignation(line)
    expect(d).toEqual(new Set(['qa', 'qa2', 'cybered']))
    expect(d?.has('cybersec')).toBe(false)
  })

  it('QA alone widens to include QA2 (QA2-covered-by-QA rule)', () => {
    expect(parseGateDesignation('QA.')).toEqual(new Set(['qa', 'qa2']))
  })

  it('unparseable free text designates nothing', () => {
    expect(parseGateDesignation('see the linked design doc')).toBeNull()
  })
})

describe('gateCompletenessGuardVerdict', () => {
  it('only checks a transition TO done -- in_progress/waiting are always allowed', () => {
    card.description = 'Gate: QA + Cybersec + Cybered'
    expect(gateCompletenessGuardVerdict('c1', 'in_progress', false).blocked).toBe(false)
    expect(gateCompletenessGuardVerdict('c1', 'waiting', false).blocked).toBe(false)
  })

  it('the 243de9b9 incident itself: QA alone closes a 3-gate card -- BLOCKED, names the missing two', () => {
    card.description = 'Gate: QA + Cybersec + Cybered'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
    ]
    const v = gateCompletenessGuardVerdict('c1', 'done', false)
    expect(v.blocked).toBe(true)
    // The missing-agent list names exactly the two that never verdicted -- not QA, which passed.
    expect(v.message).toContain('Cybersec, Cybered')
  })

  it('all three gates verdicted -> allowed', () => {
    card.description = 'Gate: QA + Cybersec + Cybered'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
      { author: 'cybersec', content: 'CYBERSEC GO', created_at: 201 },
      { author: 'cybered', content: 'CYBERED GO', created_at: 202 },
    ]
    expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
  })

  it('a NO-GO/FAIL does NOT satisfy the requirement -- the card stays blocked, not just on silence', () => {
    card.description = 'Gate: QA + Cybersec'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
      { author: 'cybersec', content: 'CYBERSEC NO-GO -- one HIGH open', created_at: 201 },
    ]
    const v = gateCompletenessGuardVerdict('c1', 'done', false)
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('Cybersec')
  })

  it('a SKIP-marker (declared jurisdiction decline) satisfies the requirement', () => {
    card.description = 'Gate: QA + Cybered'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
      { author: 'cybered', content: 'CYBERED SKIP: nem az en hataskorom', created_at: 201 },
    ]
    expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
  })

  it('a STALE verdict (predates the newest REVIEW) does not satisfy a re-gate', () => {
    card.description = 'Gate: QA + Cybersec'
    comments = [
      { author: 'cybersec', content: 'CYBERSEC NO-GO @ old sha', created_at: 100 },
      { author: 'qa', content: 'QA PASS @ old sha', created_at: 101 },
      // A fix landed and a NEW review was posted after both old verdicts.
      { author: 'backend2', content: 'REVIEW -- fixed, new commit', created_at: 300 },
    ]
    const v = gateCompletenessGuardVerdict('c1', 'done', false)
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('QA')
    expect(v.message).toContain('Cybersec')
  })

  it('a fresh verdict AFTER the newest REVIEW satisfies a re-gate', () => {
    card.description = 'Gate: QA + Cybersec'
    comments = [
      { author: 'cybersec', content: 'CYBERSEC NO-GO @ old sha', created_at: 100 },
      { author: 'qa', content: 'QA PASS @ old sha', created_at: 101 },
      { author: 'backend2', content: 'REVIEW -- fixed, new commit', created_at: 300 },
      { author: 'qa', content: 'QA PASS @ new sha', created_at: 400 },
      { author: 'cybersec', content: 'CYBERSEC GO @ new sha', created_at: 401 },
    ]
    expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
  })

  it('QA PASS also covers QA2 when both are designated (QA2-covered-by-QA rule)', () => {
    card.description = 'Gate: QA2'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
    ]
    expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
  })

  it('no Gate: line at all -> allowed, logged as unverified (not silently identical to verified)', () => {
    card.description = 'just a plain description, no gate line'
    expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    expect(infoLogs.some((l) => l['reason'] === 'no-gate-line')).toBe(true)
  })

  it('mikrob with force:true bypasses the guard even with missing verdicts', () => {
    card.description = 'Gate: QA + Cybersec + Cybered'
    comments = [{ author: 'qa', content: 'QA PASS', created_at: 200 }]
    expect(gateCompletenessGuardVerdict('c1', 'done', true, 'mikrob').blocked).toBe(false)
  })

  it('force:true from a NON-mikrob actor does NOT bypass the guard', () => {
    card.description = 'Gate: QA + Cybersec + Cybered'
    comments = [{ author: 'qa', content: 'QA PASS', created_at: 200 }]
    expect(gateCompletenessGuardVerdict('c1', 'done', true, 'backend2').blocked).toBe(true)
  })

  // Card 1da2367a, the b68ddae8 incident: a real 3-gate card was wrongly BLOCKED on close even
  // though all three gates had genuinely, freshly verdicted -- only force:true+actor:'mikrob' got it
  // through. Root cause: QA's own convention prefixes a verdict with "REVIEW: QA PASS/FAIL", the
  // SAME word `latestReviewAt` looks for to find "the round just started". QA's comment landing
  // chronologically AFTER Cybered's real GO made Cybered's verdict look like it predated the round.
  describe('a GATE AGENT\'s own "REVIEW: ..."-prefixed verdict must not count as a new round-marker (card 1da2367a / b68ddae8)', () => {
    it('reproduces b68ddae8 exactly: Cybered GO lands before QA\'s "REVIEW: QA PASS" -- both must still count', () => {
      card.description = 'Gate: QA + Cybersec + Cybered'
      comments = [
        { author: 'backend', content: 'Gate-SHA: abc123\nREVIEW: kesz -- a leiras', created_at: 100 },
        { author: 'cybered', content: 'CYBERED GO.\n\nGate-SHA: abc123', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: abc123', created_at: 300 },
        { author: 'cybersec', content: 'CYBERSEC GO -- ...\n\nGate-SHA: abc123', created_at: 400 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('a QA verdict alone (no other round-marker) never blocks itself out of counting', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'qa', content: 'REVIEW: QA PASS', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO', created_at: 101 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('CONTROL: a genuinely stale gate verdict is still caught -- the fix does not just disable staleness', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'cybersec', content: 'CYBERSEC NO-GO @ old sha', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS @ old sha', created_at: 101 },
        // A genuine BUILDER round-marker after both old verdicts -- this one must still count.
        { author: 'backend2', content: 'REVIEW -- fixed, new commit', created_at: 300 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
      expect(v.message).toContain('Cybersec')
    })
  })

  it('the Gate-SHA-first comment shape (REVIEW on line 2, not line 1) is recognised as a round-marker', () => {
    card.description = 'Gate: QA + Cybersec'
    comments = [
      { author: 'cybersec', content: 'CYBERSEC NO-GO @ old sha', created_at: 100 },
      { author: 'qa', content: 'QA PASS @ old sha', created_at: 101 },
      // Gate-SHA on its OWN first line, "REVIEW" starts line 2 -- must still count as a fresh round.
      { author: 'backend2', content: 'Gate-SHA: newsha123\nREVIEW: kesz -- fixed', created_at: 300 },
    ]
    const v = gateCompletenessGuardVerdict('c1', 'done', false)
    expect(v.blocked).toBe(true) // the old verdicts are correctly stale against the new round
    expect(v.message).toContain('QA')
    expect(v.message).toContain('Cybersec')
  })
})
