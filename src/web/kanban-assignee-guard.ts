// Structural block for assignee="mikrob" (Peti, Telegram 10943, 2026-10-11): "A neveden miert van
// kartya? Neked kiosztani kell a feladatokat, nem megoldani." MikroB is the fleet orchestrator
// (root CLAUDE.md: "Kiosztas, beragadas-kezeles, vegso ellenorzes: MikroB") -- a card parked on its
// own name sits unworked, because MikroB does not self-advance on its own cards (rule 11 only
// self-advances role/lead agents), and it hides real load from the dispatch sweep. Measured
// 2026-10-11: 101 live cards carried assignee=mikrob (2 in_progress, 96 planned of which 94 marked
// BLOKKOLT, 3 waiting; 60 were phase/parent cards).
//
// Structural, not disciplinary (code-quality principle 6, root CLAUDE.md): the written rule in
// CLAUDE.md 6a already said every planned card needs a responsible agent, but nothing stopped a
// caller from writing "mikrob" into that field in the first place. This blocks it at the write
// boundary (create + update), the same shape as the other kanban-*-guard.ts files in this
// directory (kanban-landed-guard.ts, kanban-draft-review-guard.ts, ...).
//
// No allowlist, no force override: a card genuinely waiting on Peti keeps its EXECUTOR as assignee
// plus a BLOKKOLT-Peti marker, never mikrob -- there is no legitimate case for this value, so
// unlike the other guards here this one does not check isForceActor.
const FORBIDDEN_ASSIGNEE = 'mikrob'

export const FORBIDDEN_ASSIGNEE_MESSAGE =
  'assignee="mikrob" nem megengedett (Peti 10943, 2026-10-11): MikroB kioszt, nem tulajdonol ' +
  'kartyat. Adj felelos szerep-ugynokot (fazis -> lead agent, level -> szerep-ugynok terheles ' +
  'szerint, root CLAUDE.md 6a szabaly).'

export const INVALID_ASSIGNEE_TYPE_MESSAGE =
  'assignee csak szoveg (string) vagy ures (null/undefined) lehet, nem tomb/objektum/szam.'

// WhiteHat F3 (NO-GO komment 15784/10562) + RedHat NO-GO delta B2 (komment 15997, kartya
// e25a549a): a korabbi, hatarolt INVISIBLE_RE (6 kodpont) + Cirill/Gorog-only tablazat 21 tovabbi
// format/lathatatlan/hasonmas alakot (pl. "@mikrob", "mikrob.", LRM/RLM/RLO/FSI+PDI/CGJ/Mongolian
// VS/ALM/invisible-times/VS16/TAG/Hangul filler/braille blank/NUL, dotless i, kiskapitalis,
// gorog iota+kappa, armeny o, kombinalo pont, torok nagy I) hagyott at (merve: a guard fuggveny
// kozvetlen hivasa a Gate-SHA fajan, mind a 21 PASS volt). Javitas RedHat sajat javaslata szerint:
// az osszevetes alakja "csak betu/szam" -- NFKC, majd MINDEN nem betu/szam karakter (formazo
// \p{Cf}, jel \p{M}, elvalaszto \p{Z}, pontozas/szimbolum) eltavolitasa, kisbetus, es azzal
// egyenlo-e "mikrob". Ez a @/. formakat es az osszes formazo/lathatatlan karaktert EGYSZERRE
// viszi, kategoria szerint, nem kodpontonkent felsorolva -- jovobeli hasonlo karakter is elkapva
// marad.
//
// Card 80ab5067 delta (QA FAIL 28436 on 861e426ba): a hand-curated CONFUSABLES fold table (a
// ~25-entry Cirill/Gorog/Armeny/small-caps lista) ZART, es EZERT mindig egy lepessel a VALODI
// Unicode hasonmas-keszlet mogott jar -- QA Cirill п (U+043F) es д (U+0434) hasonmasokkal
// demonstralta: nincsenek a tablaban, igy betu-kategoriajukent eletben maradnak a letter/digit
// szures utan, es a sima string-egyenloseg nem egyezik a cel nevvel -- ELIGIBLE/NEM-FORBIDDEN
// lesz, holott egy ember szemenek ugyanaz a nev. A javitas NEM egy nagyobb tablazat: a
// CONFUSABLES tablazat TELJESEN megszunt. Helyette fail-closed szabaly: ha az NFKC + betu/szam-
// csak szures UTAN BARMILYEN nem-ASCII karakter marad, az identitas sosem bizonyithato "biztosan
// MAS, mint egy fenntartott nev hasonmasa" -- tehat EGYEZESKENT (forbidden/ineligible) kezelendo,
// FUGGETLENUL attol, melyik konkret irasrendszerbol jon. Nincs tobbe karakterenkenti tablazat,
// amit minden uj hasonmas-felfedezessel bovíteni kellene.
function lettersAndDigitsOnly(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, '')
}

const ASCII_ALNUM_ONLY_RE = /^[a-zA-Z0-9]*$/

/**
 * Card 80ab5067 delta (QA FAIL 28436): true when, after NFKC + letters/digits-only filtering,
 * `value` still carries a character outside plain ASCII a-zA-Z0-9. Every legitimate id this
 * fleet compares against (agent names, "mikrob", GATE_AGENT_NAMES/GENERATED_COMMENT_AUTHORS
 * members) is itself plain ASCII, so a survivor here can ONLY be a look-alike script, a
 * never-enumerated confusable, or an otherwise non-ASCII identity -- never a false alarm on a
 * real id. Callers treat `true` as "fail closed": never eligible, always a forbidden match,
 * without needing to know WHICH specific id it resembles.
 */
export function hasNonAsciiIdentityResidue(value: string): boolean {
  return !ASCII_ALNUM_ONLY_RE.test(lettersAndDigitsOnly(value.normalize('NFKC')))
}

/**
 * Card 80ab5067 (WhiteHat LOW on 4ecd75d0, Gate-SHA 45237719): the same NFKC + letters/digits-only
 * pipeline this file already uses for "does this name MikroB", exported so any OTHER
 * exact-identity-against-a-known-name comparison (e.g. import-anti-patterns.ts's author
 * eligibility check) gets the same whitespace resistance a bare `.toLowerCase()` deny-list
 * membership test lacks. ONLY meaningful when {@link hasNonAsciiIdentityResidue} is false --
 * callers must check that FIRST and treat `true` there as an unconditional match, never fall
 * through to comparing this function's result against anything. Compare BOTH sides through this
 * function -- normalizing only the input and matching it against un-normalized set members (e.g.
 * "local-llm") breaks on the hyphen this function also strips.
 */
export function normalizeIdentityForMatch(value: string): string {
  return lettersAndDigitsOnly(value.normalize('NFKC')).toLowerCase()
}

/**
 * True when `value` names MikroB -- any case/whitespace/punctuation variant, full-width form
 * (NFKC-folded), any formatting/invisible/combining character, or ANY surviving non-ASCII
 * character at all (fail-closed, card 80ab5067 delta: no confusables table to keep extending,
 * see {@link hasNonAsciiIdentityResidue}). A non-string value is never forbidden here -- see
 * isInvalidAssigneeShape for that check.
 */
export function isForbiddenAssignee(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (hasNonAsciiIdentityResidue(value)) return true
  return normalizeIdentityForMatch(value) === FORBIDDEN_ASSIGNEE
}

/**
 * True when `value` is present but not a string (WhiteHat F1, kartya e25a549a): a single-element
 * array like ["mikrob"] skips the plain `typeof value === 'string'` check entirely, and
 * better-sqlite3 silently unwraps a one-element array bind parameter to its scalar -- so the
 * array form reached the DB as the literal string "mikrob". assignee has no legitimate shape
 * other than string/null/undefined; anything else is rejected before it reaches the DB layer.
 */
export function isInvalidAssigneeShape(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'string'
}
