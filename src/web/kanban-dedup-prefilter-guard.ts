// Extends store/dedup-prefilter-check.sh's pre-dispatch dedup heuristic (card 43878b8f) to run on
// EVERY new card, not only on an already-open, >2-day-old planned card about to be dispatched
// (rule 6b/4a). Card 4bade960: rule 6b's "check before opening a card" step was pure agent
// discipline -- POST /api/kanban validated nothing, so nothing stopped a duplicate from being
// opened in the first place; a duplicate was only ever caught later, per-card, after a full
// dispatch+build cycle (or never).
//
// Structural, not disciplinary (code-quality principle 6, root CLAUDE.md): runs automatically on
// every card create and writes its finding straight into the card's OWN description, so it is
// visible wherever the card is read next, instead of depending on an agent remembering to run the
// check by hand before opening a card.
//
// Deliberately calls the SAME script the >2-day dispatch filter already uses, rather than a second,
// hand-rolled port of its matching logic: that script's header documents real calibration (a
// confirmed duplicate pair plus a false-positive sample against 15 unrelated done cards) and a
// second implementation would silently drift from it the first time either one is retuned. One
// calibrated algorithm, two callers.
//
// Fails open like the script's own contract: informational only, never blocks card creation. A
// false positive costs one line appended to a description, not a broken create.
import { execFile } from 'node:child_process'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

const SCRIPT_PATH = `${PROJECT_ROOT}/store/dedup-prefilter-check.sh`
const TIMEOUT_MS = 5000

interface PrefilterMatch {
  doneCardId: string
  doneTitle: string
  reason: string
  score?: number
  sharedRefs?: string[]
  sharedWords?: string[]
}

function runPrefilterCheck(cardId: string): Promise<PrefilterMatch | null> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [SCRIPT_PATH, cardId],
      { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          logger.warn({ err: err.message, cardId }, 'dedup-prefilter-guard: check failed, allowing silently')
          resolve(null)
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { match?: PrefilterMatch | null; error?: string }
          resolve(parsed.match ?? null)
        } catch (parseErr) {
          logger.warn({ parseErr, cardId, stdout }, 'dedup-prefilter-guard: could not parse script output')
          resolve(null)
        }
      },
    )
  })
}

function formatNote(m: PrefilterMatch): string {
  const detail = m.reason === 'shared-reference'
    ? `közösen hivatkozott ID(k): ${(m.sharedRefs ?? []).join(', ')}`
    : `lexikai egyezés (score=${m.score}), közös szavak: ${(m.sharedWords ?? []).join(', ')}`
  return (
    `\n\n[DEDUP-PREFILTER] Lehetséges duplikátum: ${m.doneCardId} "${m.doneTitle}" (${detail}). ` +
    'Ellenőrizd a hivatkozott kártyát, mielőtt folytatod -- ha ugyanazt a problémát oldja meg, ' +
    'ne kezdj bele, inkább kommentelj rá a meglévőre (rule 6b).'
  )
}

/**
 * Runs the calibrated dedup pre-filter against a just-created card. Returns the card's
 * description with the finding appended when there is a likely-duplicate match, or null when
 * there is no match (or the check itself failed) -- null means "leave the description alone".
 */
export async function dedupPrefilterDescriptionUpdate(
  cardId: string,
  currentDescription: string,
): Promise<string | null> {
  const match = await runPrefilterCheck(cardId)
  if (!match) return null
  return currentDescription + formatNote(match)
}
