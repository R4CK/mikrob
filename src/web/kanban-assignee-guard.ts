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

/**
 * True when `value` names MikroB (any case/whitespace variant), i.e. the field this guards
 * against. A non-string or any other agent name returns false.
 */
export function isForbiddenAssignee(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === FORBIDDEN_ASSIGNEE
}
