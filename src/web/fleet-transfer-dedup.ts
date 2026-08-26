// Which rows of an import payload are genuinely NEW in the target (card 394fb5ce, Cybersec L-3).
//
// The kanban event imports used to ask "does a row with this narrow key already exist?" -- for the
// field trail that key was (card_id, created_at, field), and the status trail uses the same shape
// with to_status. Neither key is unique in the SOURCE table: two edits of the same field in the
// same second are two real rows sharing one key, so the second was skipped and the trail silently
// merged two events into one. That is exactly the failure the audit table exists to prevent.
//
// Two changes, both needed:
//   1. the key is the WHOLE row, so two edits that differ only in their values stay distinct;
//   2. matching is by MULTIPLICITY, so N identical source rows produce N target rows -- an
//      existence check can never carry more than one copy across, however wide the key gets.
//
// Idempotence is preserved: re-importing the same payload finds every row already present and
// inserts nothing.

/** A row as it arrives from a payload or comes back from the target table. */
export type TransferRow = Record<string, unknown>

/** Stable identity of a row, built from the columns named. `undefined` (payload) and `null`
 *  (SQLite) are the same absence, so both sides normalise before comparing -- otherwise every
 *  re-import would re-insert rows whose optional columns are empty. */
export function transferRowKey(row: TransferRow, columns: readonly string[]): string {
  return JSON.stringify(columns.map((c) => row[c] ?? null))
}

export const STATUS_EVENT_COLUMNS = ['card_id', 'from_status', 'to_status', 'actor', 'created_at', 'forced'] as const
export const FIELD_EVENT_COLUMNS = ['card_id', 'field', 'old_value', 'new_value', 'actor', 'created_at'] as const

/** The payload rows that the target does not already hold, counting duplicates on both sides.
 *  `existing` is the target table read back with the SAME columns the key names. */
export function newTransferRows<T extends TransferRow>(
  payload: readonly T[],
  existing: readonly TransferRow[],
  columns: readonly string[],
): T[] {
  const available = new Map<string, number>()
  for (const row of existing) {
    const k = transferRowKey(row, columns)
    available.set(k, (available.get(k) ?? 0) + 1)
  }
  const fresh: T[] = []
  for (const row of payload) {
    const k = transferRowKey(row, columns)
    const have = available.get(k) ?? 0
    // Consume one copy per match: the second identical payload row finds the counter at zero and
    // is carried across, which is what makes this different from an existence check.
    if (have > 0) { available.set(k, have - 1); continue }
    fresh.push(row)
  }
  return fresh
}
