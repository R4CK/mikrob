// The bundled catalogue's ORDER is a decision, and it has to survive the next person (card 3f6087f4).
//
// WHY ORDER IS A DECISION AT ALL. store/first-run-llm.sh prints `d["models"][:5]` numbered 1..5 and
// the operator picks by number; llm-catalog.py's `retier()` recomputes fit for the reading host and
// drops what cannot run, but it never re-sorts. So on a machine with no network, position 1 in this
// file is what gets installed.
//
// WHAT WENT WRONG. The file is an OUTPUT of the live path, which sorts by
// `(tier != 'fits', not trusted, -downloads)` -- quantisation is not in that key. Q2_K led the list
// with 175821 downloads while Q4_0 of the same repo also fits a 6 GB card, which contradicts the
// rule the card itself stated: the better quantisation wins over the more popular one (Cybered on
// the e35bc379 GO).
//
// So this test pins the RULE, not the current contents: within one repo, quality must not increase
// as you go down the list. A regenerated catalogue re-sorted by downloads fails here loudly instead
// of quietly shipping a weak coder as the default choice.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CATALOGUE = join(ROOT, 'store', 'llm-catalog-bundled.json')

interface Entry {
  id: string
  repo: string
  quant: string
  fileMib: number
  requiredMib: number
  parts: { path: string; sizeMib: number; sha256?: string | null }[]
}
const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf-8')) as {
  schemaVersion: number
  models: Entry[]
  warnings: string[]
}

/** Ascending quality. Only the families this catalogue actually ships need to be ranked; an unknown
 *  quant is a deliberate failure rather than a silent 0, because ranking it wrong would let the very
 *  regression this file guards pass. */
const QUALITY = ['Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q4_0', 'Q4_K_S', 'Q4_K_M', 'Q5_0', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'FP16']
const rank = (quant: string): number => {
  const i = QUALITY.indexOf(quant.toUpperCase())
  if (i < 0) throw new Error(`unranked quant '${quant}' -- add it to QUALITY rather than letting it sort as 0`)
  return i
}

describe('bundled catalogue order (card 3f6087f4)', () => {
  it('within a repo, quality never IMPROVES further down the list', () => {
    // The whole rule in one assertion. Q4_0 above Q2_K is correct (better first); the reverse is the
    // defect, and it is what a download-ordered regeneration produces.
    const byRepo = new Map<string, Entry[]>()
    for (const m of catalogue.models) byRepo.set(m.repo, [...(byRepo.get(m.repo) ?? []), m])
    const inversions: string[] = []
    for (const [repo, entries] of byRepo) {
      for (let i = 1; i < entries.length; i++) {
        if (rank(entries[i]!.quant) > rank(entries[i - 1]!.quant)) {
          inversions.push(`${repo}: ${entries[i - 1]!.quant} listed above the better ${entries[i]!.quant}`)
        }
      }
    }
    expect(inversions, 'a weaker quant is offered before a better one from the same repo').toEqual([])
  })

  it('CONTROL: the rule can fail -- the same check on a reversed list reports the inversion', () => {
    // Without this, "no inversions" and "the loop never ran" look identical, which is the failure
    // mode this repo keeps finding in its own guards.
    const reversed = [...catalogue.models].reverse()
    const byRepo = new Map<string, Entry[]>()
    for (const m of reversed) byRepo.set(m.repo, [...(byRepo.get(m.repo) ?? []), m])
    let inversions = 0
    for (const entries of byRepo.values()) {
      for (let i = 1; i < entries.length; i++) if (rank(entries[i]!.quant) > rank(entries[i - 1]!.quant)) inversions++
    }
    expect(inversions).toBeGreaterThan(0)
  })

  it('the small-host rung is still there -- fixing the order must not drop coverage', () => {
    // Q2_K needs 4019 MiB and is the only entry a 4-5 GB card can run: the next rung up needs 5369.
    // "Use a better quant" must not turn into "offer nothing at all" on a small machine, which is
    // what deleting it instead of demoting it would have done.
    const smallest = [...catalogue.models].sort((a, b) => a.requiredMib - b.requiredMib)[0]!
    expect(smallest.requiredMib).toBeLessThan(4096)
  })

  it('every entry carries a per-part digest -- a hand-added entry must not lose it', () => {
    // The realistic way this file degrades is someone appending an entry by hand (as this card did)
    // without the sha256 the trust gate later checks.
    const missing = catalogue.models
      .flatMap((m) => m.parts.map((p) => ({ id: m.id, path: p.path, sha: p.sha256 })))
      .filter((p) => !p.sha || !/^[0-9a-f]{64}$/.test(p.sha))
    expect(missing, 'parts without a usable sha256').toEqual([])
  })

  it('requiredMib is above fileMib for every entry -- a copied entry with stale sizes shows up here', () => {
    const wrong = catalogue.models.filter((m) => !(m.requiredMib > m.fileMib))
    expect(wrong.map((m) => m.id)).toEqual([])
  })

  it('the file says out loud where its order comes from', () => {
    // WHAT THIS ASSERTION USED TO SAY, and why it changed: it required the file to warn that a
    // regeneration would UNDO the order, because the live sort was (fits, trusted, downloads) and
    // knew nothing about quantisation -- the order here was hand-held and one regeneration from
    // being lost. Card 51ad7c7c put the quant rank into that sort, so the warning became FALSE and
    // a file that warns about a thing that can no longer happen teaches the next reader wrong.
    // The assertion follows the fact rather than being deleted: the note must still explain the
    // order, and now names the sort that reproduces it.
    const notes = catalogue.warnings.join('\n')
    expect(notes).toContain('51ad7c7c')
    expect(notes).toMatch(/REGENERATION NOW REPRODUCES/i)
  })
})
