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
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$HERE/kg-backfill.sh" "$@"
