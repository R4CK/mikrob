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
// CYBERSEC NO-GO 39413 F-1: a few minutes of tolerated clock skew between the author's machine and
// the trusted clock (`now`) used at load time -- not a loophole, since a real skew this small
// cannot buy meaningful extra quarantine days, but prevents a false rejection from an honest few
// seconds of drift.
const FUTURE_SKEW_MS = 5 * 60 * 1000
const CARD_ID_RE = /^[0-9a-f]{8}$/

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

/** Validates the raw parsed JSON shape and every entry's required fields, date range and card-id
 *  shape against a TRUSTED clock (`now`, defaulting to the real clock at load time -- never the
 *  entry's own fields). Throws on the FIRST problem -- a malformed quarantine file must fail the
 *  suite loudly, not silently drop the bad entry (that would hide the exact "entry without
 *  card/owner/expiry is rejected" requirement the card asks for).
 *
 *  CYBERSEC NO-GO 39413 F-1: the 7-day cap used to be relative only to the entry's OWN
 *  author-chosen `added_at`, so a far-future `added_at`/`expiry` pair (e.g. year 2099) passed
 *  every check and stayed active indefinitely -- measured live, P2/P3 in the NO-GO. Capping
 *  `added_at` and `expiry` against `now` instead closes that: an entry can no longer out-run the
 *  real clock no matter what it claims about itself. Rejecting a duplicate `selftest` name (P7/P8
 *  in the NO-GO: three back-to-back or three identical entries for the same name) makes renewing
 *  quarantine after expiry a new, visible diff instead of silent concurrent coverage. */
export function parseQuarantineEntries(raw: unknown, now: Date = new Date()): QuarantineEntry[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { entries?: unknown }).entries)) {
    throw new Error('selftest-quarantine.json must have an "entries" array')
  }
  const entries = (raw as { entries: unknown[] }).entries
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`selftest-quarantine.json has ${entries.length} entries, max is ${MAX_ENTRIES}`)
  }
  const seenNames = new Set<string>()
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
    if (!CARD_ID_RE.test(card)) {
      throw new Error(`selftest-quarantine entry ${i} (${selftest}): "card" must be an 8-hex-char card id, got "${card}"`)
    }
    if (seenNames.has(selftest)) {
      throw new Error(
        `selftest-quarantine entry ${i}: duplicate "selftest" "${selftest}" -- renewing quarantine ` +
          `after expiry must be a new, visible diff replacing the old entry, not a second concurrent one`,
      )
    }
    seenNames.add(selftest)
    const addedDate = requireDate(added_at, 'added_at', i)
    const expiryDate = requireDate(expiry, 'expiry', i)
    if (addedDate.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      throw new Error(
        `selftest-quarantine entry ${i} (${selftest}): "added_at" (${added_at}) is in the future -- ` +
          `it must be the real date the entry was added, not a date chosen to extend the window`,
      )
    }
    if (expiryDate.getTime() <= addedDate.getTime()) {
      throw new Error(`selftest-quarantine entry ${i} (${selftest}): "expiry" must be after "added_at"`)
    }
    if (expiryDate.getTime() - addedDate.getTime() > MAX_DURATION_MS) {
      throw new Error(`selftest-quarantine entry ${i} (${selftest}): expiry is more than 7 days after added_at`)
    }
    if (expiryDate.getTime() > now.getTime() + MAX_DURATION_MS) {
      throw new Error(
        `selftest-quarantine entry ${i} (${selftest}): "expiry" (${expiry}) is more than 7 days from now -- ` +
          `the cap is against the real clock, not just "added_at"`,
      )
    }
    return { selftest, owner, card, added_at, expiry }
  })
}

export function loadQuarantineEntries(path: string, now: Date = new Date()): QuarantineEntry[] {
  return parseQuarantineEntries(JSON.parse(readFileSync(path, 'utf-8')), now)
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

/** Thrown by a selftest's own guard checks (the shared-tree dirty guard, card 99a4a2d4; the
 *  "no recognised PASS summary" check) to mark a failure that must NEVER be swallowed by
 *  quarantine, regardless of quarantine status. CYBERSEC NO-GO 39413 F-3: the original try/catch
 *  swallowed these indiscriminately along with the selftest's own exit failure -- "still runs and
 *  is reported" was only ever meant to tolerate a nonzero exit, not a dirtied tree or a missing
 *  summary. */
export class AlwaysFatalSelftestError extends Error {}

/** Runs one selftest's check (`run`) and decides whether a failure is swallowed (reported via
 *  `onQuarantined`, call returns `undefined`) or rethrown, from the quarantine list and a trusted
 *  clock -- never from anything `run` itself claims. Pure aside from invoking `run`/`onQuarantined`,
 *  so the quarantined/expired/unlisted branches are unit-testable with an injected failing/
 *  succeeding `run` instead of a real selftest (CYBERSEC NO-GO 39413 F-2: the real it.each loop had
 *  no test exercising these branches, so a swallow-everything mutant survived). */
export function runQuarantined(
  selftest: string,
  entries: readonly QuarantineEntry[],
  now: Date,
  run: () => string,
  onQuarantined: (message: string) => void,
): string | undefined {
  try {
    return run()
  } catch (e) {
    if (e instanceof AlwaysFatalSelftestError) throw e
    if (!activeQuarantineNames(entries, now).has(selftest)) throw e
    const entry = entries.find((q) => q.selftest === selftest)!
    onQuarantined(
      `QUARANTINED (not blocking the land): ${selftest} failed -- card ${entry.card}, owner ${entry.owner}, ` +
        `expires ${entry.expiry}.\n${(e as Error).message}`,
    )
    return undefined
  }
}
