import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// GATEKOTOJEL817 + GATEHYPH816: two false positives in five minutes, in a live
// owner conversation, both the same class -- the gate could not tell PROSE
// from IDENTIFIER. (1) `Drive-ot`: a Hungarian suffix attaches to a foreign
// proper noun WITH a hyphen (that is the correct spelling); the letters-only
// tokenizer cut at the hyphen and read the `ot` remainder as a standalone
// Hungarian word (ot -> öt). (2) `Video atalakitas`: a Drive FOLDER NAME
// quoted in prose -- a mid-sentence capitalized word is an identifier, not
// prose. The fix is TOKENIZATION, not the dictionary (a word exception list
// would also pass real errors): hyphenated forms are checked as the WHOLE
// token, and mid-sentence capitalized words are skipped -- while sentence-
// start capitals and lowercase prose remain fully checked.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')

function auditAccent(text: string): string[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
print(json.dumps([p for p in g.audit(sys.argv[1]) if "HIANYZO" in p]))
`, text], { encoding: 'utf-8' })
  return JSON.parse(out.trim())
}

describe('outgoing-copy gate tokenization: prose vs identifier (GATEKOTOJEL817/GATEHYPH816)', () => {
  it('a hyphen-suffixed foreign proper noun passes: the suffix fragment is not a standalone word', () => {
    // Marveen's real blocked sentence, correctly accented -- must go through.
    expect(auditAccent('Ha a Drive-ot választod, elég a mappába dobni, és köszönöm, hogy már átküldted.')).toEqual([])
  })

  it('a quoted identifier (mid-sentence capitalized folder name) passes', () => {
    // Cybersec round 8 (2026-08-26, fbb36b41 gate): "video" was removed from
    // IDENTIFIER_ALLOWLIST because it also lives in ACCENTLESS (a word cannot
    // be both "always needs correcting" and "always skip as an identifier") --
    // see the module-load assert. "drive" has no such conflict and remains.
    expect(auditAccent('A mappa neve Drive biztonsági mentés, ott találod, hogy már ne kelljen külön keresni.')).toEqual([])
  })

  it('REGRESSION (Cybersec, 2026-08-26, fbb36b41 gate, round 8): "Video" mid-sentence capitalized is no longer exempt -- it collided with the ACCENTLESS dictionary entry', () => {
    // The original GATEKOTOJEL817 "Video atalakitas" false positive is a KNOWN,
    // ACCEPTED regression: an identifier reference to a real folder literally
    // named "Video ..." now needs quoting/hyphenation by the human to pass --
    // deliberately, because the alternative silently swallowed real errors.
    const probs = auditAccent('Szia, a Video nagyon jól sikerült, köszönöm, hogy átküldted.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('video -> videó')
  })

  it('lowercase prose "video" still fails -- the fix must not widen into a whitelist', () => {
    const probs = auditAccent('Szia, a video nagyon jól sikerült, köszönöm, hogy átküldted.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('video -> videó')
  })

  it('a sentence-START capitalized word is prose and still fails (the skip-rule must not over-reach)', () => {
    const probs = auditAccent('Köszönöm, hogy megnézted. Video lett a vége, már csak fel kell tölteni.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('video -> videó')
  })

  it('a standalone accentless word that ALSO exists as a suffix still fails (ot -> öt)', () => {
    const probs = auditAccent('Kérlek, küldj át ot darabot, hogy már ne kelljen várni.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('ot -> öt')
  })

  it('the finding names its context: 3 words each side plus the character position (no more grepping mid-conversation)', () => {
    const probs = auditAccent('Szia, a video nagyon jól sikerült, köszönöm, hogy átküldted.')
    // Neighbours on both sides and an @<pos> marker.
    expect(probs[0]).toMatch(/"\.\.\.[^"]*a video nagyon[^"]*\.\.\." @\d+/)
  })

  it('REGRESSION (Cybersec, 2026-08-26, fbb36b41 gate): mid-sentence capitalized ORDINARY Hungarian words are NOT identifiers and must still fail', () => {
    // The skip-rule must be scoped to IDENTIFIER_ALLOWLIST, not "any capitalized
    // mid-sentence word" -- live reproduced bypass: this used to return [].
    // "Uzenet" is not itself an ACCENTLESS-dictionary entry, so only the two
    // dictionary hits (keszen, kerdes) are expected to surface.
    const probs = auditAccent('Sziasztok, a Keszen allo Uzenet mar elment, minden Kerdes megoldva.')
    expect(probs.length).toBe(1)
    expect(probs.some((p) => p.includes('keszen -> készen'))).toBe(true)
    expect(probs.some((p) => p.includes('kerdes -> kérdés'))).toBe(true)
  })
})
