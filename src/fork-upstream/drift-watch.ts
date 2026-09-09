// The scheduled upstream-drift watcher's DECISION, kept separate from the I/O that carries it out
// (card a1ce8952, parent 1f276349, MikroB decision 24642 direction "C").
//
// WHY THE DECISION IS A PURE FUNCTION. Every action this watcher can take is visible to the whole
// fleet: it opens a kanban card, or it comments on one. The branches that matter are the ones that
// must NOT act -- an unreachable upstream, a drift that has not moved since yesterday, a card a
// human deliberately closed -- and none of them can be exercised against the live dashboard
// without writing to the real board first. So the branching takes the drift result, the open cards
// and the previous fingerprint as ARGUMENTS, and store/fork-upstream-drift-watch.sh does the
// talking. Same seam as classifyConflicts's `blobOf` and runDriftCheck's `GitRunner`.
//
// WHY DEDUP IS NOT OPTIONAL. The check sees the SAME drift on every pass until somebody resolves
// it, so a naive "open a card" would produce one identical card per run -- rule 6b's dedup
// requirement violated at machine speed, which is the thing the card was written to prevent.
import { createHash } from 'node:crypto'
import { isClean, type DriftResult } from './drift-check.js'

/** The token that makes a card THIS watcher's card. Deliberately not a word anyone would type by
 *  accident, and matched as a prefix (see isDriftCardTitle). */
export const DRIFT_CARD_MARKER = '[UPSTREAM-DRIFT]'

/** Rule 2 puts a `[NN%]` progress marker at the FRONT of a card title, so the marker this watcher
 *  owns is not always at index 0. Everything past that must still be a PREFIX match: a card that
 *  merely MENTIONS the marker in its title -- the card that asked for this watcher does exactly
 *  that -- is not the drift card, and matching it would make the watcher comment on the wrong
 *  thread forever. Note which way the error runs here: in a DENY matcher refusing to match is
 *  permitting, so substring matching is the safe side; in a matcher that TRIGGERS an action, a
 *  loose match is what causes the wrong write, so the anchoring is the safe side. */
const PROGRESS_PREFIX = /^\s*(?:\[\s*\d{1,3}\s*%\s*\]\s*)?/

export function isDriftCardTitle(title: string): boolean {
  return title.replace(PROGRESS_PREFIX, '').startsWith(DRIFT_CARD_MARKER)
}

export interface OpenCard {
  readonly id: string
  readonly title: string
  /** Unix seconds. Only used to make "the drift card" deterministic when more than one is open. */
  readonly createdAt?: number
}

/** The OLDEST open drift card, so that a board which somehow carries two does not make the watcher
 *  alternate between them depending on row order. */
export function findDriftCard(openCards: readonly OpenCard[]): OpenCard | null {
  const matches = openCards.filter((c) => isDriftCardTitle(c.title))
  if (matches.length === 0) return null
  return [...matches].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0] ?? null
}

export const CLEAN_FINGERPRINT = 'clean'
export const UNREACHABLE_FINGERPRINT = 'unreachable'

/**
 * The fingerprint is over the SET OF FILES, not over the upstream blob shas.
 *
 * `upstream/develop` moves most days, and a stale acknowledgement carries the upstream sha that
 * moved -- so a fingerprint that included the shas would report "something changed" every single
 * day while the actionable fact (which files nobody has re-decided) stayed exactly the same. That
 * is the daily-noise failure the README's skill-drift entry already names: alert on the change of
 * the diverged SET, not on its count or its churn. The shas ARE carried in the reported body; they
 * are just not what decides whether to speak.
 */
export function driftFingerprint(r: DriftResult): string {
  if (!r.reachable) return UNREACHABLE_FINGERPRINT
  if (isClean(r)) return CLEAN_FINGERPRINT
  const parts = [
    `guarded=${[...r.guarded].sort().join(',')}`,
    `unwatched=${[...r.unwatched].sort().join(',')}`,
    `stale=${r.stale.map((s) => s.file).sort().join(',')}`,
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

export type DriftAction =
  /** Say nothing. `fingerprint === null` means "do not write the state file either". */
  | { readonly kind: 'silent'; readonly reason: string; readonly fingerprint: string | null }
  | { readonly kind: 'open'; readonly title: string; readonly description: string; readonly fingerprint: string }
  | { readonly kind: 'comment'; readonly cardId: string; readonly content: string; readonly fingerprint: string }

const MAX_BODY_CHARS = 4000

/** The board gets the SHAPE of the drift; acknowledged-conflicts.ts already holds the prose. The
 *  full report is 19KB on today's tree (measured) because every stale rule carries its accumulated
 *  re-measure notes -- posting that to a card would bury the one line a reader needs. */
export function summarizeDrift(r: DriftResult): string {
  const lines: string[] = [
    `Az upstream oldal elmozdult ahhoz képest, amit róla eldöntöttünk. Fork-owned ütközés: ${r.guarded.length}, ` +
      `senki által nem döntött ütközés: ${r.unwatched.length}, elavult elismerés: ${r.stale.length}.`,
  ]
  if (r.guarded.length) {
    lines.push(
      '',
      'FORK-OWNED FÁJLOK, AMIK MOST ÜTKÖZNEK (ezeknek sosem szabadna): ' + r.guarded.join(', ') + '.',
      'A README "Upstream-owned vs fork-owned fájlok" szakaszának nulla-konfliktus állítása ezzel többé nem áll.'
    )
  }
  if (r.unwatched.length) {
    lines.push(
      '',
      'SENKI NEM DÖNTÖTTE EL, HOGY MI LEGYEN VELÜK: ' + r.unwatched.join(', ') + '.',
      'Ez a sürgős fele: döntsd el a szabályt MOST, amíg van idő mindkét oldalt megnézni, és vezesd be az ' +
        'ACKNOWLEDGED_CONFLICTS-be. A merge közben az olcsó lépés az egyik oldal egyben való átvétele.'
    )
  }
  if (r.stale.length) {
    lines.push('', 'AZ ELISMERÉS MÁR NEM AZT ÍRJA LE, AMI OTT VAN (rögzített -> mostani upstream blob):')
    for (const s of r.stale) {
      lines.push(`  ${s.file}  ${s.recorded.slice(0, 12)} -> ${s.actual.slice(0, 12)}`)
    }
    lines.push(
      'Mindegyiknél a KORÁBBI szabályt kell elolvasni az ACKNOWLEDGED_CONFLICTS-ben, és újra dönteni ' +
        'a mostani upstream tartalom ellen. Egy puszta blob-szám bumpolás nem újra-döntés.'
    )
  }
  lines.push(
    '',
    'A TELJES riport (minden szabály szövegével és beilleszthető bejegyzésekkel):',
    '  node /home/neon/marveen/store/fork-upstream-drift-watch.mjs --report'
  )
  const body = lines.join('\n')
  if (body.length <= MAX_BODY_CHARS) return body
  return body.slice(0, MAX_BODY_CHARS) + '\n[...levágva; a teljes lista a fenti --report parancsból jön]'
}

const CLEAN_NOTE =
  'A drift MEGSZŰNT: a legutóbbi ellenőrzés szerint minden upstream ütközéshez tartozik érvényes, ' +
  'a mostani upstream tartalom ellen felülvizsgált döntés. A kártyát SZÁNDÉKOSAN nem zárom le magamtól ' +
  '(gépi zárás nem helyettesít egy gate-et); ha nincs más hátralék rajta, MikroB zárhatja.'

export function driftCardTitle(r: DriftResult): string {
  const n = r.guarded.length + r.unwatched.length + r.stale.length
  return `${DRIFT_CARD_MARKER}[marveen][INFRA][SEC] upstream-drift: ${n} fájl újra-döntést vár`
}

/**
 * The whole watcher, minus the talking.
 *
 * `lastFingerprint` is what the previous run ACTED on (null = never acted, or the state was lost).
 */
export function decideDriftAction(
  r: DriftResult,
  openCards: readonly OpenCard[],
  lastFingerprint: string | null
): DriftAction {
  // Nothing to say is not the same as nothing wrong. An unreachable upstream must never open a
  // card, and must not overwrite the state either: a network blip would otherwise erase the memory
  // of what was already reported, and the next reachable run would repeat itself.
  if (!r.reachable) return { kind: 'silent', reason: 'upstream-unreachable', fingerprint: null }

  const fp = driftFingerprint(r)
  const card = findDriftCard(openCards)

  if (isClean(r)) {
    if (card !== null && lastFingerprint !== null && lastFingerprint !== CLEAN_FINGERPRINT) {
      return { kind: 'comment', cardId: card.id, content: CLEAN_NOTE, fingerprint: fp }
    }
    return { kind: 'silent', reason: card !== null ? 'clean-already-reported' : 'clean', fingerprint: fp }
  }

  if (card === null) {
    // A card that is GONE while the drift is UNCHANGED is a card somebody closed on purpose.
    // Opening a replacement every morning is exactly the duplication this watcher exists to
    // prevent, so the silence lasts until the world actually moves. A null lastFingerprint still
    // opens: never having spoken is not the same as having been answered.
    if (lastFingerprint === fp) return { kind: 'silent', reason: 'closed-and-unchanged', fingerprint: fp }
    return { kind: 'open', title: driftCardTitle(r), description: summarizeDrift(r), fingerprint: fp }
  }

  if (lastFingerprint === fp) return { kind: 'silent', reason: 'unchanged', fingerprint: fp }
  return { kind: 'comment', cardId: card.id, content: summarizeDrift(r), fingerprint: fp }
}
