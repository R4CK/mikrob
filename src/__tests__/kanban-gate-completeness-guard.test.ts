// Card fca19f33 (Cybered's finding on 243de9b9): a `Gate: QA + Cybersec + Cybered` card was closed
// to done by QA alone, on its own PASS, while Cybersec and Cybered had said nothing -- both later
// gave NO-GO on a real, shipped, page-breaking regression. These tests hold the guard to being
// narrow, mirroring kanban-landed-guard.test.ts's own discipline: it must block the one case it
// claims and stay out of the way everywhere else.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const card = { id: 'c1', description: null as string | null }
let comments: Array<{ author: string; content: string; created_at: number }> = []
// Card 4b72ef85 (Cybersec NO-GO): the id-lookup gate on CARD_MENTION_SHA_RX needs a set of OTHER
// real card ids to check a word-adjacent hex run against. Empty by default -- most tests never
// mention a card ID at all, and an empty board means no candidate can ever look like a real card.
let otherCardIds: string[] = []
// MikroB delta on card 4b72ef85 (LOW): listKanbanCards() must fail in isolation from
// getKanbanCard/getKanbanComments, not stand aside the whole guard.
let listKanbanCardsShouldThrow = false

vi.mock('../db.js', () => ({
  getKanbanCard: () => card,
  getKanbanComments: () => comments,
  listKanbanCards: () => {
    if (listKanbanCardsShouldThrow) throw new Error('listKanbanCards: simulated failure')
    return otherCardIds.map((id) => ({ id }))
  },
}))
export let infoLogs: Array<Record<string, unknown>> = []
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: (o: Record<string, unknown>) => infoLogs.push(o) },
}))

const { gateCompletenessGuardVerdict, extractGateLine, parseGateDesignation, anchoredGateVerdict } = await import(
  '../web/kanban-gate-completeness-guard.js'
)

beforeEach(() => {
  card.description = null
  comments = []
  infoLogs = []
  otherCardIds = []
  listKanbanCardsShouldThrow = false
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
    // Widened to include cybersec2 (card 21abfe0b, B1): bare "Cybersec" now widens the same way
    // bare "QA" already widened to qa2 below -- either sibling satisfies the family either way.
    expect(d).toEqual(new Set(['qa', 'qa2', 'cybersec', 'cybersec2']))
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

  // WHITEHAT/REDHAT (card cf0a8c0b, WhiteHat F1 NO-GO on the first landing attempt): the done-guard
  // must recognise the display-name alias too, or a card gated with the new name closes without
  // the security gate's verdict ever being required.
  it("F1: 'QA + WhiteHat' designates cybersec, not just qa (the regression)", () => {
    // Widened to include cybersec2 (card 21abfe0b, B1), same reasoning as the 241532d8-shape test.
    expect(parseGateDesignation('QA + WhiteHat.')).toEqual(new Set(['qa', 'qa2', 'cybersec', 'cybersec2']))
  })

  it("F1: 'WhiteHat' alone is not null -- it designates cybersec (+ widened cybersec2; qa/qa2 does NOT apply here)", () => {
    expect(parseGateDesignation('WhiteHat.')).toEqual(new Set(['cybersec', 'cybersec2']))
  })

  it("F1: 'QA + WhiteHat + RedHat' designates all three roles", () => {
    expect(parseGateDesignation('QA + WhiteHat + RedHat.')).toEqual(
      new Set(['qa', 'qa2', 'cybersec', 'cybersec2', 'cybered']),
    )
  })

  it('F1 CONTROL: the canonical Cybersec/Cybered spelling is unaffected by the alias addition', () => {
    expect(parseGateDesignation('QA + Cybersec + Cybered.')).toEqual(
      new Set(['qa', 'qa2', 'cybersec', 'cybersec2', 'cybered']),
    )
  })

  // WhiteHat2/cybersec2 (card 21abfe0b, RedHat NO-GO B1). The widening is SYMMETRIC and BIDIRECTIONAL
  // within the cybersec/cybersec2 family -- exactly like the pre-existing qa/qa2 widening above
  // (naming EITHER sibling widens the designated set to include BOTH), ported verbatim from the
  // shell side's widen_cybersec() (store/gate_designation.py, same card). The five inputs RedHat
  // measured directly against the real function BEFORE this fix: "QA + WhiteHat2" -> {qa, qa2}
  // (Cybersec silently dropped), "QA + cybersec2" -> {qa, qa2} (same drop), "WhiteHat2" alone ->
  // null (fail-open: no gate recognised at all, so the completeness guard allowed ANY close
  // force-free), "QA + WhiteHat" -> {cybersec, qa, qa2} (now ALSO widened to cybersec2, see F1
  // above), "QA + Cybersec2 + RedHat" -> {cybered, qa, qa2} (Cybersec2 dropped, Cybered
  // unaffected). All five are asserted below against the FIXED function.
  it('B1: "QA + WhiteHat2" designates cybersec (+cybersec2, +qa2), the regression RedHat measured', () => {
    expect(parseGateDesignation('QA + WhiteHat2.')).toEqual(
      new Set(['qa', 'qa2', 'cybersec', 'cybersec2']),
    )
  })

  it('B1: "QA + cybersec2" (canonical spelling, digit suffix) designates the same widened set', () => {
    expect(parseGateDesignation('QA + cybersec2.')).toEqual(
      new Set(['qa', 'qa2', 'cybersec', 'cybersec2']),
    )
  })

  it('B1: "WhiteHat2" ALONE is not null -- the fail-open RedHat\'s NO-GO is about', () => {
    expect(parseGateDesignation('WhiteHat2.')).toEqual(new Set(['cybersec', 'cybersec2']))
  })

  it('B1 CONTROL: "QA + WhiteHat" (no digit) widens to the same set as "QA + WhiteHat2" (symmetric family)', () => {
    expect(parseGateDesignation('QA + WhiteHat.')).toEqual(new Set(['qa', 'qa2', 'cybersec', 'cybersec2']))
  })

  it('B1: "QA + Cybersec2 + RedHat" designates all three families, Cybered unaffected', () => {
    expect(parseGateDesignation('QA + Cybersec2 + RedHat.')).toEqual(
      new Set(['qa', 'qa2', 'cybersec', 'cybersec2', 'cybered']),
    )
  })

  // Card bd5241b7 (real incident b474e1b9): a filename reference inside prose DISCUSSING the
  // absence of a Gate: line must not itself be read as a Gate: designation. The exact extracted
  // clause from b474e1b9's real description (after extractGateLine), where "NINCS Gate: sora"
  // (there is NO Gate: line) is itself a sentence that happens to contain "Gate:", and the clause
  // before the next '.'/'('/'!'/'?' contains the filename "cybersec-gate-scan.py" -- which, before
  // this fix, made \bcybersec\b match inside it (a hyphen counts as a word boundary) and demanded
  // a Cybersec verdict nobody designated.
  it('bd5241b7 (b474e1b9 real text): a filename reference inside prose is not a designation', () => {
    const line =
      'sora -- ha REVIEW kerul ra, a deklaracio-vezerelt cybersec-gate-scan.py nem fogja latni, mert nem nevez meg egyetlen gate-agentet sem (lasd 4a. munkavegzesi szabaly, kimondatlan gate-kijeloles).'
    expect(parseGateDesignation(line)).toBeNull()
  })

  // Card 165ff1af regression guard: a legitimate mid-sentence declaration (no preceding newline,
  // same shape as the false positive above) must keep matching. Anchoring GATE_LINE_RX/the clause
  // to line-start -- the fix bd5241b7 originally proposed -- would suppress BOTH this case and the
  // b474e1b9 false positive identically, since neither is preceded by a newline; this is why the
  // fix lives in parseGateDesignation's token-shape check instead.
  it('165ff1af regression guard: a mid-sentence "Gate: QA." declaration still designates qa/qa2', () => {
    expect(parseGateDesignation('QA.')).toEqual(new Set(['qa', 'qa2']))
  })

  it('bd5241b7: "Cybersec-only" (not filename-shaped: no extension, no "/") still designates cybersec', () => {
    expect(parseGateDesignation('Cybersec-only')).toEqual(new Set(['cybersec', 'cybersec2']))
  })

  it('bd5241b7: a path reference ("scripts/cybersec/x.sh") is excluded the same way a bare filename is', () => {
    expect(parseGateDesignation('lasd scripts/cybersec/x.sh')).toBeNull()
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

  it('card e87eef21 (WhiteHat f5ff1d5a F1): a NO-GO comment that mentions PASS/GO/SKIP elsewhere in its BODY (not the verdict line) still blocks the close', () => {
    card.description = 'Gate: QA + Cybersec'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
      {
        author: 'cybersec',
        content: 'CYBERSEC NO-GO -- F1 meg nyitva.\nA korabbi korben ez meg PASS volt, most mar nem.',
        created_at: 201,
      },
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

  // Card f5ff1d5a: qa2's own verdict comment starts "QA2 PASS" (rule 4c), not "QA PASS" -- the
  // incident this card describes is a close-guard that only recognized the literal "QA PASS"
  // string, forcing MikroB to force-close cards whose QA2 verdict was real but unrecognized.
  // VERDICT_RX (word-boundary \bPASS\b) plus the exact-author check already handle this: measured
  // directly (no change needed in production code), these two cases just close the regression gap.
  it('f5ff1d5a: author qa2 posting literal "QA2 PASS" satisfies the QA/QA2 family (word-boundary PASS, not the literal "QA PASS" string)', () => {
    card.description = 'Gate: QA'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa2', content: 'QA2 PASS\nGate-SHA: deadbeef', created_at: 200 },
    ]
    expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
  })

  it('f5ff1d5a: the same "QA2 PASS" text from a NON-gate author does NOT satisfy (author check stays exact, not just content-shaped)', () => {
    card.description = 'Gate: QA'
    comments = [{ author: 'backend2', content: 'QA2 PASS (quoting someone else, not a real verdict)', created_at: 200 }]
    const v = gateCompletenessGuardVerdict('c1', 'done', false)
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('QA')
  })

  // WhiteHat2/cybersec2 (card 21abfe0b, RedHat NO-GO B1). Integration-level versions of the
  // parseGateDesignation unit tests above: the fail-open RedHat measured was that a
  // "Gate: WhiteHat2" card closed with NO Cybersec/Cybersec2 verdict at all, force-free, because
  // the OLD parseGateDesignation returned null for it (treated as "no verifiable claim").
  it('B1: a cybersec2-authored GO satisfies a "Gate: WhiteHat2" card (the fail-open this NO-GO closes)', () => {
    card.description = 'Gate: QA + WhiteHat2'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
      { author: 'cybersec2', content: 'CYBERSEC GO', created_at: 201 },
    ]
    expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
  })

  it('B1: "Gate: WhiteHat2" alone with NO security verdict at all is now BLOCKED, not fail-open', () => {
    card.description = 'Gate: WhiteHat2'
    comments = [{ author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 }]
    const v = gateCompletenessGuardVerdict('c1', 'done', false)
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('Cybersec')
  })

  it('B1: a plain cybersec GO also satisfies a "Gate: WhiteHat2" card (the family is bidirectional)', () => {
    card.description = 'Gate: QA + WhiteHat2'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
      { author: 'cybersec', content: 'CYBERSEC GO', created_at: 201 },
    ]
    expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
  })

  it('B1: a cybersec2 NO-GO does NOT satisfy the requirement, same as cybersec\'s own NO-GO', () => {
    card.description = 'Gate: QA + WhiteHat2'
    comments = [
      { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
      { author: 'qa', content: 'QA PASS', created_at: 200 },
      { author: 'cybersec2', content: 'CYBERSEC NO-GO -- one HIGH open', created_at: 201 },
    ]
    const v = gateCompletenessGuardVerdict('c1', 'done', false)
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('Cybersec')
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

  describe('a GENERATED (local-llm/gate-pretriage) comment must never move the round boundary (card e7f91eb9, WhiteHat2 L1 on 1aeae282)', () => {
    it('a local-llm draft REVIEW-opening comment with a DIFFERENT Gate-SHA must not make real, fresh verdicts read as stale', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: a1b2c3d', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: a1b2c3d', created_at: 200 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: a1b2c3d', created_at: 300 },
        // post_draft_comment lands the local-llm model's raw output unfenced -- this one HAPPENS to
        // contain a REVIEW-shaped line citing a different (bogus) Gate-SHA, posted after both real
        // verdicts. Must not read as a new round the way a real builder hand-off would.
        { author: 'local-llm', content: 'REVIEW: draft otlet\nGate-SHA: deadbee', created_at: 400 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('is case-insensitive on the author string ("Local-LLM")', () => {
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: a1b2c3d', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: a1b2c3d', created_at: 200 },
        { author: 'Local-LLM', content: 'REVIEW: draft\nGate-SHA: deadbee', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('gate-pretriage (the other generated author) is excluded the same way', () => {
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: a1b2c3d', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: a1b2c3d', created_at: 200 },
        { author: 'gate-pretriage', content: 'REVIEW: draft\nGate-SHA: deadbee', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('no comment on the card ever uses the Gate-SHA convention -- latestReviewAt alone decides, and a local-llm REVIEW must not win there either', () => {
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS', created_at: 200 },
        // No Gate-SHA anywhere on the card, so currentRoundStartTs() returns null and the code
        // falls back to latestReviewAt() alone -- exactly the fallback path card e7f91eb9 names.
        { author: 'local-llm', content: 'REVIEW: draft otlet', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('CONTROL: a genuine builder hand-off AFTER a local-llm draft still correctly reopens the round', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: a1b2c3d', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: a1b2c3d', created_at: 200 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: a1b2c3d', created_at: 300 },
        { author: 'local-llm', content: 'REVIEW: draft otlet\nGate-SHA: deadbee', created_at: 400 },
        { author: 'backend2', content: 'REVIEW -- valodi javitas\nGate-SHA: e5f6071', created_at: 500 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true) // neither gate has verdicted e5f6071 yet -- must still block
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

  // Card 1da2367a, Cybersec's HIGH-severity NO-GO on the author-exclusion fix above (their own
  // adversarial probe, reproduced verbatim): the fix correctly closed b68ddae8 but was TOO WIDE --
  // `latestReviewAt` only recognised a new round via a non-gate author's REVIEW-prefixed comment.
  // A builder hand-off that skips the literal word "REVIEW" (a terse status ping, e.g.) left the
  // round boundary unmoved entirely, so a stale verdict for OLD code kept reading as fresh forever.
  describe('SHA-anchored round boundary (Cybersec NO-GO, card 1da2367a round 2): a round-marker with no literal "REVIEW" word still moves the boundary if it cites the new Gate-SHA', () => {
    it("Cybersec's own probe: a stale GO for a1b2c3d must not survive a d4e5f60 hand-off that never says the word REVIEW", () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz, sha=OLD\nGate-SHA: a1b2c3d', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO @ OLD sha\nGate-SHA: a1b2c3d', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA FAIL @ OLD sha\nGate-SHA: a1b2c3d', created_at: 300 },
        // NO literal "REVIEW" anywhere in this comment -- the old author-exclusion-only fix missed
        // this entirely and left sinceTs anchored at t=300, making Cybersec's t=200 GO look fresh.
        { author: 'backend2', content: 'pushed a fix, ready for re-check\nGate-SHA: d4e5f60', created_at: 400 },
        { author: 'qa', content: 'REVIEW: QA PASS @ NEW sha\nGate-SHA: d4e5f60', created_at: 500 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true) // Cybersec never verdicted d4e5f60 -- must stay blocked
      expect(v.message).toContain('Cybersec')
    })

    it('the SAME scenario, but Cybersec DOES re-verdict on d4e5f60 -> now correctly unblocked', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz, sha=OLD\nGate-SHA: a1b2c3d', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO @ OLD sha\nGate-SHA: a1b2c3d', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA FAIL @ OLD sha\nGate-SHA: a1b2c3d', created_at: 300 },
        { author: 'backend2', content: 'pushed a fix, ready for re-check\nGate-SHA: d4e5f60', created_at: 400 },
        { author: 'qa', content: 'REVIEW: QA PASS @ NEW sha\nGate-SHA: d4e5f60', created_at: 500 },
        { author: 'cybersec', content: 'CYBERSEC GO @ NEW sha\nGate-SHA: d4e5f60', created_at: 600 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('a multi-sha Gate-SHA line links a verdict to a round even when it cites only ONE of the shas', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaa111, bbb222', created_at: 100 },
        // Cybersec's own verdict restates only ONE of the two shas -- must still count as the round.
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: bbb222', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaa111, bbb222', created_at: 201 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    // Cybersec's round-3 NO-GO (HIGH, comment 13915): a later multi-sha citation bundling an OLD,
    // already-closed sha together with a genuinely NEW one must not drag the round boundary back to
    // the old sha's first mention -- the boundary is the LATEST of each cited sha's own earliest
    // introduction, so an old sha riding along in a later diff-range citation cannot outrank the new
    // one that actually started the round.
    it("Cybersec's round-3 probe: a later 'Gate-SHA: old, new' citation must not resurrect an old, already-superseded verdict", () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa1', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO @ old\nGate-SHA: aaaaaaa1', created_at: 120 },
        { author: 'cybersec', content: 'CYBERSEC NO-GO @ old (unrelated later finding)\nGate-SHA: aaaaaaa1', created_at: 150 },
        // A REAL round change, its own literal "REVIEW", a genuinely new sha.
        { author: 'backend2', content: 'REVIEW -- kesz, uj commit\nGate-SHA: bbbbbbb2', created_at: 200 },
        // QA cites the full diff range (old+new together) -- a documented, supported shape.
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaaaaaa1, bbbbbbb2', created_at: 250 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      // Cybersec never verdicted bbbbbbb2 -- the t=120 GO (for aaaaaaa1 alone) must not count.
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('Cybersec')
    })

    it('the SAME round-3 scenario, but Cybersec DOES verdict the multi-sha citation itself -> correctly unblocked', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa1', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO @ old\nGate-SHA: aaaaaaa1', created_at: 120 },
        { author: 'backend2', content: 'REVIEW -- kesz, uj commit\nGate-SHA: bbbbbbb2', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaaaaaa1, bbbbbbb2', created_at: 250 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: aaaaaaa1, bbbbbbb2', created_at: 260 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it("Cybersec's round-4 probe: a later comment that re-cites ONLY an old, already-superseded sha must not drag the boundary back to it", () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa1', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO @ old\nGate-SHA: aaaaaaa1', created_at: 120 },
        // A REAL new round: its own literal REVIEW, a genuinely new sha, QA verdicts it fresh.
        { author: 'backend2', content: 'REVIEW -- kesz, uj commit\nGate-SHA: bbbbbbb2', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: bbbbbbb2', created_at: 220 },
        // A later, non-verdict retrospective comment that cites ONLY the OLD sha on its own -- round
        // 3's "pick the chronologically last comment, then look at ITS sha set" logic let this drag
        // the boundary back to aaaaaaa1's t=100, resurrecting Cybersec's stale t=120 GO.
        { author: 'mikrob', content: 'MEGJEGYZES: a regressziot aaaaaaa1-re vezettuk vissza.\nGate-SHA: aaaaaaa1', created_at: 300 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      // Cybersec never verdicted bbbbbbb2 -- the boundary must stay at bbbbbbb2's t=200 regardless.
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('Cybersec')
    })

    it('the SAME round-4 scenario, but Cybersec DOES verdict the new sha before the stray old-sha mention -> correctly unblocked', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa1', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO @ old\nGate-SHA: aaaaaaa1', created_at: 120 },
        { author: 'backend2', content: 'REVIEW -- kesz, uj commit\nGate-SHA: bbbbbbb2', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: bbbbbbb2', created_at: 220 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: bbbbbbb2', created_at: 230 },
        { author: 'mikrob', content: 'MEGJEGYZES: a regressziot aaaaaaa1-re vezettuk vissza.\nGate-SHA: aaaaaaa1', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    // Real incident d4a2130d (card 85c87024): QA declared the full 40-char Gate-SHA, Cybersec
    // declared the short 8-char form of the SAME commit, posted AFTER QA. Before the fix these
    // were two different map keys, so the round boundary jumped to Cybersec's later citation and
    // QA's earlier, genuinely-fresh PASS read as pre-round -- "QA verdikt hianyzik" on a card both
    // gates had actually approved.
    it('d4a2130d: QA (full-length Gate-SHA) and Cybersec (short-length, SAME commit, posted later) both count -- no false "missing verdict"', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: 17ee54f587455ae34061d06b085fce15a022bd21', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 17ee54f587455ae34061d06b085fce15a022bd21', created_at: 200 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 17ee54f5', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    // Negative control: a short sha that merely SHARES A PREFIX with an unrelated full sha must
    // stay two distinct commits -- the fix groups by prefix identity (same commit, different
    // citation length), not by "any two shas that happen to overlap in their first 6 chars".
    it('CONTROL: two DIFFERENT commits that happen to share their first 6 hex chars are not collapsed into one round', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaa1111111111111111111111111111111111', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO @ old\nGate-SHA: aaaaaa1111111111111111111111111111111111', created_at: 120 },
        // A genuinely different commit that only coincidentally shares the first 6 hex chars.
        { author: 'backend2', content: 'REVIEW -- kesz, uj commit\nGate-SHA: aaaaaa2222222222222222222222222222222222', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaaaaa2222222222222222222222222222222222', created_at: 220 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      // Cybersec never verdicted the new commit -- must still block.
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('Cybersec')
    })

    it('no comment on the card EVER used the Gate-SHA convention -> falls back to the word/author heuristic unchanged', () => {
      card.description = 'Gate: QA + Cybersec + Cybered'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
        { author: 'qa', content: 'QA PASS', created_at: 200 },
        { author: 'cybersec', content: 'CYBERSEC GO', created_at: 201 },
        { author: 'cybered', content: 'CYBERED GO', created_at: 202 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })
  })

  // Real incident on 5a50bc69 (card 4ae2d3f5): a status:done PUT answered 409 "QA verdikt hianyzik"
  // while BOTH gates had already passed the SAME Gate-SHA, correctly shaped. Cybersec's line named
  // the PARENT commit as context -- "Gate-SHA: 5f7abb6c (szulo 9f0f75ef, ...)" -- and every hex run
  // on a Gate-SHA line counts as a cited sha, so the parent became one; its first mention is that
  // late Cybersec comment, and Math.max over first-mention times therefore dragged the round
  // boundary past QA's genuinely-fresh PASS.
  describe('a parenthetical PARENT reference must not move the round boundary (card 4ae2d3f5)', () => {
    it('the measured 5a50bc69 shape: QA PASS then a Cybersec GO citing the PARENT -> unblocked', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        {
          author: 'cybersec',
          content: 'CYBERSEC GO\nGate-SHA: 5f7abb6c (szulo 9f0f75ef, ugyanaz a backend-ag)',
          created_at: 300,
        },
      ]
      // Before this card: 9f0f75ef counted as a cited sha whose first mention is t=300, so the
      // round boundary moved there and QA's t=200 PASS -- for the very same commit -- read as
      // stale. MikroB had to close 5a50bc69 with force:true.
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('accented "szulo" with an accent, English "parent" and a colon form are all recognised', () => {
      for (const marker of ['sz\u00fcl\u0151', 'parent', 'szulo:']) {
        card.description = 'Gate: QA + Cybersec'
        comments = [
          { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
          { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
          {
            author: 'cybersec',
            content: 'CYBERSEC GO\nGate-SHA: 5f7abb6c (' + marker + ' 9f0f75ef)',
            created_at: 300,
          },
        ]
        expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
      }
    })

    it('CONTROL: an UNMARKED sha in the same parenthetical shape STILL moves the boundary (cited by a non-gate author)', () => {
      // Without this control, the blunt repair the card first suggested -- ignore everything after
      // the "(" -- would also pass, and that one reopens card 367c23a9's incident wholesale
      // ("landolt <sha>" and "alap <sha>" are genuine co-citations and must keep counting).
      //
      // Card 9ce3181c (round-5 correction): the citing author here is now 'backend2', not
      // 'cybersec' as in the original shape -- a GATE's own citation can no longer open a new round
      // by itself (that asymmetry was the 29609ec6 incident this round-5 fix closes), so this
      // control's "still moves the boundary" claim can only hold for a non-gate introduction. The
      // parenthetical shape and the extraction/blanking regex exercised are unchanged.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        {
          author: 'backend2',
          content: 'REVIEW: meg egy valtozas\nGate-SHA: 5f7abb6c (landolt 9f0f75ef)',
          created_at: 300,
        },
      ]
      // 9f0f75ef is unmarked and first appears at t=300, so that IS the round start and QA's
      // t=200 PASS is genuinely stale.
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
    })

    it('CONTROL: the exclusion is per OCCURRENCE -- a bare later citation still opens a round', () => {
      // Dropping the sha by VALUE would silence a genuine later round that happens to be gated on
      // the commit an earlier comment once called a parent.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        {
          author: 'backend',
          content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c (szulo 9f0f75ef)',
          created_at: 100,
        },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'backend', content: 'REVIEW: ujra\nGate-SHA: 9f0f75ef', created_at: 300 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 9f0f75ef', created_at: 400 },
      ]
      // The bare t=300 citation starts a new round, so QA's t=200 PASS is correctly stale.
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(true)
    })
  })

  describe('a bare kanban card-ID mention is not a Gate-SHA citation (card 4b72ef85)', () => {
    beforeEach(() => {
      // 4b9688f6 is a REAL other card on the board in every test in this block -- the id-lookup
      // gate (Cybersec NO-GO) needs that to be true for the blanking to fire at all.
      otherCardIds = ['4b9688f6']
    })

    it('the measured shape: "lasd Cybered leletet a <id> kartyan" -> unblocked', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        {
          author: 'cybersec',
          content:
            'CYBERSEC GO\nGate-SHA: 5f7abb6c, lasd Cybered leletet a 4b9688f6 kartyan tovabbi kontextusert',
          created_at: 300,
        },
      ]
      // Before this card: 4b9688f6 counted as a cited sha whose first mention is t=300 (it is
      // exactly card-ID-shaped), pulling the round boundary forward and reading QA's t=200 PASS
      // as stale.
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('the word-BEFORE English shape ("card <id>") and accented Hungarian ("kártyán") are both recognised', () => {
      // QA2 FAIL on this card: 'kártyán 4b9688f6' (accented word BEFORE the hex) used to NOT gate,
      // because JS's ASCII-only \w stopped the word match before the accented suffix, and the
      // required separator then failed on the leftover accented letters. 'a 4b9688f6 kártyán' (hex
      // first) worked by accident even before the fix -- both directions must hold now.
      for (const shape of ['card 4b9688f6', 'a 4b9688f6 kártyán', 'kártyán 4b9688f6', 'kártyája 4b9688f6']) {
        card.description = 'Gate: QA + Cybersec'
        comments = [
          { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
          { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
          {
            author: 'cybersec',
            content: 'CYBERSEC GO\nGate-SHA: 5f7abb6c, ' + shape,
            created_at: 300,
          },
        ]
        expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
      }
    })

    it('CONTROL: the exclusion is per OCCURRENCE -- the same id cited bare elsewhere still counts as a real Gate-SHA', () => {
      // Dropping the token by VALUE would silence a genuine later round gated on a commit whose
      // short sha happens to collide in shape with a card ID mentioned earlier.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        {
          author: 'backend',
          content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c, lasd a 4b9688f6 kartyan',
          created_at: 100,
        },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'backend', content: 'REVIEW: ujra\nGate-SHA: 4b9688f6', created_at: 300 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 4b9688f6', created_at: 400 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(true)
    })

    it('ADVERSARIAL (Cybersec NO-GO 4594 + QA2 FAIL 4661 delta, non-discriminating-test finding): a REAL Gate-SHA next to a card-word is NOT deleted when it is not a known card id', () => {
      // The exact unsafe case Cybersec measured: word-adjacency alone used to blank "34ff8cae" here,
      // erasing a genuine commit citation. 34ff8cae is NOT in otherCardIds (only 4b9688f6 is), so it
      // must survive and correctly start a new round -- making the t=250 cybersec verdict stale.
      //
      // THE cybersec(t=250) COMMENT IS THE DISCRIMINATING SIGNAL (QA2/Cybersec delta finding on this
      // card): without ANY cybersec-authored comment on the fixture, hasFreshVerdict('cybersec', ...)
      // is unconditionally false regardless of sinceTs, so blocked=true on BOTH the fix and a
      // word-adjacency-only regression -- just for two different reasons, which a mutation test
      // cannot tell apart. Timing it strictly BETWEEN the two Gate-SHA introductions (t=100, t=300)
      // makes the verdict fresh-or-stale entirely DEPEND on whether 34ff8cae survived extraction:
      // fix -> sinceTs=300 -> t=250 is stale -> blocked=true (correct reason); a regression that
      // deletes 34ff8cae -> sinceTs stays 100 -> t=250 reads fresh -> blocked=false (catches it).
      otherCardIds = ['4b9688f6']
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 5f7abb6c', created_at: 250 },
        { author: 'backend', content: 'REVIEW: javitva\nGate-SHA: 34ff8cae kártyán', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(true)
    })

    it('ADVERSARIAL (Cybersec NO-GO 4594 + QA2 FAIL 4661 delta, non-discriminating-test finding): the greedy word stem hitting an unrelated word ("cardinal") does not delete an adjacent real Gate-SHA either', () => {
      // Same discriminating-timing shape as the case above -- see its comment for why the
      // cybersec(t=250) comment, not just the final blocked value, is what makes this test real.
      otherCardIds = ['4b9688f6']
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 5f7abb6c', created_at: 250 },
        {
          author: 'backend',
          content: 'REVIEW: javitva\nGate-SHA: deadbeef1234 cardinal directions',
          created_at: 300,
        },
      ]
      // 'cardinal' matches the word stem, but deadbeef1234 is not a known card id, so it must
      // still count as the round's real subject -- the t=250 cybersec verdict reads as stale.
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(true)
    })

    it('LOW (MikroB delta): a listKanbanCards() failure does not stand aside the WHOLE guard, only disables the id-lookup blanking', () => {
      // A failure here is not the same kind of failure as "cannot read this card" -- it says nothing
      // about whether THIS close is verified, so it must not fall through to allowUnverified/stand
      // aside (which would let ANY close through). It must fail toward blanking NOTHING, which is the
      // safe direction: without a known-card-id list, the bare "4b9688f6 kartyan" mention below counts
      // as a real Gate-SHA (the pre-fix behaviour), so the round boundary moves forward and QA's
      // earlier PASS reads as stale -- MORE strict, never less.
      listKanbanCardsShouldThrow = true
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'backend', content: 'REVIEW: meg egy\nGate-SHA: 4b9688f6 kartyan', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(true)
    })
  })

  describe('a bare kanban card-ID cited via "saját REVIEW-ja/kommentje" is not a Gate-SHA citation (card 211686ab, real incident 6980f9c7)', () => {
    beforeEach(() => {
      // 4bf530eb is a REAL other card on the board in every test in this block -- the id-lookup
      // gate needs that to be true for the blanking to fire at all.
      otherCardIds = ['4bf530eb']
    })

    it('THE MEASURED SHAPE: "ugyanaz a konvenció mint a <id> saját REVIEW-ja" -> unblocked', () => {
      // Cybersec's own Gate-SHA line on 6980f9c7 carried neither a "kártya"/"card" marker word nor
      // a slash nor a parent-marker word next to 4bf530eb -- none of the three PRE-EXISTING
      // exclusions reached it, so the guard extracted it as the round's newest sha and moved the
      // boundary to t=300, reading QA's real t=200 PASS as stale.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        {
          author: 'cybersec',
          content: 'CYBERSEC GO\nGate-SHA: 5f7abb6c, ugyanaz a konvenció mint a 4bf530eb saját REVIEW-ja',
          created_at: 300,
        },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('"saját kommentje" is recognised too, not just "saját REVIEW-ja"', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        {
          author: 'cybersec',
          content: 'CYBERSEC GO\nGate-SHA: 5f7abb6c, lásd a 4bf530eb saját kommentje szerint',
          created_at: 300,
        },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('CONTROL: the exclusion is per OCCURRENCE -- the same id cited bare elsewhere still counts as a real Gate-SHA', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        {
          author: 'backend',
          content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c, mint a 4bf530eb saját REVIEW-ja',
          created_at: 100,
        },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'backend', content: 'REVIEW: ujra\nGate-SHA: 4bf530eb', created_at: 300 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 4bf530eb', created_at: 400 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(true)
    })

    it('ADVERSARIAL: a REAL Gate-SHA next to "saját komment(em)" is NOT deleted when it is not a known card id', () => {
      // "saját kommentem szerint" is a genuine idiom someone could use to restate their OWN earlier
      // citation of a REAL sha. 34ff8cae is not in otherCardIds (only 4bf530eb is), so it must
      // survive and correctly start a new round -- making the t=250 cybersec verdict stale.
      otherCardIds = ['4bf530eb']
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 5f7abb6c', created_at: 250 },
        {
          author: 'backend',
          content: 'REVIEW: javitva\nGate-SHA: 34ff8cae saját kommentem szerint',
          created_at: 300,
        },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(true)
    })
  })

  // Real incident on d0b4f003 (card 367c23a9): three gate agents cited the SAME round's Gate-SHA
  // in three different shapes on one line. QA's PASS read as stale ("QA verdikt hianyzik") because
  // Cybersec's "+"-joined citation silently lost its second sha to the old comma-anchored
  // extraction, mis-anchoring the round boundary to a citation of an EARLIER sha instead.
  // MikroB had to force:true past this false positive.
  describe('three different Gate-SHA line SHAPES for the same round (card 367c23a9, real incident d0b4f003)', () => {
    it('a "+"-joined multi-sha citation ("old + new (...)") must not lose the NEW sha or misattribute the OLD one', () => {
      card.description = 'Gate: QA + Cybersec + Cybered'
      comments = [
        { author: 'fron-ted', content: 'REVIEW\nGate-SHA: bc7ceddc (landolt merge f3380837, seam OK)', created_at: 100 },
        { author: 'qa', content: 'QA PASS\nGate-SHA: bc7ceddc (a sajat munka merge-je: f3380837, alap dc7a6451)', created_at: 200 },
        // Cybersec's shape is the one that broke the old extraction: a "+"-joined pair, THEN a
        // trailing comma-separated "landolt <sha>" clause -- neither the second "+"-sha nor the
        // trailing clause's sha were readable under the old first-token-per-comma-segment rule.
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: dc7a6451 + bc7ceddc (a kartya sajat munkaja), landolt f3380837', created_at: 300 },
        { author: 'cybered', content: 'CYBERED GO\nGate-SHA: bc7ceddc (landolt merge f3380837)', created_at: 400 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      // Every designated gate DID verdict this exact round -- must not block.
      expect(v.blocked).toBe(false)
    })

    it('CONTROL: the same "+"-joined shape genuinely citing a NEWER sha still moves the round boundary forward', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa1', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: aaaaaaa1', created_at: 120 },
        // A real new round, cited only via the "+"-joined shape -- must still register bbbbbbb2.
        { author: 'backend2', content: 'REVIEW -- kesz, uj commit\nGate-SHA: aaaaaaa1 + bbbbbbb2 (delta)', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: bbbbbbb2', created_at: 220 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      // Cybersec never verdicted bbbbbbb2 -- must still block.
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('Cybersec')
    })
  })

  describe('a sha glued into a BRANCH NAME is not a citation (card a20f0aa7, real incident 5bc8f740)', () => {
    it('the measured 5bc8f740 shape: the card\'s OWN ID in the branch name + a merge-base -> QA stays fresh', () => {
      // Cybersec's real line. Three hex runs on it, only ONE of which is a cited commit:
      //   8b8377cf  -- the subject
      //   5bc8f740  -- the CARD ID, tail of the branch name; eight hex chars, shaped like a short sha
      //   0d5ebb6c  -- the merge-base, an ancestor by definition
      // Both impostors are "introduced" later than QA's PASS, so Math.max dragged the round boundary
      // to Cybersec's comment and QA's PASS for the SAME commit, 601s earlier, read as stale.
      // The dashboard answered 409 "QA verdikt hianyzik"; MikroB had to close it with force:true.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 8b8377cf', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 8b8377cf', created_at: 200 },
        {
          author: 'cybersec',
          content:
            'CYBERSEC GO\nGate-SHA: 8b8377cf (CleanCore, ag fix/platform-admin-append-tail-5bc8f740, merge-base 0d5ebb6c, NEM landolt)',
          created_at: 300,
        },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('`merge-base <sha>` ALONE is an ancestor reference -- pinned independently of the branch-name half', () => {
      // The incident line carries BOTH defects at once, so it cannot tell the two fixes apart: drop
      // either one and that single case goes red. This isolates the marker half, so a future change
      // that removes `merge-base` from the list is caught by a case that names it.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 8b8377cf', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 8b8377cf', created_at: 200 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 8b8377cf (merge-base 0d5ebb6c)', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('CONTROL: a BACKTICKED sha is a real citation and still moves the boundary (cited by a non-gate author)', () => {
      // The first cut of this rule keyed on the character adjacent to the hex run, which dropped
      // this shape (measured live on card ca38deac: "bb27c07b (ag `agent/backend2/work`, pusholva;
      // a harness `3dcbbefc`)"). A backtick is quoting, not a path.
      //
      // Card 9ce3181c (round-5 correction): author changed from 'cybersec' to 'backend2' -- see the
      // matching note on the 'UNMARKED sha' control above; a gate's own citation can no longer open
      // a new round by itself.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'backend2', content: 'REVIEW: info\nGate-SHA: 5f7abb6c (a harness `3dcbbefc`)', created_at: 300 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
    })

    it('CONTROL: a HUNGARIAN-SUFFIXED sha is a real citation and still moves the boundary (cited by a non-gate author)', () => {
      // Same rejected first cut: "a21e5528-on", "9f0a8639-ben" are how this fleet writes about a
      // commit in prose. A hyphen before a suffix is not a path separator.
      //
      // Card 9ce3181c (round-5 correction): author changed from 'cybersec' to 'backend2', same
      // reasoning as the control above.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'backend2', content: 'REVIEW: info\nGate-SHA: 5f7abb6c (megfigyeles a21e5528-on)', created_at: 300 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
    })

    it('CONTROL: the slash-joined "both commits" idiom A/B is NOT a path and still counts (cited by a non-gate author)', () => {
      // The SECOND rejected cut ("any token containing a slash is a path") swallowed this and
      // invalidated a genuine QA2 verdict on card 67807f6f, where the line read
      // "aa40afef (a 89665d8a/06200298 tetejen ...)". Every segment here is itself a bare sha, so
      // the token is a citation pair, not a branch name.
      //
      // Card 9ce3181c (round-5 correction): author changed from 'cybersec' to 'backend2', same
      // reasoning as the two controls above. This is also the exact incident shape (29609ec6): a
      // "both commits" idiom citing a second, previously-uncited sha -- the difference is this one
      // is now attributed to a non-gate author, so it legitimately opens a round, where the real
      // incident had it attributed to QA (a gate), which must NOT.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
        { author: 'backend2', content: 'REVIEW: info\nGate-SHA: 5f7abb6c (89665d8a/06200298 tetejen)', created_at: 300 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
    })

    it('CONTROL: `alap <sha>` and `landolt <sha>` stay INCLUDED -- card 367c23a9 does not regress (cited by a non-gate author)', () => {
      // The blunt repair proposed twice for this incident -- drop the parenthetical, or add
      // alap/base to the parent-marker list -- reopens 367c23a9, where these ARE the round's own
      // co-citations. Only `merge-base` was added, and only it.
      //
      // Card 9ce3181c (round-5 correction): author changed from 'cybersec' to 'backend2', same
      // reasoning as the controls above.
      for (const shape of ['(alap 9f0f75ef)', '(landolt 9f0f75ef)']) {
        card.description = 'Gate: QA + Cybersec'
        comments = [
          { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 5f7abb6c', created_at: 100 },
          { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 5f7abb6c', created_at: 200 },
          { author: 'backend2', content: 'REVIEW: info\nGate-SHA: 5f7abb6c ' + shape, created_at: 300 },
        ]
        const v = gateCompletenessGuardVerdict('c1', 'done', false)
        expect(v.blocked).toBe(true)
      }
    })

    it('a branch-name card ID does not hide a GENUINE later round either', () => {
      // The rule must not become a way to smuggle a real new commit past the boundary: the branch
      // token is ignored, but the sha cited beside it is not.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: 'REVIEW: kesz\nGate-SHA: 8b8377cf', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 8b8377cf', created_at: 200 },
        {
          author: 'backend',
          content: 'REVIEW -- uj kor\nGate-SHA: c0ffee12 (ag fix/whatever-5bc8f740)',
          created_at: 300,
        },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
    })
  })

  describe("a GATE's own Gate-SHA citation must not open a new round (card 9ce3181c, real incident 29609ec6)", () => {
    // THE INCIDENT, reproduced: both designated gates verdicted FRESH on the SAME commit
    // (7132429b). QA's own verdict happened to use the fleet's "both commits" idiom, citing the
    // merge sha AND the underlying work-commit (ad85d4cb) together -- ad85d4cb had never been cited
    // by anyone else on the card. Before this fix, QA's own comment became ad85d4cb's first-ever
    // introduction, pulling the round boundary to QA's own timestamp and making Cybersec's
    // genuinely fresh GO (94s earlier, for the very same round) read as stale/pre-round. The real
    // card had to be force:true-closed by MikroB.
    it('POSITIVE: two gates cite the same merge-sha, the second also cites the work-commit ("both commits" idiom) -> both stay fresh', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: 7132429b', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 7132429b', created_at: 200 },
        // QA's own verdict restates the merge sha AND adds the work-commit via the "both commits"
        // idiom -- ad85d4cb is cited here for the first time on the whole card, and ONLY by a gate.
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 7132429b, ad85d4cb', created_at: 210 },
      ]
      // Before the fix: ad85d4cb's first mention (t=210, QA's own comment) became the round
      // boundary, and Cybersec's t=200 GO -- for the SAME round -- read as stale ("missing").
      // After the fix: a gate-only citation cannot open a round, so the boundary stays at
      // 7132429b's real introduction (t=100, backend2's REVIEW), and both verdicts are fresh.
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('NEGATIVE CONTROL: a builder REVIEW with a genuinely new sha AFTER both old verdicts still makes them stale (round-4 correction must not regress)', () => {
      // Same shape as the existing round-4 tests above (aaaaaaa1/bbbbbbb2): this is not a new
      // mechanism, just confirming the gate-author exclusion in pass 1 did not accidentally weaken
      // the existing "a real new round still invalidates old verdicts" behaviour.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa1', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaaaaaa1', created_at: 110 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: aaaaaaa1', created_at: 120 },
        // A REAL new round from a non-gate author.
        { author: 'backend2', content: 'REVIEW -- kesz, uj commit\nGate-SHA: bbbbbbb2', created_at: 200 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      // Neither gate has verdicted bbbbbbb2 yet -- both old verdicts (for aaaaaaa1) are stale.
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
      expect(v.message).toContain('Cybersec')
    })

    it('a GATE citation can still WIDEN an already-introduced entry to a longer/shorter prefix, without opening a new one', () => {
      // Pass 2 lets a gate's own citation merge with an existing entry by prefix-containment (same
      // short-vs-full-format grouping d4a2130d already covers) -- it just cannot CREATE one. Here
      // Cybersec cites the full 40-char form of the SAME commit backend2 introduced as a short sha;
      // this must still be recognised as the same round, not two separate entries.
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: 7132429b', created_at: 100 },
        {
          author: 'cybersec',
          content: 'CYBERSEC GO\nGate-SHA: 7132429b0000000000000000000000000000ab',
          created_at: 200,
        },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 7132429b', created_at: 210 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })
  })

  // Card e20066df (WhiteHat2 F1, non-blocking finding on 9ce3181c's own CYBERSEC GO): the round
  // boundary used `currentRoundStartTs(...) ?? latestReviewAt(...)` -- latestReviewAt was ONLY ever
  // consulted when currentRoundStartTs returned null. A SECOND builder hand-off that forgets the
  // (optional) Gate-SHA line introduces no new sha for currentRoundStartTs to anchor on, so the
  // boundary stayed stuck at the FIRST round's sha and an old verdict from before the second
  // hand-off kept reading as fresh. Fix: the boundary is the LATER of the two signals.
  describe('F1 (card e20066df): a second hand-off with no Gate-SHA line must still move the boundary past an old verdict', () => {
    it('reproduces the finding: QA PASS predates a later Gate-SHA-less REVIEW asking for a re-check -- must go stale', () => {
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaa111', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaa111', created_at: 150 },
        // Non-compliant with CLAUDE.md 4b (no Gate-SHA line) but real: a second hand-off asking for
        // another look. currentRoundStartTs alone never moves (no new sha cited) -- before the fix
        // this left sinceTs stuck at t=100, and QA's t=150 PASS kept reading as fresh forever.
        { author: 'backend2', content: 'REVIEW -- meg egy apro fix, nezzetek at ujra', created_at: 200 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
    })

    it('CONTROL: a fresh QA PASS AFTER the Gate-SHA-less second hand-off still satisfies the requirement', () => {
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaa111', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaa111', created_at: 150 },
        { author: 'backend2', content: 'REVIEW -- meg egy apro fix, nezzetek at ujra', created_at: 200 },
        { author: 'qa', content: 'REVIEW: QA PASS @ ujranezve', created_at: 250 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })
  })

  // Card e20066df (WhiteHat2 F2, non-blocking): GATE_AGENT_NAMES must list EVERY gate-role author,
  // not just the canonical qa/cybersec/cybered spellings -- the ROUND-5 protection ("a gate's own
  // Gate-SHA citation must not open a new round", tested above for qa/cybersec) is keyed entirely
  // off this set. Dropping qa2, cybersec2 or cybered from it individually left the suite green
  // because no existing test exercised THOSE three specific authors in the gate-only-citer role.
  describe('F2 (card e20066df): GATE_AGENT_NAMES completeness -- qa2/cybersec2/cybered must each individually trip the gate-only-citer protection', () => {
    it('qa2 citing a sha ALONE (no non-gate confirmation) must not open/confirm a round', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: 7132429b', created_at: 100 },
        { author: 'cybersec', content: 'CYBERSEC GO\nGate-SHA: 7132429b', created_at: 200 },
        // qa2's own verdict restates the round sha AND introduces a second one nobody else ever
        // cites -- if 'qa2' were missing from GATE_AGENT_NAMES, this citation would be treated as
        // non-gate and wrongly open a new round at t=210.
        { author: 'qa2', content: 'QA2 PASS\nGate-SHA: 7132429b, ad85d4cb', created_at: 210 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('cybersec2 citing a sha ALONE (no non-gate confirmation) must not open/confirm a round', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: 7132429b', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 7132429b', created_at: 200 },
        { author: 'cybersec2', content: 'CYBERSEC2 GO\nGate-SHA: 7132429b, ad85d4cb', created_at: 210 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('cybered citing a sha ALONE (no non-gate confirmation) must not open/confirm a round', () => {
      card.description = 'Gate: QA + Cybered'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: 7132429b', created_at: 100 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: 7132429b', created_at: 200 },
        { author: 'cybered', content: 'CYBERED GO\nGate-SHA: 7132429b, ad85d4cb', created_at: 210 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })
  })

  // Card e20066df (WhiteHat2 F3, non-blocking): an entry FIRST introduced by a gate-only citation
  // must still become confirmed once a LATER, non-gate comment restates the same (or a prefix-
  // matching) sha -- the "widening" step (`if (isNonGate) entries[idx].nonGateConfirmed = true` on
  // an existing entry, not just at creation). Dropping just that widening step left the suite green
  // because no existing test built an entry gate-first-then-non-gate-confirmed while ALSO having an
  // older, genuinely-stale verdict for the suite to wrongly un-stale.
  describe('F3 (card e20066df): an entry opened by a gate-only citation must still confirm once a non-gate comment later restates it', () => {
    it('a stale QA PASS from an earlier round must not be rescued by losing the later round\'s confirmation', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        // Round 1 (old, fully confirmed): establishes a floor entry so sinceTs is never null.
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa9', created_at: 10 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaaaaaa9', created_at: 50 },
        // Round 2 (the real current round): cybersec cites the NEW sha FIRST, alone (gate-only,
        // unconfirmed at creation) -- then backend2 (non-gate) restates the SAME sha later. Without
        // the widening step, this entry never becomes confirmed, so it is dropped from the Math.max
        // entirely and the boundary falls back to round 1's older t=10, wrongly un-staling QA's PASS.
        { author: 'cybersec', content: 'CYBERSEC GO (korai nezes)\nGate-SHA: ccccccc9', created_at: 100 },
        { author: 'backend2', content: 'meg egyszer megneztem, uj build\nGate-SHA: ccccccc9', created_at: 150 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      // QA's t=50 PASS belongs to round 1 and must read as stale once round 2 (t=100, confirmed by
      // the t=150 widening) exists -- Cybersec's t=100 GO is fresh for round 2, QA's is not.
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
    })

    it('CONTROL: the same shape, but QA ALSO verdicts after round 2 starts -> correctly unblocked', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa9', created_at: 10 },
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaaaaaa9', created_at: 50 },
        { author: 'cybersec', content: 'CYBERSEC GO (korai nezes)\nGate-SHA: ccccccc9', created_at: 100 },
        { author: 'backend2', content: 'meg egyszer megneztem, uj build\nGate-SHA: ccccccc9', created_at: 150 },
        { author: 'qa', content: 'REVIEW: QA PASS @ ujranezve\nGate-SHA: ccccccc9', created_at: 200 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })
  })

  // Card 1e763f16 (RedHat follow-up F0/F1/F3a on e87eef21 comment 21526): the SAME fixture file
  // (store/gate-verdict-corpus.json) is loaded by store/gate-closure-check.selftest.py's own corpus
  // block, so a change to either tool's recognizer that disagrees with the other shows up as a
  // failure there AND here instead of the two drifting apart silently again. The comparison
  // normalises TS's sibling-numbered agent ('qa2'/'cybersec2') down to its gate FAMILY, because
  // Python's canonical_gate() deliberately discards the sibling digit (card 1e763f16 investigation:
  // "group(2) is the sibling number and is deliberately discarded") -- the two tools agree on gate
  // FAMILY + outcome, not on which specific sibling posted.
  describe('shared verdict corpus (card 1e763f16): anchoredGateVerdict agrees with gate-closure-check.py\'s verdict_of', () => {
    const corpusPath = new URL('../../store/gate-verdict-corpus.json', import.meta.url)
    const corpus: Array<{ id: string; content: string; expected: { gate: string; outcome: string } | null }> =
      JSON.parse(readFileSync(corpusPath, 'utf-8'))
    const toFamily = (agent: string) => agent.replace(/2$/, '').toUpperCase()

    for (const c of corpus) {
      it(`corpus: ${c.id}`, () => {
        const got = anchoredGateVerdict(c.content)
        if (c.expected === null) {
          expect(got).toBeNull()
        } else {
          expect(got).not.toBeNull()
          expect(toFamily(got!.agent)).toBe(c.expected.gate)
          expect(got!.outcome).toBe(c.expected.outcome)
        }
      })
    }
  })

  // F1 HIGH ReDoS regression (card 1e763f16, WhiteHat comment 21917): a gate-role name followed by
  // a long run of plain spaces with NO verdict character after it must resolve in well under a
  // second, not seconds-to-minutes. The pre-fix ANCHORED_VERDICT_RX (three `\s*` groups separated
  // only by optional elements) measured 5181ms on a 3003-byte comment of this shape on the real
  // guard; this fixture is 5000 bytes, i.e. in the range that was already catastrophic pre-fix.
  // `expect(...).toBeNull()` alone would not catch a slow-but-eventually-correct regex -- the
  // actual defect under test is WALL-CLOCK TIME, so the assertion is on the duration, with the
  // match outcome checked too so a future change that breaks correctness instead of speed still
  // fails here.
  it('F1 ReDoS regression: a gate name + 5000 spaces + no verdict resolves in well under 1s, not seconds', () => {
    const redosFixture = `QA${' '.repeat(5000)}x`
    const start = Date.now()
    const result = anchoredGateVerdict(redosFixture)
    const elapsedMs = Date.now() - start
    expect(result).toBeNull()
    expect(elapsedMs).toBeLessThan(500)
  })

  // F1 (RedHat, 4 live cases: comments 8753/17906/17941/6821): the production wiring -- a gate
  // reversing its own PASS/GO with a FAIL/NO-GO comment that NAMES the word it withdraws must read
  // as missing, not as a fresh positive. The corpus block above pins the recognizer itself; this
  // pins gateCompletenessGuardVerdict's end-to-end behaviour on the exact same shape.
  describe('F1 (card 1e763f16): a retracting FAIL/NO-GO that names the verdict it withdraws stays negative', () => {
    it('QA FAIL (visszavonom a korabbi PASS-omat) -- blocks, not satisfied by the quoted PASS word', () => {
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
        { author: 'qa', content: 'QA PASS', created_at: 150 },
        { author: 'qa', content: 'QA FAIL (visszavonom a korabbi PASS-omat)', created_at: 200 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('QA')
    })

    // Mutation control (karpathy-guidelines, goal-driven execution): take out the anchoring (go
    // back to matching PASS/SKIP/GO anywhere on the first line) and this same case must turn RED,
    // proving the test actually exercises the fix and is not a no-op.
    it('MUTATION CONTROL: the old anywhere-on-the-line check would have read this as a fresh PASS', () => {
      const OLD_VERDICT_RX = /\bPASS\b|\bSKIP\b|(?<!NO[- ])\bGO\b/i
      const retracting = 'QA FAIL (visszavonom a korabbi PASS-omat)'
      expect(OLD_VERDICT_RX.test(retracting)).toBe(true) // the bug this card fixes
      expect(anchoredGateVerdict(retracting)?.outcome).toBe('FAIL') // the fix
    })
  })

  // F2 (RedHat, latent on the live board): the LATEST verdict from a gate wins, not "any positive
  // anywhere in the round". A GO followed by a later NO-GO from the SAME gate must read as missing.
  describe('F2 (card 1e763f16): the LATEST comment-only verdict from a gate wins, not any earlier positive', () => {
    it('CYBERED GO then a later CYBERED NO-GO (same gate, same round) blocks -- the NO-GO wins', () => {
      card.description = 'Gate: QA + Cybered'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
        { author: 'qa', content: 'QA PASS', created_at: 150 },
        { author: 'cybered', content: 'CYBERED GO', created_at: 200 },
        { author: 'cybered', content: 'CYBERED NO-GO -- ujra megneztem, egy HIGH nyitva', created_at: 300 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
      expect(v.message).toContain('Cybered')
    })

    it('CONTROL: the order reversed (NO-GO then a later GO) is correctly unblocked', () => {
      card.description = 'Gate: QA + Cybered'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz', created_at: 100 },
        { author: 'qa', content: 'QA PASS', created_at: 150 },
        { author: 'cybered', content: 'CYBERED NO-GO -- egy HIGH nyitva', created_at: 200 },
        { author: 'cybered', content: 'CYBERED GO -- javitva, ujra megneztem', created_at: 300 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })
  })

  // F3a (RedHat, 2 live cases: comments 8478/8481): a Gate-SHA line BEFORE the verdict line is a
  // legitimate order (CLAUDE.md 4b allows either), so it must not read as missing.
  describe('F3a (card 1e763f16): a Gate-SHA-first comment still carries its verdict', () => {
    it('Gate-SHA then CYBERED GO on the next line is recognised, not missing', () => {
      card.description = 'Gate: Cybered'
      comments = [
        { author: 'backend2', content: 'REVIEW -- kesz\nGate-SHA: 8675bd80842d00e725e7c701ce9d9a47e76e7fa5', created_at: 100 },
        { author: 'cybered', content: 'Gate-SHA: 8675bd80842d00e725e7c701ce9d9a47e76e7fa5\nCYBERED GO', created_at: 200 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })
  })

  // SKIP (TS-only convention, not shared with the Python tool -- see this card's REVIEW: the
  // Python _VERDICT regex never included the SKIP word at all, a separate, non-blocking gap flagged
  // as a follow-up rather than fixed here, since it touches gate-closure-check.py's wider PASSING/
  // content_verdict logic beyond this card's named findings).
  describe('anchoredGateVerdict recognises SKIP (CLAUDE.md: PASS/GO/SKIP, TS-only convention)', () => {
    it('CYBERED SKIP: ... is a recognised positive verdict', () => {
      expect(anchoredGateVerdict('CYBERED SKIP: nem az en hataskorom')).toEqual({ agent: 'cybered', outcome: 'SKIP' })
    })
  })

  // F-N3 KNOWN GAP (MikroB decision, card c188f357, comment 21553/13555, option A: documented
  // boundary + this pin test, no code change -- option B, widening agent-key issuance so comment
  // authorship can also be authenticated, is deferred to card 2e10de7c, blocked on it). This test
  // is deliberately NOT a regression test for a bug this file introduced: it pins the EXISTING,
  // by-design forgeability of the comment-parse path (see the top-of-file doc comment this card
  // added), so a future change that silently narrows or widens it is visible in a diff instead of
  // going unnoticed.
  describe('F-N3 KNOWN GAP: the comment-author field is unauthenticated under the shared dashboard token', () => {
    it('a comment merely CLAIMING to be "qa" with a PASS-shaped first line satisfies the QA requirement -- no device-key or structured verdict ever existed', () => {
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa9', created_at: 10 },
        // Nothing here authenticates this author as the real qa agent -- it is a plain string
        // column any caller with the shared dashboard token can set on POST /comments.
        { author: 'qa', content: 'REVIEW: QA PASS\nGate-SHA: aaaaaaa9', created_at: 20 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })

    it('CONTROL: the SAME shape with NO comment at all (missing, not forged) is correctly BLOCKED -- the gap is forgeability, not a guard that never checks', () => {
      card.description = 'Gate: QA'
      comments = [
        { author: 'backend', content: 'REVIEW -- kesz\nGate-SHA: aaaaaaa9', created_at: 10 },
      ]
      const v = gateCompletenessGuardVerdict('c1', 'done', false)
      expect(v.blocked).toBe(true)
    })
  })

  // Card 6b87df14 (incident on card d87adb90, 2026-09-26 08:5x): REVIEW -> QA PASS, both citing the
  // FULL 40-char Gate-SHA `548b5c73885007b2b5b55edc1456f220605feca6` -> Cybersec cites a TYPO'd sha
  // (`548b5c7300000000`, diverges from the real one at the 9th hex char -- NOT a prefix of it) in a
  // Gate-SHA line that also carries a parenthetical naming the card id and another commit
  // (`(a landolt d87adb90 delta: commit fe24f790)`) -> Cybersec GO citing the correct full sha. The
  // live `PUT status:done` was rejected with "QA verdiktjét is megköveteli", even though QA had
  // already PASSed for the same round -- MikroB had to force:true past it.
  //
  // CORRECTED after Cybersec NO-GO (komment 23348, Gate-SHA 1eb4c4b35): the first version of this
  // test used SHORTENED 8-char shas (`548b5c73` / `548b5c7300000000`), which made the typo'd sha a
  // false PREFIX of the real one (`548b5c73...` startsWith `548b5c73`) -- a shape the real incident
  // never had, since every real comment cited the full 40-char form. Replayed against the real
  // d87adb90 comment history (37 comments, API-verified by Cybersec), the shortened-sha test stayed
  // GREEN on the incident-era guard (commit 769a3183f) -- it did not reproduce the incident at all.
  // The REAL root cause, measured by replaying the real comments with each protection disabled in
  // turn: disabling ONLY the gate-only-citer drop (card 9ce3181c round-5) reproduces the incident
  // (blocked=true); disabling ONLY the short-vs-full prefix-containment merge (card 85c87024) does
  // NOT (stays blocked=false) -- the prior claim that "two independent protections" both matter was
  // wrong. The REAL mechanism: the typo'd-sha comment's Gate-SHA line also contains two more
  // hex-shaped tokens (the card id `d87adb90` and the commit `fe24f790`), which the hex-token
  // extraction (see extractGateShas) also reads as cited shas introduced at that same (late)
  // timestamp; since only Cybersec ever cites any of these three, the gate-only-citer drop removes
  // them from the round-start computation entirely -- without that drop, their late introduction
  // timestamp would push the round boundary past QA's earlier PASS, hiding it as stale.
  describe('card 6b87df14: a typo-extended Gate-SHA citation from one gate must not hide that gate\'s own fresh verdict', () => {
    const REAL_SHA = '548b5c73885007b2b5b55edc1456f220605feca6'
    const TYPO_SHA = '548b5c7300000000' // diverges from REAL_SHA at the 9th hex char -- not a prefix

    it('QA PASS stays fresh even though Cybersec cited a typo-extended sha (with a card-id/commit parenthetical) before its own correct one', () => {
      card.description = 'Gate: QA + Cybersec'
      comments = [
        { author: 'backend', content: `REVIEW: kesz\nGate-SHA: ${REAL_SHA}`, created_at: 100 },
        { author: 'qa', content: `QA PASS\nGate-SHA: ${REAL_SHA}`, created_at: 200 },
        {
          author: 'cybersec',
          content: `CYBERSEC GO\nGate-SHA: ${TYPO_SHA}  (a landolt d87adb90 delta: commit fe24f790)`,
          created_at: 300,
        },
        { author: 'cybersec', content: `CYBERSEC GO\nGate-SHA: ${REAL_SHA}`, created_at: 310 },
      ]
      expect(gateCompletenessGuardVerdict('c1', 'done', false).blocked).toBe(false)
    })
  })

})
