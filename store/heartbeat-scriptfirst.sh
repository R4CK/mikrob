#!/usr/bin/env bash
# heartbeat-scriptfirst.sh -- script-first heartbeat (card 6d0775bb, Feladat of 7f35d1b9 "Token 1").
#
# Runs the DETERMINISTIC checks that heartbeat-consolidated's SKILL.md currently makes MikroB's LLM
# re-read and re-derive every 10 minutes (kvota/hard-stop/load-guard flags, gate-closure-check over
# every waiting card, the stuck-card list, multi-in-progress, busy-report, escalations, idle-parking
# candidates). Prints a SHORT, fact-only report. Wakes MikroB (sched-wake-mikrob.sh, the same helper
# sched-cmd-weekly-usage.sh already uses) ONLY when a section is actually actionable -- a card that
# can close, a FAIL, a stuck card, a concurrency/escalation alert, or an idle-parking candidate.
# Nothing here MOVES a card or starts/stops an agent; the decision and the action stay MikroB's, this
# script only replaces the re-reading with a fact sheet (same contract gate-pretriage-card.sh already
# uses for gate input: INPUT, not verdict).
#
# Reuses existing tools, writes no new state machinery: quota-check.sh, load-guard-check.sh,
# gate-closure-check.py, fleet-concurrency-checks.sh, redispatch-guard.sh. The per-waiting-card sweep
# and the stuck-card list are NOT covered by an existing script, so they are computed here from one
# shared /api/kanban fetch (same stuck-card logic as heartbeat-consolidated SKILL.md D section,
# ported verbatim, not redesigned).
#
# Feature flag: HEARTBEAT_SCRIPTFIRST=off restores silence (the old full-prompt
# heartbeat-consolidated path is the fallback, unaffected by this script either way -- flipping the
# scheduled task to call this script instead of running the full prompt is MikroB's own wiring
# decision, not something this script does). Absent/anything else = on, same convention as
# LOCAL_FIRST_DRAFT/CARD_BUILD_ROUTE.
#
# Usage: heartbeat-scriptfirst.sh   (always exits 0 on a completed run, even when routine/silent).
# A non-zero exit means THIS SCRIPT failed -- fail-closed per the card: the caller (a command-type
# scheduled task, same shape as sched-cmd-weekly-usage.sh) must wake MikroB with the error, not swallow it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DASH="${DASH:-http://localhost:3420}"
TOKEN_FILE="$ROOT/store/.dashboard-token"

# Test seams (selftest swaps these for fakes so the run touches neither the live dashboard nor
# real tmux/system metrics -- same spirit as GPU_DRIVER_AVAILABLE_CHECK_BIN/CLEANCORE_SUITE_API).
QUOTA_BIN="${HEARTBEAT_SCRIPTFIRST_QUOTA_BIN:-$ROOT/store/quota-check.sh}"
LOADGUARD_BIN="${HEARTBEAT_SCRIPTFIRST_LOADGUARD_BIN:-$ROOT/store/load-guard-check.sh}"
CONCURRENCY_BIN="${HEARTBEAT_SCRIPTFIRST_CONCURRENCY_BIN:-$ROOT/store/fleet-concurrency-checks.sh}"
REDISPATCH_BIN="${HEARTBEAT_SCRIPTFIRST_REDISPATCH_BIN:-$ROOT/store/redispatch-guard.sh}"
GATECLOSURE_BIN="${HEARTBEAT_SCRIPTFIRST_GATECLOSURE_BIN:-$ROOT/store/gate-closure-check.py}"
WAKE_BIN="${HEARTBEAT_SCRIPTFIRST_WAKE_BIN:-$ROOT/store/sched-wake-mikrob.sh}"
STATE_FILE="${HEARTBEAT_SCRIPTFIRST_STATE_FILE:-$ROOT/store/.heartbeat-scriptfirst-last.txt}"
ACTIVE_SUBAGENTS_FILE="${HEARTBEAT_SCRIPTFIRST_ACTIVE_SUBAGENTS_FILE:-$ROOT/store/active-subagents.json}"

if [ "${HEARTBEAT_SCRIPTFIRST:-on}" = "off" ]; then
  echo "heartbeat-scriptfirst: disabled (HEARTBEAT_SCRIPTFIRST=off)"
  exit 0
fi

hf="$(mktemp)"; chmod 600 "$hf"
trap 'rm -f "$hf"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hf"
# Test seam (HEARTBEAT_SCRIPTFIRST_FIXTURE_DIR): the selftest serves fixed JSON instead of hitting
# the live dashboard, same intent as fleet-concurrency-checks.sh's --cards-file.
_get() {
  if [ -n "${HEARTBEAT_SCRIPTFIRST_FIXTURE_DIR:-}" ]; then
    case "$1" in
      /api/kanban) cat "$HEARTBEAT_SCRIPTFIRST_FIXTURE_DIR/kanban.json" 2>/dev/null ;;
      /api/agents) cat "$HEARTBEAT_SCRIPTFIRST_FIXTURE_DIR/agents.json" 2>/dev/null ;;
      /api/kanban/*/comments)
        local cid="${1#/api/kanban/}"; cid="${cid%/comments}"
        cat "$HEARTBEAT_SCRIPTFIRST_FIXTURE_DIR/comments-$cid.json" 2>/dev/null ;;
      *) echo "" ;;
    esac
    return
  fi
  curl -s --max-time 15 -H @"$hf" "${DASH}$1" 2>/dev/null
}

ACTIONABLE=0
REPORT=""
add() { REPORT="$REPORT
$1"; }

# --- 1) time ---------------------------------------------------------------------------------
add "TIME: $(date '+%Y-%m-%d %H:%M:%S %Z')"

# --- 2) quota ----------------------------------------------------------------------------------
QUOTA_OUT="$(bash "$QUOTA_BIN" 2>&1)"
add "QUOTA: $(printf '%s' "$QUOTA_OUT" | tail -3 | tr '\n' ' ')"
printf '%s\n' "$QUOTA_OUT" | grep -q '^NEW:.\+' && ACTIONABLE=1

# --- 3) weekly-limit-stop (old flag) -------------------------------------------------------------
WLS="$(cat "$ROOT/store/weekly-limit-stop.json" 2>/dev/null)"
[ -n "$WLS" ] && add "WEEKLY-LIMIT-STOP: $WLS"

# --- 4) hard-stop (new, auto-computed flag) -------------------------------------------------------
HS="$(cat "$ROOT/store/weekly-hard-stop.json" 2>/dev/null)"
if [ -n "$HS" ]; then
  HS_ACTIVE="$(printf '%s' "$HS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("active"))' 2>/dev/null)"
  HS_NEWDEV="$(printf '%s' "$HS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("newDevStopActive"))' 2>/dev/null)"
  add "HARD-STOP: active=$HS_ACTIVE newDevStopActive=$HS_NEWDEV"
fi

# --- 5) load-guard -------------------------------------------------------------------------------
LG_OUT="$(bash "$LOADGUARD_BIN" 2>&1)"
add "LOAD-GUARD: $LG_OUT"

# --- one shared kanban snapshot for 6/7/8 -------------------------------------------------------
KANBAN_JSON="$(_get /api/kanban)"

# --- 6) waiting-sweep: gate-closure-check per non-BLOKKOLT waiting card --------------------------
WAITING_IDS="$(printf '%s' "$KANBAN_JSON" | python3 -c '
import json, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
for c in cards:
    if c.get("status") == "waiting" and "BLOKKOLT" not in (c.get("title") or ""):
        print(c["id"])
' 2>/dev/null)"

AGREE_LIST=""; FAIL_LIST=""; NEEDS_HUMAN_LIST=""; NO_GATE_YET_LIST=""
FAIL_RX='^\s*(QA|CYBERSEC|WHITEHAT|CYBERED|REDHAT)\s+(FAIL|NO-?GO)\b'
VERDICT_RX='^\s*(QA|CYBERSEC|WHITEHAT|CYBERED|REDHAT)\s+(PASS|GO|FAIL|NO-?GO)\b'
for cid in $WAITING_IDS; do
  COMMENTS_JSON="$(_get "/api/kanban/$cid/comments")"
  [ -z "$COMMENTS_JSON" ] && continue
  VERDICT="$(printf '%s' "$COMMENTS_JSON" | python3 "$GATECLOSURE_BIN" 2>/dev/null)"
  case "$VERDICT" in
    AGREE\|*) AGREE_LIST="$AGREE_LIST $cid($VERDICT)" ;;
    UNLANDED\|*) AGREE_LIST="$AGREE_LIST $cid($VERDICT)" ;;
    FAILED*) FAIL_LIST="$FAIL_LIST $cid" ;;
    DISAGREE*|UNRESOLVED*|UNSUPERSEDED*|STALE*|UNVERIFIED-AUTHOR*) NEEDS_HUMAN_LIST="$NEEDS_HUMAN_LIST $cid($VERDICT)" ;;
    MISSING*)
      # MISSING on its own is normal (no verdict yet) -- only actionable if a REVIEW/done-marker
      # already exists on the card with NO verdict line at all (gate never dispatched).
      HAS_REVIEW="$(printf '%s' "$COMMENTS_JSON" | python3 -c '
import json, sys, re
try: comments = json.load(sys.stdin)
except Exception: sys.exit(0)
comments = comments if isinstance(comments, list) else (comments or {}).get("comments") or []
has_review = any(re.match(r"\s*(REVIEW|K[EÉ]SZ|DONE|ELK[EÉ]SZ[UÜ]LT|BEFEJEZ)", (c.get("content") or ""), re.I) for c in comments)
has_verdict = any(re.match(r"'"$VERDICT_RX"'", (c.get("content") or ""), re.I) for c in comments)
print("1" if (has_review and not has_verdict) else "0")
' 2>/dev/null)"
      [ "$HAS_REVIEW" = "1" ] && NO_GATE_YET_LIST="$NO_GATE_YET_LIST $cid"
      ;;
  esac
  # explicit FAIL/NO-GO first-line scan regardless of the AGREE/DISAGREE question above, since
  # gate-closure-check.py answers "do the verdicts AGREE on the sha", not "did any of them fail".
  HAS_FAIL="$(printf '%s' "$COMMENTS_JSON" | python3 -c '
import json, sys, re
try: comments = json.load(sys.stdin)
except Exception: sys.exit(0)
comments = comments if isinstance(comments, list) else (comments or {}).get("comments") or []
rx = re.compile(r"'"$FAIL_RX"'", re.I)
print("1" if any(rx.match((c.get("content") or "")) for c in comments) else "0")
' 2>/dev/null)"
  [ "$HAS_FAIL" = "1" ] && FAIL_LIST="$FAIL_LIST $cid"
done
[ -n "$AGREE_LIST" ] && { add "WAITING-SWEEP AGREE/UNLANDED (close or land):$AGREE_LIST"; ACTIONABLE=1; }
[ -n "$FAIL_LIST" ] && { add "WAITING-SWEEP FAIL/NO-GO (re-dispatch):$FAIL_LIST"; ACTIONABLE=1; }
[ -n "$NEEDS_HUMAN_LIST" ] && { add "WAITING-SWEEP needs-human (DISAGREE/STALE/UNRESOLVED/UNSUPERSEDED/UNVERIFIED-AUTHOR):$NEEDS_HUMAN_LIST"; ACTIONABLE=1; }
[ -n "$NO_GATE_YET_LIST" ] && { add "WAITING-SWEEP REVIEW-no-gate-dispatched-yet:$NO_GATE_YET_LIST"; ACTIONABLE=1; }

# --- 7) stuck-card list (heartbeat-consolidated D section logic, ported verbatim) ----------------
STUCK="$(printf '%s' "$KANBAN_JSON" | python3 -c "
import json, sys, time, os
cards = json.load(sys.stdin)
now = time.time()
sp = '$ACTIVE_SUBAGENTS_FILE'
act = set(json.load(open(sp))) if os.path.exists(sp) else set()
parents = set(c.get('parent_id') for c in cards if c.get('parent_id'))
stuck = [c for c in cards if c.get('status') == 'in_progress' and c.get('id') not in parents
         and (now - c.get('updated_at', now)) > 600
         and ((c.get('assignee') not in act) or (now - c.get('updated_at', now)) > 2400)]
print(json.dumps([{'id': c['id'], 'assignee': c.get('assignee'), 'mins': round((now - c['updated_at']) / 60)} for c in stuck], ensure_ascii=False))
" 2>/dev/null)"
if [ -n "$STUCK" ] && [ "$STUCK" != "[]" ]; then
  add "STUCK: $STUCK"
  ACTIONABLE=1
fi

# --- 8) multi-in-progress -------------------------------------------------------------------------
MIP="$(bash "$CONCURRENCY_BIN" multi-in-progress 2>&1)"
add "MULTI-IN-PROGRESS: $MIP"
printf '%s' "$MIP" | grep -q '^ALERT:yes' && ACTIONABLE=1

# --- 9) busy-report ----------------------------------------------------------------------------
BUSY="$(bash "$REDISPATCH_BIN" busy-report 2>&1)"
add "BUSY-REPORT: $BUSY"
case "$BUSY" in ''|'[]') : ;; *) ACTIONABLE=1 ;; esac

# --- 10) escalations -------------------------------------------------------------------------------
ESC="$(bash "$REDISPATCH_BIN" escalations 2>&1)"
add "ESCALATIONS: $ESC"
case "$ESC" in ''|'[]') : ;; *) ACTIONABLE=1 ;; esac

# --- 11) idle-parking candidates (rule 7: idle-de-futo agent kell parkolni) -----------------------
AGENTS_JSON="$(_get /api/agents)"
cards_f="$(mktemp)"; agents_f="$(mktemp)"
printf '%s' "$KANBAN_JSON" > "$cards_f"
printf '%s' "$AGENTS_JSON" > "$agents_f"
IDLE_CANDIDATES="$(python3 -c "
import json, sys
try:
    cards = json.load(open('$cards_f'))
    agents = json.load(open('$agents_f'))
except Exception:
    print(''); sys.exit(0)
gate_agents = {'qa', 'qa2', 'cybersec', 'cybersec2', 'cybered'}
running = [a.get('name') or a.get('agent_id') for a in agents if a.get('running')]
has_in_progress = {c.get('assignee') for c in cards if c.get('status') == 'in_progress'}
waiting_review_assignees = {c.get('assignee') for c in cards if c.get('status') == 'waiting'}
idle = [a for a in running if a and a != 'mikrob' and a not in gate_agents
        and a not in has_in_progress and a not in waiting_review_assignees]
print(' '.join(idle))
" 2>/dev/null)"
rm -f "$cards_f" "$agents_f"
if [ -n "$IDLE_CANDIDATES" ]; then
  add "IDLE-PARK-CANDIDATES:$IDLE_CANDIDATES"
  ACTIONABLE=1
fi

# --- diff against previous run (card 6d0775bb: "kimenetuk diffelve az elozo korhoz") --------------
# The TIME line changes every second by construction -- excluded from the comparison, or every
# single run would read as "changed" regardless of anything that actually happened.
PREV="$(cat "$STATE_FILE" 2>/dev/null || true)"
PREV_BODY="$(printf '%s' "$PREV" | grep -v '^TIME:')"
CUR_BODY="$(printf '%s' "$REPORT" | grep -v '^TIME:')"
CHANGED=0
[ "$PREV_BODY" != "$CUR_BODY" ] && CHANGED=1
printf '%s\n' "$REPORT" > "$STATE_FILE"

if [ "$ACTIONABLE" = "1" ] || [ "$CHANGED" = "1" ]; then
  if [ "$ACTIONABLE" = "1" ]; then
    bash "$WAKE_BIN" heartbeat-scriptfirst "Dontes kell (heartbeat-consolidated B/C/D szekcio alapjan).$REPORT"
  fi
  echo "heartbeat-scriptfirst: actionable=$ACTIONABLE changed=$CHANGED"
  printf '%s\n' "$REPORT"
else
  echo "heartbeat-scriptfirst: routine, no change, silent"
fi
exit 0
