#!/usr/bin/env bash
# Card 01b10349: thin wrapper around scripts/kg-import-mt10.ts (card 81593084/MT-10's four
# decision/finding/anti-pattern/cold-memory importers). Unlike kg-backfill.sh/kg-capture-worker.sh,
# this has NO local-LLM dependency -- it is a pure DB-to-DB import (kanban_comments, DECISIONS.md,
# memories -> knowledge-graph.db), so it must NOT go through the local-llm INSTALLED gate those
# scripts use; routing it through them would wrongly make it depend on GPU/model availability.
#
# Idempotent (each importer upserts by a content-derived id, per scripts/kg-import-mt10.ts's own
# header comment) -- safe to run on a schedule for both the initial backfill and incremental
# capture. flock -n, same nonblocking-try pattern as kg-capture-worker.sh, so a second scheduled
# run never writes to knowledge-graph.db concurrently with one still in flight.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MARVEEN_MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
LOCK_FILE="${KG_IMPORT_MT10_LOCK:-$HERE/kg-import-mt10.lock}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "kg-import-mt10: another run already holds the lock -- skipping this cycle." >&2
  exit 0
fi

cd "$MARVEEN_MAIN"
exec npx tsx scripts/kg-import-mt10.ts "$@"
