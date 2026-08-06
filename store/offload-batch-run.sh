#!/usr/bin/env bash
# offload-batch-run.sh -- OVERNIGHT BATCH OFFLOAD (Peti 2026-07-31, local-LLM point 2).
#
# The GPU sits idle at night. This drains the mechanical backlog to the LOCAL 7B for
# FREE: every in_progress card plus the top-N mechanical planned cards that do NOT yet
# carry a local-llm-draft get their sub-steps drafted via offload-dispatch.sh. The 6 GB
# GPU runs one model at a time, so this is intentionally SEQUENTIAL, not parallel.
#
# DRAFT-ONLY: nothing ships. Every draft is re-checked by MikroB + the gate before DONE
# (see local-llm-work-must-be-rechecked). This script never closes or dispatches a card.
#
# Meant to run from a nightly scheduled task in the off-peak window. Best-effort, exit 0.
# No secrets in argv; the token is read at call time. Version-controlled per the ops rule.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
TOK="$(cat "$HERE/.dashboard-token" 2>/dev/null || true)"
CAP="${OFFLOAD_BATCH_CAP:-20}"   # max cards drafted per night (keeps a runaway bounded)
LOG="$HERE/offload-batch.log"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >>"$LOG"; }

if [[ -z "$TOK" ]]; then log "no dashboard token; abort"; echo "ERROR no-token"; exit 0; fi

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): the token must never be a curl
# argv (/proc/<pid>/cmdline is world-readable). Private 0600 header file instead, -H @"$hdr_file",
# removed on EXIT.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$TOK" > "$hdr_file"

# candidate cards: all in_progress + planned, ordered in_progress-first then by priority.
# We skip any card that already has a LOCAL-LLM DRAFT comment (offload-dispatch re-checks
# too, but filtering here avoids spinning the model up for nothing).
mapfile -t CARDS < <(
  curl -s -H @"$hdr_file" "$DASH/api/kanban" | python3 -c "
import json,sys
order={'urgent':0,'high':1,'normal':2,'low':3}
cards=json.load(sys.stdin)
sel=[c for c in cards if c.get('status') in ('in_progress','planned')]
sel.sort(key=lambda c:(0 if c.get('status')=='in_progress' else 1, order.get(c.get('priority'),9)))
for c in sel: print(c['id'])
"
)

log "batch start: ${#CARDS[@]} candidate cards, cap $CAP"
done=0
for id in "${CARDS[@]}"; do
  (( done >= CAP )) && { log "cap $CAP reached; stopping"; break; }
  # skip if already drafted
  has=$(curl -s -H @"$hdr_file" "$DASH/api/kanban/$id/comments" \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print('Y' if any('LOCAL-LLM DRAFT' in (c.get('content') or '') for c in d) else 'N')" 2>/dev/null || echo Y)
  [[ "$has" == "Y" ]] && continue
  log "offload -> card $id"
  bash "$HERE/offload-dispatch.sh" "$id" >>"$LOG" 2>&1 || log "  dispatch non-zero for $id (best-effort)"
  done=$(( done + 1 ))
done

log "batch done: $done cards drafted this run"
echo "OK drafted=$done"
exit 0
