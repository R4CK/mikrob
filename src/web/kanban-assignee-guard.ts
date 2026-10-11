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
// az osszevetes alakja "csak betu/szam" -- NFKC, hasonmas-fold, majd MINDEN nem betu/szam karakter
// (formazo \p{Cf}, jel \p{M}, elvalaszto \p{Z}, pontozas/szimbolum) eltavolitasa, kisbetus, es
// azzal egyenlo-e "mikrob". Ez a @/. formakat es az osszes formazo/lathatatlan karaktert EGYSZERRE
// viszi, kategoria szerint, nem kodpontonkent felsorolva -- jovobeli hasonlo karakter is elkapva
// marad. A CONFUSABLES tablazat csak azokra a hasonmasokra kell, amik MAGUK betu-kategoriaba
// tartoznak (a kategoria-alapu szures ezeket nem tavolitja el onmagaban), plusz a Hangul filler
// (U+3164), ami Unicode szerint Lo (betu) kategoriaju, noha vizualisan ures.
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
  'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'к': 'k', 'м': 'm',
  'А': 'A', 'Е': 'E', 'О': 'O', 'Р': 'P', 'С': 'C',
  'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  'К': 'K', 'М': 'M',
  'ο': 'o', 'Ο': 'O', // Greek omicron
  'ι': 'i', 'κ': 'k', // Greek iota, kappa (RedHat delta B2)
  'ı': 'i', 'İ': 'I', // Turkish dotless/dotted i
  'ᴍ': 'm', 'ɪ': 'i', 'ᴋ': 'k', 'ʀ': 'r', 'ᴏ': 'o', 'ʙ': 'b', // small-caps lookalikes
  'օ': 'o', // Armenian o
  // Hangul filler, Lo category, visually blank, not caught by the letter/digit keep-filter below.
  // NFKC runs BEFORE this fold and rewrites U+3164 to U+1160 (Hangul Jungseong Filler) -- the key
  // has to be the POST-normalize codepoint, not the one a caller would type.
  'ᅠ': '',
}

function foldConfusables(s: string): string {
  let out = ''
  for (const ch of s) out += CONFUSABLES[ch] ?? ch
  return out
}

// Keep only letters and digits (Unicode-aware) after confusable folding -- this single filter
// drops every format/mark/separator/punctuation/symbol character category at once (\p{Cf}, \p{M},
// \p{Z}, and everything else outside \p{L}/\p{N}), including combining marks that NFKC leaves
// attached (e.g. Turkish İ decomposes to I + combining-dot-above, the mark falls here).
function lettersAndDigitsOnly(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * True when `value` names MikroB -- any case/whitespace/punctuation variant, full-width form
 * (NFKC-folded), any formatting/invisible/combining character, or a look-alike letter (Cirill,
 * Gorog, Armenian, small-caps, Turkish dotless-i, Hangul filler -- WhiteHat F3 + RedHat delta B2).
 * A non-string value is never forbidden here -- see isInvalidAssigneeShape for that check.
 */
export function isForbiddenAssignee(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const folded = lettersAndDigitsOnly(foldConfusables(value.normalize('NFKC')))
  return folded.toLowerCase() === FORBIDDEN_ASSIGNEE
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
