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
# FAIL-CLOSED MODEL (WhiteHat NO-GO, comment 17654, F1 HIGH): this is an ALLOWLIST, not a denylist --
# the sched-cmd-weekly-usage.sh pattern. Silence requires every section to be AFFIRMATIVELY ok
# (expected shape, rc==0, recognised verdict token). Anything unrecognised, any tool rc!=0, a broken
# /api/kanban snapshot, an unparseable active-subagents.json, an unrecognised gate-closure-check.py
# verdict (NOSHA/UNREADABLE go to needs-human, not silence) -- all of these wake MikroB with an ERR
# line, they do not fall through a case statement into quiet. A failed WAKE itself (F1c) makes the
# SCRIPT exit non-zero so the caller's own fail-closed contract (see Usage below) escalates it, and
# the report is persisted to a pending file first so the signals inside it are not lost.
#
# F2 (MEDIUM, comment 17654): the FAIL/NO-GO list comes ONLY from gate-closure-check.py's own FAILED
# verdict (latest-per-gate, so a superseded old NO-GO does not re-fire once a later PASS/GO exists).
# The old raw regex scan over every historical comment line is removed -- it could not tell a current
# FAIL from an already-overridden one.
#
# F3 (LOW, comment 17654): a BLOKKOLT-titled waiting card is NOT skipped. It goes through the same
# gate-closure-check.py sweep as every other waiting card, listed in its own
# "WAITING-SWEEP BLOKKOLT" line so it stays visible (not auto-closed, not auto-redispatched -- the
# SKILL B section's "egyszer annotálva" contract, carried by the normal CHANGED-diff so it does not
# re-wake every single tick while the block itself does not change).
#
# Feature flag: HEARTBEAT_SCRIPTFIRST=off restores silence (the old full-prompt
# heartbeat-consolidated path is the fallback, unaffected by this script either way -- flipping the
# scheduled task to call this script instead of running the full prompt is MikroB's own wiring
# decision, not something this script does). Absent/anything else = on, same convention as
# LOCAL_FIRST_DRAFT/CARD_BUILD_ROUTE.
#
# Usage: heartbeat-scriptfirst.sh   (exit 0 = completed run, routine or actionable, wake delivered).
# A non-zero exit means THIS SCRIPT (or its wake delivery) failed -- fail-closed per the card: the
# caller (a command-type scheduled task, same shape as sched-cmd-weekly-usage.sh) must wake MikroB
# with the error, not swallow it.
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
PENDING_FILE="${HEARTBEAT_SCRIPTFIRST_PENDING_FILE:-$ROOT/store/.heartbeat-scriptfirst-pending.txt}"
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

# $1 = json string -> prints "1" if it parses as a JSON array, else "0" (never raises).
_json_is_array() {
  printf '%s' "$1" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("0"); sys.exit(0)
print("1" if isinstance(d, list) else "0")
' 2>/dev/null
}

ACTIONABLE=0
REPORT=""
add() { REPORT="$REPORT
$1"; }
# Allowlist model (F1): anything that does not provably match a known-ok shape wakes, via err().
err() { add "ERR: $1"; ACTIONABLE=1; }

# --- 1) time ---------------------------------------------------------------------------------
add "TIME: $(date '+%Y-%m-%d %H:%M:%S %Z')"

# --- 2) quota ----------------------------------------------------------------------------------
QUOTA_OUT="$(bash "$QUOTA_BIN" 2>&1)"; QUOTA_RC=$?
add "QUOTA: $(printf '%s' "$QUOTA_OUT" | tail -3 | tr '\n' ' ')"
if [ "$QUOTA_RC" -ne 0 ]; then
  err "quota-check.sh exited $QUOTA_RC"
elif printf '%s\n' "$QUOTA_OUT" | grep -q '^NEW:.\+'; then
  ACTIONABLE=1
elif ! printf '%s\n' "$QUOTA_OUT" | grep -q '^NEW:'; then
  err "quota-check.sh output did not contain the expected NEW: line"
fi

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
LG_OUT="$(bash "$LOADGUARD_BIN" 2>&1)"; LG_RC=$?
add "LOAD-GUARD: $LG_OUT"
if [ "$LG_RC" -gt 1 ]; then
  err "load-guard-check.sh exited $LG_RC"
elif ! printf '%s' "$LG_OUT" | grep -qE '^(ADMIT|HOLD)\b'; then
  err "load-guard-check.sh output unrecognised: $LG_OUT"
fi

# --- one shared kanban snapshot for 6/7/11 -------------------------------------------------------
KANBAN_JSON="$(_get /api/kanban)"
KANBAN_OK="$(_json_is_array "$KANBAN_JSON")"
if [ "$KANBAN_OK" != "1" ]; then
  err "/api/kanban fetch failed or did not return a JSON array"
fi

# --- 6) waiting-sweep: gate-closure-check per waiting card (BLOKKOLT included, F3) ---------------
if [ "$KANBAN_OK" = "1" ]; then
  WAITING_IDS="$(printf '%s' "$KANBAN_JSON" | python3 -c '
import json, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
for c in cards:
    if c.get("status") == "waiting":
        blocked = "1" if "BLOKKOLT" in (c.get("title") or "") else "0"
        print(c["id"] + "|" + blocked)
' 2>/dev/null)"

  AGREE_LIST=""; FAIL_LIST=""; NEEDS_HUMAN_LIST=""; NO_GATE_YET_LIST=""; BLOCKED_LIST=""
  VERDICT_RX='^\s*(QA|CYBERSEC|WHITEHAT|CYBERED|REDHAT)\s+(PASS|GO|FAIL|NO-?GO)\b'
  while IFS='|' read -r cid blocked; do
    [ -z "$cid" ] && continue
    COMMENTS_JSON="$(_get "/api/kanban/$cid/comments")"
    if [ -z "$COMMENTS_JSON" ]; then
      err "waiting-sweep: could not fetch comments for $cid"
      continue
    fi
    VERDICT="$(printf '%s' "$COMMENTS_JSON" | python3 "$GATECLOSURE_BIN" 2>/dev/null)"; VERDICT_RC=$?
    if [ "$VERDICT_RC" -ne 0 ] || [ -z "$VERDICT" ]; then
      err "waiting-sweep: gate-closure-check.py failed on $cid (rc=$VERDICT_RC)"
      continue
    fi
    if [ "$blocked" = "1" ]; then
      BLOCKED_LIST="$BLOCKED_LIST $cid($VERDICT)"
      continue
    fi
    case "$VERDICT" in
      AGREE\|*|UNLANDED\|*) AGREE_LIST="$AGREE_LIST $cid($VERDICT)" ;;
      FAILED*) FAIL_LIST="$FAIL_LIST $cid($VERDICT)" ;;
      DISAGREE*|UNRESOLVED*|UNSUPERSEDED*|STALE*|UNVERIFIED-AUTHOR*|NOSHA*|UNREADABLE*)
        NEEDS_HUMAN_LIST="$NEEDS_HUMAN_LIST $cid($VERDICT)" ;;
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
      *) err "waiting-sweep: unrecognised gate-closure-check.py verdict for $cid: $VERDICT" ;;
    esac
  done <<<"$WAITING_IDS"
  [ -n "$AGREE_LIST" ] && { add "WAITING-SWEEP AGREE/UNLANDED (close or land):$AGREE_LIST"; ACTIONABLE=1; }
  [ -n "$FAIL_LIST" ] && { add "WAITING-SWEEP FAIL/NO-GO (re-dispatch):$FAIL_LIST"; ACTIONABLE=1; }
  [ -n "$NEEDS_HUMAN_LIST" ] && { add "WAITING-SWEEP needs-human (DISAGREE/STALE/UNRESOLVED/UNSUPERSEDED/UNVERIFIED-AUTHOR/NOSHA/UNREADABLE):$NEEDS_HUMAN_LIST"; ACTIONABLE=1; }
  [ -n "$NO_GATE_YET_LIST" ] && { add "WAITING-SWEEP REVIEW-no-gate-dispatched-yet:$NO_GATE_YET_LIST"; ACTIONABLE=1; }
  [ -n "$BLOCKED_LIST" ] && add "WAITING-SWEEP BLOKKOLT (kotott-blokk, annotalva, nem auto-zarhato):$BLOCKED_LIST"
fi

# --- 7) stuck-card list (heartbeat-consolidated D section logic, ported verbatim) ----------------
if [ "$KANBAN_OK" = "1" ]; then
  STUCK_RAW="$(printf '%s' "$KANBAN_JSON" | python3 -c "
import json, sys, time, os
try:
    cards = json.load(sys.stdin)
    now = time.time()
    sp = '$ACTIVE_SUBAGENTS_FILE'
    act = set(json.load(open(sp))) if os.path.exists(sp) else set()
    parents = set(c.get('parent_id') for c in cards if c.get('parent_id'))
    stuck = [c for c in cards if c.get('status') == 'in_progress' and c.get('id') not in parents
             and (now - c.get('updated_at', now)) > 600
             and ((c.get('assignee') not in act) or (now - c.get('updated_at', now)) > 2400)]
    print('OK ' + json.dumps([{'id': c['id'], 'assignee': c.get('assignee'), 'mins': round((now - c['updated_at']) / 60)} for c in stuck], ensure_ascii=False))
except Exception as e:
    print('ERR ' + str(e))
" 2>&1)"
  case "$STUCK_RAW" in
    "OK "*)
      STUCK="${STUCK_RAW#OK }"
      if [ -n "$STUCK" ] && [ "$STUCK" != "[]" ]; then
        add "STUCK: $STUCK"
        ACTIONABLE=1
      fi
      ;;
    *) err "stuck-card check failed: $STUCK_RAW" ;;
  esac
fi

# --- 8) multi-in-progress -------------------------------------------------------------------------
MIP="$(bash "$CONCURRENCY_BIN" multi-in-progress 2>&1)"; MIP_RC=$?
add "MULTI-IN-PROGRESS: $MIP"
MIP_HEAD="$(printf '%s' "$MIP" | head -1)"
if [ "$MIP_RC" -ne 0 ] || ! printf '%s' "$MIP_HEAD" | grep -qE '^ALERT:(yes|no)\b'; then
  err "fleet-concurrency-checks.sh multi-in-progress failed/unexpected output (rc=$MIP_RC)"
elif printf '%s' "$MIP_HEAD" | grep -q '^ALERT:yes'; then
  ACTIONABLE=1
fi

# --- 9) busy-report ----------------------------------------------------------------------------
BUSY="$(bash "$REDISPATCH_BIN" busy-report 2>&1)"; BUSY_RC=$?
add "BUSY-REPORT: $BUSY"
if [ "$BUSY_RC" -ne 0 ]; then
  err "redispatch-guard.sh busy-report failed (rc=$BUSY_RC)"
else
  case "$BUSY" in
    ''|'[]') : ;;
    '['*']') ACTIONABLE=1 ;;
    *) err "redispatch-guard.sh busy-report unexpected output: $BUSY" ;;
  esac
fi

# --- 10) escalations -------------------------------------------------------------------------------
ESC="$(bash "$REDISPATCH_BIN" escalations 2>&1)"; ESC_RC=$?
add "ESCALATIONS: $ESC"
if [ "$ESC_RC" -ne 0 ]; then
  err "redispatch-guard.sh escalations failed (rc=$ESC_RC)"
else
  case "$ESC" in
    ''|'[]') : ;;
    '['*']') ACTIONABLE=1 ;;
    *) err "redispatch-guard.sh escalations unexpected output: $ESC" ;;
  esac
fi

# --- 11) idle-parking candidates (rule 7: idle-de-futo agent kell parkolni) -----------------------
AGENTS_JSON="$(_get /api/agents)"
AGENTS_OK="$(_json_is_array "$AGENTS_JSON")"
if [ "$AGENTS_OK" != "1" ]; then
  err "/api/agents fetch failed or did not return a JSON array"
elif [ "$KANBAN_OK" = "1" ]; then
  cards_f="$(mktemp)"; agents_f="$(mktemp)"
  printf '%s' "$KANBAN_JSON" > "$cards_f"
  printf '%s' "$AGENTS_JSON" > "$agents_f"
  IDLE_RAW="$(python3 -c "
import json, sys
try:
    cards = json.load(open('$cards_f'))
    agents = json.load(open('$agents_f'))
    gate_agents = {'qa', 'qa2', 'cybersec', 'cybersec2', 'cybered'}
    running = [a.get('name') or a.get('agent_id') for a in agents if a.get('running')]
    has_in_progress = {c.get('assignee') for c in cards if c.get('status') == 'in_progress'}
    waiting_review_assignees = {c.get('assignee') for c in cards if c.get('status') == 'waiting'}
    idle = [a for a in running if a and a != 'mikrob' and a not in gate_agents
            and a not in has_in_progress and a not in waiting_review_assignees]
    print('OK ' + ' '.join(idle))
except Exception as e:
    print('ERR ' + str(e))
" 2>&1)"
  rm -f "$cards_f" "$agents_f"
  case "$IDLE_RAW" in
    "OK "*)
      IDLE_CANDIDATES="${IDLE_RAW#OK }"
      if [ -n "$IDLE_CANDIDATES" ]; then
        add "IDLE-PARK-CANDIDATES:$IDLE_CANDIDATES"
        ACTIONABLE=1
      fi
      ;;
    *) err "idle-park check failed: $IDLE_RAW" ;;
  esac
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
    WAKE_RC=$?
    if [ "$WAKE_RC" -ne 0 ]; then
      # F1c: a failed wake must not silently lose the signals it carried (busy-report/escalations
      # are read-and-clear downstream) -- persist the report, then fail-closed so the caller's own
      # command-type contract (see Usage above) escalates with the error.
      { date '+%Y-%m-%d %H:%M:%S %Z'; printf '%s\n' "$REPORT"; echo "---"; } >> "$PENDING_FILE"
      echo "heartbeat-scriptfirst: WAKE-FAILED rc=$WAKE_RC -- report appended to $PENDING_FILE"
      printf '%s\n' "$REPORT"
      exit 1
    fi
  fi
  echo "heartbeat-scriptfirst: actionable=$ACTIONABLE changed=$CHANGED"
  printf '%s\n' "$REPORT"
else
  echo "heartbeat-scriptfirst: routine, no change, silent"
fi
exit 0
