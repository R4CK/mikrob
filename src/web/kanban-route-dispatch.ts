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
//
// Card 97f9ca58 (WhiteHat GO 26845, F1): the above had no cap, queue or dedupe -- measured
// (stubbed lower bound) 120 back-to-back transitions -> +709 OS processes, and a bare
// PUT in_progress -> planned -> in_progress re-arms the SAME card. Fix: an in-flight Set keyed
// by cardId (a re-arm while the card's own run is still going is skipped, not queued -- the
// prior run's verdict already covers it), a global cap on concurrent children with a small
// bounded queue beyond the cap (drop + log past that), and the 60s timeout now kills the whole
// process GROUP instead of only the top bash (F4: a timeout that kills only the parent leaves
// card-build-route.sh's own subshells running).
//
// Uses spawn(), not execFile(): measured directly (node -e, this sandbox) that execFile's
// `detached` option is silently NOT forwarded to the underlying process -- the child's pgid stays
// equal to the PARENT's pgid, so `process.kill(-pid)` would kill the wrong (shared) group. spawn()
// with detached:true gives the child its own pgid (pgid === pid, verified the same way), which is
// what makes killing -pid safe and targeted. execFile's convenience (buffered stdout, error
// object) is reimplemented here by hand for that reason, not out of preference.
import { spawn, type ChildProcess } from 'node:child_process'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

const SCRIPT_PATH = `${STORE_DIR}/card-build-route.sh`
const TIMEOUT_MS = 60_000
const MAX_CONCURRENT = 3
const MAX_QUEUE = 20
const MAX_BUFFER = 1 << 16

const inFlight = new Set<string>()
const queue: string[] = []
let running = 0

export function fireCardBuildRoute(cardId: string): void {
  try {
    if (inFlight.has(cardId)) {
      logger.warn({ cardId }, 'kanban-route-dispatch: already in flight for this card, skipping re-arm')
      return
    }
    inFlight.add(cardId)
    if (running < MAX_CONCURRENT) {
      running++
      spawnChild(cardId)
      return
    }
    if (queue.length >= MAX_QUEUE) {
      inFlight.delete(cardId)
      logger.warn({ cardId, queueLength: queue.length }, 'kanban-route-dispatch: queue full, dropping dispatch')
      return
    }
    queue.push(cardId)
  } catch (err) {
    inFlight.delete(cardId)
    logger.warn({ err: err instanceof Error ? err.message : String(err), cardId }, 'kanban-route-dispatch: failed to enqueue (dispatch still succeeded)')
  }
}

function spawnChild(cardId: string): void {
  let child: ChildProcess
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  try {
    child = spawn(
      'bash',
      [SCRIPT_PATH, cardId],
      { detached: true, env: { ...process.env, CARD_BUILD_ROUTE_DISPATCHER: 'api' } },
    )
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), cardId }, 'kanban-route-dispatch: spawn failed (dispatch still succeeded)')
    done(cardId)
    return
  }

  let stdout = ''
  let bufferedBytes = 0
  child.stdout?.on('data', (chunk: Buffer) => {
    bufferedBytes += chunk.length
    if (bufferedBytes <= MAX_BUFFER) stdout += chunk.toString()
  })

  function settle(outcome: { ok: true } | { ok: false; reason: string }): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (outcome.ok) {
      logger.info({ cardId, verdict: stdout.trim() }, 'kanban-route-dispatch: card-build-route.sh ran from the kanban API')
    } else {
      logger.warn({ reason: outcome.reason, cardId }, 'kanban-route-dispatch: card-build-route.sh failed (dispatch still succeeded)')
    }
    done(cardId)
  }

  child.on('error', (err) => settle({ ok: false, reason: err.message }))
  child.on('exit', (code, signal) => {
    if (code === 0) settle({ ok: true })
    else settle({ ok: false, reason: signal ? `killed by ${signal}` : `exit code ${code}` })
  })

  // F4: the old `timeout` execFile option only signals the direct bash child, leaving
  // card-build-route.sh's own inner subshells running past the deadline. detached:true puts the
  // child in its own process group (pgid === child.pid), so killing -pid kills that whole tree.
  timer = setTimeout(() => {
    if (typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), cardId }, 'kanban-route-dispatch: timeout kill failed')
      }
    }
  }, TIMEOUT_MS)
}

function done(cardId: string): void {
  inFlight.delete(cardId)
  running--
  const next = queue.shift()
  if (next !== undefined) {
    running++
    spawnChild(next)
  }
}

// Test-only: the in-flight/queue/running state above is module-level by design (it must be
// shared across every call the process makes, not per-test), so tests that drive multiple
// bursts need a way to clear it between cases instead of inheriting the previous case's state.
export function __resetRouteDispatchStateForTests(): void {
  inFlight.clear()
  queue.length = 0
  running = 0
}
