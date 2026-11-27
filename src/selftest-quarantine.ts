// Card 1ce518d9 (Peti approval Telegram 14809, onfejlesztes 2026-11-26 #4): a single slow
// selftest (wsl-cleanup, card a1c38d36) blocked every land from afternoon to evening because
// store-selftests-all-run.test.ts (src/__tests__/store-selftests-all-run.test.ts) fails the whole
// suite the moment one selftest fails or times out, with no way to let a KNOWN slow/flaky one
// keep running and reporting without blocking. This module is the quarantine list that file reads.
//
// Deliberately NOT a live add/remove API: the list is version-controlled JSON
// (store/selftest-quarantine.json), so adding an entry goes through a normal commit + card +
// MikroB decision, same as any other gated change -- there is no runtime mutation path here.
import { readFileSync } from 'node:fs'

export interface QuarantineEntry {
  readonly selftest: string
  readonly owner: string
  readonly card: string
  readonly added_at: string
  readonly expiry: string
}

const MAX_ENTRIES = 3
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000

function requireNonEmptyString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`selftest-quarantine entry ${index}: missing or empty "${field}"`)
  }
  return value
}

function requireDate(value: string, field: string, index: number): Date {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`selftest-quarantine entry ${index}: "${field}" is not a valid date (${value})`)
  }
  return d
}

/** Validates the raw parsed JSON shape and every entry's required fields and date range.
 *  Throws on the FIRST problem -- a malformed quarantine file must fail the suite loudly, not
 *  silently drop the bad entry (that would hide the exact "entry without card/owner/expiry is
 *  rejected" requirement the card asks for). */
export function parseQuarantineEntries(raw: unknown): QuarantineEntry[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { entries?: unknown }).entries)) {
    throw new Error('selftest-quarantine.json must have an "entries" array')
  }
  const entries = (raw as { entries: unknown[] }).entries
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`selftest-quarantine.json has ${entries.length} entries, max is ${MAX_ENTRIES}`)
  }
  return entries.map((raw_entry, i) => {
    if (typeof raw_entry !== 'object' || raw_entry === null) {
      throw new Error(`selftest-quarantine entry ${i}: not an object`)
    }
    const e = raw_entry as Record<string, unknown>
    const selftest = requireNonEmptyString(e.selftest, 'selftest', i)
    const owner = requireNonEmptyString(e.owner, 'owner', i)
    const card = requireNonEmptyString(e.card, 'card', i)
    const added_at = requireNonEmptyString(e.added_at, 'added_at', i)
    const expiry = requireNonEmptyString(e.expiry, 'expiry', i)
    const addedDate = requireDate(added_at, 'added_at', i)
    const expiryDate = requireDate(expiry, 'expiry', i)
    if (expiryDate.getTime() <= addedDate.getTime()) {
      throw new Error(`selftest-quarantine entry ${i} (${selftest}): "expiry" must be after "added_at"`)
    }
    if (expiryDate.getTime() - addedDate.getTime() > MAX_DURATION_MS) {
      throw new Error(`selftest-quarantine entry ${i} (${selftest}): expiry is more than 7 days after added_at`)
    }
    return { selftest, owner, card, added_at, expiry }
  })
}

export function loadQuarantineEntries(path: string): QuarantineEntry[] {
  return parseQuarantineEntries(JSON.parse(readFileSync(path, 'utf-8')))
}

/** An entry is active (still shielding its selftest from failing the suite) iff `now` has not
 *  reached its expiry yet. Past expiry, it is simply not active any more -- the selftest blocks
 *  the land again with no further action, which is the "after expiry it blocks again" requirement. */
export function isActive(entry: QuarantineEntry, now: Date): boolean {
  return now.getTime() < new Date(entry.expiry).getTime()
}

export function activeQuarantineNames(entries: readonly QuarantineEntry[], now: Date): ReadonlySet<string> {
  return new Set(entries.filter((e) => isActive(e, now)).map((e) => e.selftest))
}
