#!/usr/bin/env bash
# Card 1388200c: src/web/kg-capture-hook.ts's own header comment has said since MT-05 (card
# c991508f) that "a separate worker (store/kg-capture-worker.sh, polling this queue) drains it" --
# that file never existed, so the 12 rows the hook enqueued over the following week sat in
# kg_capture_queue forever (kg_nodes 0, kg_edges 0) while the UI reported "visszamenőleges
# feltöltés fut" to anyone who looked. This IS that file now.
#
# Thin wrapper, not a second implementation: kg-backfill.sh already has the INSTALLED gate (root
# CLAUDE.md rule 16) and execs the same scripts/kg-backfill.ts this worker needs -- the CLI now
# drains the already-enqueued queue FIRST (any reason: 'closed'/'reopen' from this live hook, or a
# retryable 'backfill' failure) and only then discovers 'done' cards never queued at all
# (src/kg/backfill-cli.ts's buildListCandidates). One batch, one pipeline, one local-LLM-only path
# (MODULTERV section 5 -- never falls back online on a GPU hold).
#
# G2 (card c84a510a): a batch of up to KG_BACKFILL_BATCH cards, each allowing up to
# KG_DRAFT_MAX_ATTEMPTS(2) local-LLM calls at up to DRAFT_CALL_TIMEOUT_MS(300s) apiece, can run far
# longer than the worker's own schedule cadence (10 min) -- measured directly on this card (a
# drain run still mid-batch when the next scheduled tick would fire). Without a lock, a second
# scheduled run starts concurrently, doubling GPU contention for both and starving whichever row
# either one is on (the exact failure class this card's FINDING comments reproduced). flock -n
# (same nonblocking-try pattern fleet-test.sh/mopsion-suite-run.sh use for their own single-flight
# guards) on a dedicated lock file: if another worker invocation already holds it, this run exits
# immediately without touching the queue, rather than queueing -- the next cron tick is the retry.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="${KG_CAPTURE_WORKER_LOCK:-$HERE/kg-capture-worker.lock}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "kg-capture-worker: another run already holds the lock -- skipping this cycle." >&2
  exit 0
fi

exec bash "$HERE/kg-backfill.sh" "$@"
