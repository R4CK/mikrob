// Structural check for a kanban card's `id`/`parent_id` shape (card 335fb927, WhiteHat2 GO on
// 41d8e96f msg 10760, F1 MEDIUM). POST /api/kanban lets the CLIENT choose the id (card f27c999b's
// echo-fix preserved that, it never added a format check), and the dispatch renderer
// (kanbanMoveInstructions, routes/kanban.ts) interpolates that id, unquoted, into shell command
// blocks it hands to another agent to copy-paste -- including one that sits inside a
// DOUBLE-quoted `python3 -c "..."` argument, where `$(...)` is expanded by the shell BEFORE
// python ever runs. Measured: id = `x$(echo pwned > marker)` ran its substitution in all 3
// command blocks the renderer emits. A token-holder could hand another agent a dispatched card
// whose id runs an arbitrary command on the RECIPIENT's machine the moment that agent does what
// the whole dispatch design assumes it will: paste the commands.
//
// The allow-listed shape excludes every shell metacharacter that matters here ($, `, ", ', space,
// parens, pipe, semicolon, redirect) by construction -- this is not an escaping scheme, it is a
// character class narrow enough that none of them can ever appear in a value that passes it.
export const KANBAN_ID_PATTERN_DESC = '^[A-Za-z0-9_-]{1,64}$'
const KANBAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const INVALID_KANBAN_ID_MESSAGE =
  `Az id/parent_id csak ${KANBAN_ID_PATTERN_DESC} alakú lehet (betű, szám, "_", "-", 1-64 ` +
  'karakter) -- ez a dispatch-renderer parancsblokkjaiba idézés/escapelés nélkül kerül be, ' +
  'ezért más alak parancs-injekciót nyitna (kártya 335fb927).'

/** True when `value` is a non-empty string matching the allow-listed id shape. */
export function isValidKanbanId(value: unknown): boolean {
  return typeof value === 'string' && KANBAN_ID_RE.test(value)
}

/**
 * True when `value` is PRESENT (not null/undefined/empty-string, which mean "no id supplied" /
 * "clear parent_id" and are handled by the caller before this ever runs) but does not match the
 * allow-listed shape. Mirrors isInvalidAssigneeShape's present-but-wrong-shape convention in
 * kanban-assignee-guard.ts: a field that was never supplied is not a format violation.
 */
export function isInvalidKanbanIdShape(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string' && value === '') return false
  return !isValidKanbanId(value)
}
