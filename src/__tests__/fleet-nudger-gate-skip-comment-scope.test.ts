// Card 4469f177 (real card ea51e22a): QA2 found a card genuinely in its gate scope but blocked on
// something external, and deliberately wrote NO skip comment "so as not to re-arm the round" --
// following advice that only applies to the ADVISE-SKIP:not-designated case, where designation
// comes from the card's own labels/description and stays stable without a comment. The gate round's
// no-change fingerprint (_fp) is ONE SHARED hash over every candidate card, not per-card, so ANY
// OTHER waiting card changing still re-arms the whole round regardless of this one. Once re-armed,
// gate-dispatch-check.sh re-decides the untouched card fresh, finds zero comments from the agent,
// and answers ALLOW:no-verdict again -- forever, since nothing about the card itself changes. A
// comment is the only thing that makes a verdict durable across a re-arm it did not cause (it makes
// `mine` non-empty, so the next re-check answers ADVISE-SKIP:already-gated instead). Measured: 5
// identical SELF-ADVANCE nudges in a row for the same untouched card.
//
// Asserted against the script text: NUDGE_GATE is a dispatched message, not a function with a
// return value to call.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'fleet-nudger.sh')

function problems(text: string): string[] {
  const found: string[] = []
  if (!text.includes('NUDGE_GATE')) return ['this test is looking at the wrong file']

  // The "do not comment" exception must stay adjacent to the SPECIFIC case it is valid for.
  if (!/ADVISE-SKIP:not-designated[^"]*NE irj rola skip-kommentet/.test(text)) {
    found.push('the not-designated skip-comment exception is missing or not scoped to that case')
  }
  // The general rule -- write one for every OTHER reason -- must exist, or the scoped exception
  // above reads as blanket "never comment" again the moment someone re-derives it from the first
  // half alone. This exact omission is the measured incident.
  if (!/MINDEN MAS okbol[\s\S]{0,150}IRJ/.test(text)) {
    found.push('no general "write a skip comment for every other reason" instruction')
  }
  return found
}

describe('fleet-nudger scopes the no-skip-comment advice to not-designated only (card 4469f177)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('the exception is scoped, and a general write-one-otherwise rule exists', () => {
    expect(problems(text)).toEqual([])
  })

  it('CONTROL: the pre-fix blanket wording (exception with no general rule) is rejected', () => {
    // The mutation is the actual pre-fix shape: the general "MINDEN MAS okbol...IRJ" clause simply
    // was not there, so the not-designated exception read as unconditional advice.
    const preFix = text.replace(/ MINDEN MAS okbol[\s\S]*?5x azonos nudge\)\./, '.')
    expect(preFix, 'the mutation did not apply -- the clause was not found').not.toBe(text)
    expect(preFix).not.toMatch(/MINDEN MAS okbol/)
    expect(problems(preFix)).toContain('no general "write a skip comment for every other reason" instruction')
  })

  it('CONTROL: an unscoped exception (applies to everything) is also rejected', () => {
    // If the not-designated anchor disappeared -- e.g. someone later broadens the sentence to cover
    // every ADVISE-SKIP case -- the proximity check must catch that too, not just total absence.
    const unscoped = text.replace('ADVISE-SKIP:not-designated -> NEM a te hataskorod, hagyd ki, NE irj', 'ADVISE-SKIP -> hagyd ki, NE irj')
    expect(unscoped, 'the mutation did not apply').not.toBe(text)
    expect(problems(unscoped)).toContain('the not-designated skip-comment exception is missing or not scoped to that case')
  })
})
