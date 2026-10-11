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

// WhiteHat F3 (NO-GO komment 15784/10562, kartya e25a549a): zero-width/formatting karakterek es
// Cirill/Gorog hasonmasok atmentek a sima .trim().toLowerCase() osszevetesen. Nem csak a 6 betu
// ("mikrob") hasonmasait listazzuk, hanem egy szokasos, hatarolt Cirill/Gorog->Latin tablat -- igy
// a jovoben barmelyik iranyban hasonlo betucsere is elkapva marad, nem csak a ma mert eset.
const INVISIBLE_RE = /[​‌‍⁠﻿­]/g
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
  'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'к': 'k', 'м': 'm',
  'А': 'A', 'Е': 'E', 'О': 'O', 'Р': 'P', 'С': 'C',
  'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  'К': 'K', 'М': 'M',
  'ο': 'o', 'Ο': 'O', // Greek omicron
}

function foldConfusables(s: string): string {
  let out = ''
  for (const ch of s) out += CONFUSABLES[ch] ?? ch
  return out
}

/**
 * True when `value` names MikroB -- any case/whitespace variant, full-width form (NFKC-folded),
 * zero-width/soft-hyphen-padded, or Cirill/Gorog look-alike letters (WhiteHat F3). A non-string
 * value is never forbidden here -- see isInvalidAssigneeShape for that check.
 */
export function isForbiddenAssignee(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const folded = foldConfusables(value.normalize('NFKC').replace(INVISIBLE_RE, ''))
  return folded.trim().toLowerCase() === FORBIDDEN_ASSIGNEE
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
