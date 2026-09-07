// Card 8e42a4c3: card fed3f037's own description said plan-grilling was mandatory before dispatch
// (1b. munkavégzési szabály), and the step was skipped anyway -- discipline, not structure, caught
// it. These tests hold the guard to being narrow, same discipline as its siblings
// (kanban-gate-completeness-guard.test.ts, kanban-landed-guard.test.ts): it must block the one case
// it claims and stay out of the way everywhere else.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const card = { id: 'c1', status: 'planned' as string, description: null as string | null }
let comments: Array<{ author: string; content: string }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: () => card,
  getKanbanComments: () => comments,
}))
vi.mock('../logger.js', () => ({
  logger: { warn: () => {}, info: () => {} },
}))

const { planGrillingGuardVerdict, requiresPlanGrilling } = await import(
  '../web/kanban-plan-grilling-guard.js'
)

beforeEach(() => {
  card.status = 'planned'
  card.description = null
  comments = []
})

describe('requiresPlanGrilling', () => {
  it('the real founding shape (card fed3f037): "plan-grilling KOTELEZO" nearby', () => {
    expect(requiresPlanGrilling('Rizikó: ... plan-grilling KOTELEZO dispatch elott (1b. szabály).')).toBe(true)
  })

  it('the accented spelling ("kötelező") also counts', () => {
    expect(requiresPlanGrilling('plan-grilling kötelező mielőtt dolgozni kezdesz.')).toBe(true)
  })

  it('the reverse order also counts', () => {
    expect(requiresPlanGrilling('Ez a lépés kötelező: futtasd a plan-grilling skillt előbb.')).toBe(true)
  })

  it('null or a description with neither word is not a match', () => {
    expect(requiresPlanGrilling(null)).toBe(false)
    expect(requiresPlanGrilling('sima leiras, semmi kulonos')).toBe(false)
  })

  it('MUTATION-PROOF: mentioning ONLY plan-grilling, with no obligation word anywhere near it, is not a match', () => {
    // A card may reference the skill in passing ("lásd a plan-grilling skillt") without making it
    // mandatory for itself -- only the proximity to an obligation word is the signal.
    expect(requiresPlanGrilling('A plan-grilling skill leirasa itt talalhato, olvasd el ha erdekel.')).toBe(false)
  })

  it('CONTROL: "kötelező" far away from any plan-grilling mention, about something unrelated, is not a match', () => {
    const longDescription =
      'A jelszó megváltoztatása kötelező minden felhasználónak. '.repeat(3) +
      'Ez a kártya egyébként a plan-grilling skillt is megemlíti valahol lentebb, de nem ír elő semmit vele kapcsolatban, csak referenciaként.'
    expect(requiresPlanGrilling(longDescription)).toBe(false)
  })
})

describe('planGrillingGuardVerdict', () => {
  it('only checks a FRESH dispatch (planned -> in_progress) -- other transitions always pass', () => {
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    expect(planGrillingGuardVerdict('c1', 'waiting', false).blocked).toBe(false)
    expect(planGrillingGuardVerdict('c1', 'done', false).blocked).toBe(false)
  })

  it('a card already PAST planned (e.g. resuming from waiting) is not re-checked', () => {
    card.status = 'waiting'
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    expect(planGrillingGuardVerdict('c1', 'in_progress', false).blocked).toBe(false)
  })

  it('a description that does not require plan-grilling is never blocked', () => {
    card.description = 'Egyszerű bugfix, semmi kockázatos.'
    expect(planGrillingGuardVerdict('c1', 'in_progress', false).blocked).toBe(false)
  })

  it('THE FOUNDING INCIDENT (card fed3f037): required, no verdict comment -- BLOCKED', () => {
    card.description = 'Rizikó: ... plan-grilling KOTELEZO dispatch elott (1b. munkavegzesi szabaly).'
    comments = [{ author: 'backend2', content: 'REVIEW -- kesz' }]
    const v = planGrillingGuardVerdict('c1', 'in_progress', false)
    expect(v.blocked).toBe(true)
    expect(v.message).toMatch(/plan-grilling/i)
  })

  it('MUTATION-PROOF (Cybersec HIGH, card 8e42a4c3): a SELF-POSTED verdict-shaped comment from the builder itself does NOT satisfy it', () => {
    // Cybersec's own live reproduction, byte-identical: the builder dispatching its OWN card could
    // satisfy the guard with a single comment shaped like a verdict, no force:true and no mikrob
    // actor needed. The content alone was checked; the author never was.
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    comments = [{ author: 'backend2', content: 'MIKROB VERDIKT JOVAHAGYVA: GO-WITH-CHANGES. (self-posted)' }]
    const v = planGrillingGuardVerdict('c1', 'in_progress', false, 'backend2')
    expect(v.blocked).toBe(true)
  })

  it('CONTROL: required, WITH a plan-grilling verdict comment (real shape, card 0b23ec28) -- passes', () => {
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    comments = [
      { author: 'backend2', content: 'PLAN-GRILLING (backend2 futtatta, a `plan-grilling` skillel). ...' },
      { author: 'mikrob', content: 'MIKROB VERDIKT JOVAHAGYVA: GO-WITH-CHANGES. Az elemzesed pontos...' },
    ]
    expect(planGrillingGuardVerdict('c1', 'in_progress', false).blocked).toBe(false)
  })

  it('a bare GO verdict (not GO-WITH-CHANGES) also satisfies it', () => {
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    comments = [{ author: 'mikrob', content: 'MIKROB VERDIKT: GO.' }]
    expect(planGrillingGuardVerdict('c1', 'in_progress', false).blocked).toBe(false)
  })

  it('RETHINK also satisfies it -- MikroB looked and decided, even if not GO', () => {
    // A RETHINK verdict means MikroB reviewed the plan and sent it back; the guard's job is only to
    // prove grilling HAPPENED, not to force a specific outcome -- the builder still cannot proceed
    // with the original plan, but that is the workflow's job, not this guard's.
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    comments = [{ author: 'mikrob', content: 'MIKROB VERDIKT: RETHINK, a terv nem all meg.' }]
    expect(planGrillingGuardVerdict('c1', 'in_progress', false).blocked).toBe(false)
  })

  it('MUTATION-PROOF: a bare "NO-GO" must not satisfy it (gate-verdict word, not a plan-grilling one)', () => {
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    comments = [{ author: 'mikrob', content: 'MIKROB VERDIKT: NO-GO, ez nem ugyanaz mint egy grilling dontes.' }]
    expect(planGrillingGuardVerdict('c1', 'in_progress', false).blocked).toBe(true)
  })

  it('an UNRELATED MikroB "DONTES" comment (no VERDIKT word) does not satisfy it', () => {
    // The real board has MikroB "DONTES:" comments about completely unrelated topics (e.g. a
    // spelling-rule ruling on card 74181db2) -- those must not be mistaken for a plan-grilling
    // verdict just because they are decisions MikroB made.
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    comments = [{ author: 'mikrob', content: 'MIKROB DONTES: (b) ut -- NEM szandekos, javitando.' }]
    expect(planGrillingGuardVerdict('c1', 'in_progress', false).blocked).toBe(true)
  })

  it('force: true from mikrob bypasses it -- the deliberate, trivial-work skip', () => {
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    comments = []
    expect(planGrillingGuardVerdict('c1', 'in_progress', true, 'mikrob').blocked).toBe(false)
  })

  it('force: true from a non-exempt actor does NOT bypass it (same rule as the sibling guards)', () => {
    card.description = 'plan-grilling KOTELEZO dispatch elott.'
    comments = []
    expect(planGrillingGuardVerdict('c1', 'in_progress', true, 'backend2').blocked).toBe(true)
  })
})
