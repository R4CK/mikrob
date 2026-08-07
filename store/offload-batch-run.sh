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

# --- health signal -----------------------------------------------------------
# The scheduled task launches this with `nohup ... &`, which returns exit 0 in ~11ms no
# matter what happens next. So the task's own timeoutMs/failThreshold can never fire:
# "fired + exit 0" looks identical whether the batch drafted 20 cards or died instantly
# (Cybersec finding on card 975e5a97). Backgrounding is right -- a 20-card 7B run must
# not hold the scheduler tick -- so the signal has to come from the LOG instead.
#
# Every run therefore ends with one machine-readable line, written from an EXIT trap so
# it appears on the abnormal paths too (kill, set -e, unhandled error). `--status` reads
# it back and IS the health check: fast, foreground, and its exit code is real.
BATCH_END_STATUS="aborted"
DRAFTED=0
emit_end_line() { log "batch END status=${BATCH_END_STATUS} drafted=${DRAFTED}"; }

# --- status mode -------------------------------------------------------------
# Usage: offload-batch-run.sh --status [--max-age-hours N]   (default 26h: a nightly
# task plus a margin, so a single late catch-up does not cry wolf)
if [[ "${1:-}" == "--status" ]]; then
  MAX_AGE_H=26
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max-age-hours) [[ $# -ge 2 ]] || { echo "ERROR:missing-value:--max-age-hours"; exit 2; }; MAX_AGE_H="$2"; shift 2 ;;
      *) echo "ERROR:unknown-argument:$1"; exit 2 ;;
    esac
  done
  # a non-numeric bound would make `(( age_h > MAX_AGE_H ))` treat it as 0 and report STALE
  # on every run -- a check that always fires is ignored as fast as one that never does
  case "$MAX_AGE_H" in ''|*[!0-9]*) echo "ERROR:invalid-max-age:$MAX_AGE_H"; exit 2 ;; esac
  if [[ ! -r "$LOG" ]]; then echo "NEVER-RAN no log at $LOG"; exit 1; fi
  last_end="$(grep 'batch END status=' "$LOG" | tail -1)"
  if [[ -z "$last_end" ]]; then echo "NEVER-COMPLETED log exists but no END line"; exit 1; fi
  # leading "[YYYY-MM-DD HH:MM:SS]"
  stamp="$(printf '%s' "$last_end" | sed -n 's/^\[\([^]]*\)\].*/\1/p')"
  end_epoch="$(date -d "$stamp" +%s 2>/dev/null || echo "")"
  case "$end_epoch" in ''|*[!0-9]*) echo "ERROR:unparseable-timestamp:$stamp"; exit 2 ;; esac
  age_h=$(( ( $(date +%s) - end_epoch ) / 3600 ))
  # `[a-z-]`, not `[a-z]`: a hyphenated status like `no-token` was being truncated to `no`,
  # which still reported a failure but named the wrong one
  status="$(printf '%s' "$last_end" | sed -n 's/.*status=\([a-z-]*\).*/\1/p')"
  if [[ "$status" != "ok" ]]; then echo "LAST-RUN-FAILED status=$status age=${age_h}h"; exit 1; fi
  if (( age_h > MAX_AGE_H )); then echo "STALE last ok run ${age_h}h ago (max ${MAX_AGE_H}h)"; exit 1; fi
  echo "FRESH last ok run ${age_h}h ago, ${last_end##*drafted=} card(s)"
  exit 0
fi

# ONE trap, not two (card 5f00664c, Cybered F1 + Cybersec + QA, all three reproduced it). A second
# `trap ... EXIT` REPLACES the first rather than chaining, so the earlier `trap emit_end_line EXIT`
# plus a later `trap 'rm -f "$hdr_file"' EXIT` meant the END line never fired on any run that got
# past the token check -- i.e. every normal run -- and --status answered NEVER-COMPLETED forever.
#
# Neither obvious fix is safe. Dropping the cleanup trap leaks the DASHBOARD TOKEN: $hdr_file is the
# 0600 mktemp file holding it, and this task runs overnight, so every run would leave a token in
# /tmp until reboot (the class closed on roll-forward-oneshot.sh). Dropping the emit trap throws away
# the card's whole purpose. So they are COMBINED here, cleanup first, and registered in final form
# BEFORE $hdr_file exists -- `rm -f` on a missing path is silent, which is what makes that safe.
hdr_file=""   # declared before the trap so `set -u` cannot kill the handler
trap 'rm -f "$hdr_file"; emit_end_line' EXIT
if [[ -z "$TOK" ]]; then BATCH_END_STATUS="no-token"; log "no dashboard token; abort"; echo "ERROR no-token"; exit 0; fi

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): the token must never be a curl
# argv (/proc/<pid>/cmdline is world-readable). Private 0600 header file instead, -H @"$hdr_file",
# removed on EXIT.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
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

DRAFTED="$done"
BATCH_END_STATUS="ok"
log "batch done: $done cards drafted this run"
echo "OK drafted=$done"
exit 0
