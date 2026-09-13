// Card 504ec76f: the Draft-Review vocabulary lives in FOUR places, and they move together or not at
// all.
//
// WHY THIS EXISTS. Adding the fourth value (`FELESLEGES`) meant touching the regex, the 409 message
// the guard hands back, the skill agents read (seed AND installed), and the boilerplate the
// dispatcher writes into every draft comment. The card said as much: "mind a négyet együtt kell
// mozgatni, különben a guard és a dokumentáció elcsúszik". Nothing enforced that. The failure is
// quiet and one-directional: the regex is what ACCEPTS, so a value present in the regex but missing
// from the docs is a value nobody is told about, and a value in the docs but not the regex is an
// agent following instructions into a 409. Neither breaks a test today.
//
// DERIVED FROM THE REGEX, never a hand-written list -- a second hand-written list is the thing this
// test exists to prevent.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DRAFT_REVIEW_RX } from '../web/kanban-draft-review-guard.js'

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUARD = join(ROOT, 'src', 'web', 'kanban-draft-review-guard.ts')
const SEED_SKILL = join(ROOT, 'seed-skills', 'local-llm-offload', 'SKILL.md')
const DISPATCH = join(ROOT, 'store', 'offload-dispatch.sh')

/**
 * The verdict words the regex accepts, taken from its own source. Accent variants collapse
 * (`ELUTAS[IÍ]TVA` -> the ASCII spelling), because the docs quote one spelling and the regex accepts
 * both on purpose -- requiring the accented form in prose would be a false failure.
 */
function verdictsFromRegex(): string[] {
  const group = /\(([A-ZÁÉÍÓÖŐÚÜŰ[\]|]+)\)/.exec(DRAFT_REVIEW_RX.source)
  if (!group?.[1]) return []
  return group[1]
    .split('|')
    .map((w) => w.replace(/\[([A-ZÁÉÍÓÖŐÚÜŰ])[A-ZÁÉÍÓÖŐÚÜŰ]*\]/g, '$1'))
    .filter((w) => /^[A-Z]+$/.test(w))
}

/** The Hungarian primaries -- the ones every surface spells out. The English aliases are documented
 *  in the skill as aliases and deliberately not repeated in every message. */
const HU = new Set(['ELFOGADVA', 'ELUTASITVA', 'RESZBEN', 'FELESLEGES'])

describe('the Draft-Review vocabulary is the same in all four places (card 504ec76f)', () => {
  const all = verdictsFromRegex()
  const hu = all.filter((v) => HU.has(v))

  it('the extraction works, so the assertions below are not over an empty list', () => {
    // Without this the whole file passes the day the regex shape changes and the parse returns [].
    expect(all.length, `parsed nothing out of ${DRAFT_REVIEW_RX.source}`).toBeGreaterThanOrEqual(8)
    expect(hu.sort()).toEqual(['ELFOGADVA', 'ELUTASITVA', 'FELESLEGES', 'RESZBEN'])
    // ...and the English aliases are really there, so `HU` is a deliberate subset, not a typo that
    // silently narrowed the check to nothing.
    expect(all).toEqual(expect.arrayContaining(['ACCEPTED', 'REJECTED', 'PARTIAL', 'REDUNDANT']))
  })

  it.each([
    ['the 409 message the guard returns', GUARD],
    ['the skill agents read (seed)', SEED_SKILL],
    ["the dispatcher's draft boilerplate", DISPATCH],
  ])('%s names every accepted verdict', (_label, file) => {
    const src = readFileSync(file, 'utf8')
    for (const v of hu) {
      expect(src, `${v} is accepted by the guard but never mentioned in ${file}`).toContain(v)
    }
  })

  it("the dispatcher's OWNER NOTICE names them too, not just the comment boilerplate", () => {
    // Two separate strings in that file, and the notice is the one an agent reads FIRST.
    const notice = readFileSync(DISPATCH, 'utf8')
      .split('\n')
      .find((l) => l.includes('Draft erkezett a'))
    expect(notice, 'the draft-arrived notice is gone or renamed').toBeDefined()
    for (const v of hu) expect(notice ?? '', v).toContain(v)
  })
})
