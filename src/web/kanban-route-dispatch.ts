// Card 64f56f97 requirement 1: route-check-audit.sh measured most fresh planned->in_progress
// dispatches skipping card-build-route.sh entirely (35% of fresh dispatches with no route
// verdict, 15 of them with a NULL actor). The step lived only in the heartbeat's prose
// (root CLAUDE.md rule 16 / its own step 4b), and nothing enforced it when
// self-advance-pickup.sh, a bare actor-less PUT, or MikroB's own dispatch moved a card.
// Running the router HERE, inside the transition itself, closes every caller at once instead
// of teaching each one separately -- the same "replace a step someone must REMEMBER with a
// value someone can CHECK" move route-check-audit.sh's own header describes.
//
// Fire-and-forget, same contract as card-build-route.sh's own: exit 0 always, never a failure
// mode that should stop a dispatch (card-build-route.sh can take up to its own ~45s model-call
// timeout, far too slow to hold an HTTP response on). Log-and-continue on any failure -- a
// classification miss costs one skipped draft opportunity, never a broken card move.
import { execFile } from 'node:child_process'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

const SCRIPT_PATH = `${STORE_DIR}/card-build-route.sh`
const TIMEOUT_MS = 60_000

export function fireCardBuildRoute(cardId: string): void {
  execFile(
    'bash',
    [SCRIPT_PATH, cardId],
    { timeout: TIMEOUT_MS, maxBuffer: 1 << 16, env: { ...process.env, CARD_BUILD_ROUTE_DISPATCHER: 'api' } },
    (err, stdout) => {
      if (err) {
        logger.warn({ err: err.message, cardId }, 'kanban-route-dispatch: card-build-route.sh failed (dispatch still succeeded)')
        return
      }
      logger.info({ cardId, verdict: stdout.trim() }, 'kanban-route-dispatch: card-build-route.sh ran from the kanban API')
    },
  )
}
