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
ATTEMPTED=0
DRAFTED=0
emit_end_line() { log "batch END status=${BATCH_END_STATUS} attempted=${ATTEMPTED} drafted=${DRAFTED}"; }

# Candidate selection/ordering/BLOKKOLT-filter logic (card 3e094b1e, alfeladat f8c72a5a), shared
# verbatim between the real run (fed from curl) and --test-select (fed from stdin) so a test can
# never drift from what actually runs. See the comment at its real call site below for WHY planned
# is ordered mechanical-first instead of urgent-first.
SELECT_PY='
import json,sys
URGENCY={"urgent":0,"high":1,"normal":2,"low":3}
MECHANICAL_FIRST={"low":0,"normal":1,"high":2,"urgent":3}
cards=json.load(sys.stdin)
sel=[c for c in cards if c.get("status") in ("in_progress","planned") and "BLOKKOLT" not in (c.get("title") or "")]
def rank(c):
    if c.get("status")=="in_progress":
        return (0, URGENCY.get(c.get("priority"),9))
    return (1, MECHANICAL_FIRST.get(c.get("priority"),9))
sel.sort(key=rank)
for c in sel: print(c["id"])
'

# --- test-select mode ----------------------------------------------------------------------------
# Usage: offload-batch-run.sh --test-select   (reads a JSON kanban-card array on stdin, prints the
# selected+ordered card ids) -- exercises the exact selection logic with no tmux/curl/kanban I/O.
if [[ "${1:-}" == "--test-select" ]]; then
  python3 -c "$SELECT_PY"
  exit 0
fi

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

# candidate cards: all in_progress + planned, ordered in_progress-first (urgent-first within that
# bucket -- active work benefits from immediate draft help regardless of complexity), THEN planned
# cards ordered MECHANICAL-FIRST (low priority first), not urgent-first.
#
# WHY planned is reversed (audit finding, card 3e094b1e, alfeladat f8c72a5a): CAP counts ATTEMPTS,
# and a real run measured 69 candidates with CAP=20 producing ZERO drafts -- the cap was entirely
# consumed by URGENT/HIGH planned cards, which are typically multi-file/architectural and fail the
# router's local-eligibility check, before the loop ever reached a genuinely mechanical LOW card. A
# live manual run of the same pipeline on a LOW card excluded from that night's top-20 (6dad1830,
# a one-line test timeout bump) routed local and drafted successfully in seconds -- the router and
# the model both work fine, the candidate ORDER was just aimed at the cards least likely to succeed.
# Reversing planned-order does not change in_progress semantics and does not touch the router.
#
# BLOKKOLT-* cards are also excluded from candidates (same fleet-wide convention as
# store/fleet-nudger.sh): a card explicitly parked pending a decision cannot be worked on regardless
# of what a local draft says, so drafting one only spends CAP budget on a card nobody will read yet.
#
# We skip any card that already has a LOCAL-LLM DRAFT comment (offload-dispatch re-checks
# too, but filtering here avoids spinning the model up for nothing).
mapfile -t CARDS < <(curl -s -H @"$hdr_file" "$DASH/api/kanban" | python3 -c "$SELECT_PY")

log "batch start: ${#CARDS[@]} candidate cards, cap $CAP"
attempted=0
drafted=0
for id in "${CARDS[@]}"; do
  (( attempted >= CAP )) && { log "cap $CAP reached; stopping"; break; }
  # skip if already drafted
  has=$(curl -s -H @"$hdr_file" "$DASH/api/kanban/$id/comments" \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print('Y' if any('LOCAL-LLM DRAFT' in (c.get('content') or '') for c in d) else 'N')" 2>/dev/null || echo Y)
  [[ "$has" == "Y" ]] && continue
  log "offload -> card $id"
  # "attempted" counts every dispatch call (what CAP bounds, for runtime); "drafted" counts only
  # the ones that actually posted a draft (offload-dispatch.sh exits 0 either way, so the earlier
  # version's "$done cards drafted" line was counting attempts and calling them drafts -- a run
  # that drafted zero cards logged "20 cards drafted this run", which is what surfaced this bug).
  out="$(bash "$HERE/offload-dispatch.sh" "$id" 2>&1)"; rc=$?
  printf '%s\n' "$out" >>"$LOG"
  [[ $rc -ne 0 ]] && log "  dispatch non-zero for $id (best-effort)"
  attempted=$(( attempted + 1 ))
  if printf '%s' "$out" | grep -q -- '-> posted local draft(s)'; then
    drafted=$(( drafted + 1 ))
  fi
done

ATTEMPTED="$attempted"
DRAFTED="$drafted"
BATCH_END_STATUS="ok"
log "batch done: attempted=$attempted drafted=$drafted this run"
echo "OK attempted=$attempted drafted=$drafted"
exit 0
