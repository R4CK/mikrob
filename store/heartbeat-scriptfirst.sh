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
HARDSTOP_FILE="${HEARTBEAT_SCRIPTFIRST_HARDSTOP_FILE:-$ROOT/store/weekly-hard-stop.json}"
# card d8f44d15 req 3: fixture seam for /api/token-usage/daily-lag, same style as _get's
# FIXTURE_DIR -- a plain file holding the JSON body, read instead of curled when set.
TOKENLAG_FIXTURE="${HEARTBEAT_SCRIPTFIRST_TOKENLAG_FIXTURE:-}"
# F1 (card b7fe4a95, WhiteHat2 F1/N3): a SUSTAINED state (hard-stop/newDevStop/load-guard HOLD held
# constant for days during a weekly stop) used to wake MikroB on every single tick, because
# ACTIONABLE was set from the STATE directly and that bypasses the CHANGED-diff dedup entirely
# (see the final if-block: ACTIONABLE wakes regardless of CHANGED). Fix: wake only on the
# TRANSITION (this tick's value differs from the value recorded on the PREVIOUS tick), tracked in
# a tiny separate state file so a flag kept constant for 1000 ticks wakes exactly once (on entry).
FLAGS_STATE_FILE="${HEARTBEAT_SCRIPTFIRST_FLAGS_STATE_FILE:-$ROOT/store/.heartbeat-scriptfirst-flags-last.txt}"
# Defaults are the NORMAL/no-anomaly state, not empty: on a cold start (no flags-state file yet)
# this must compare against "nothing was ever wrong" so a routine first tick (active=False,
# ADMIT) does not itself register as a transition and force a spurious wake -- only an actual
# first-observed anomaly (True/HOLD) differs from this baseline and correctly still wakes, same
# as the pre-fix behaviour did unconditionally on any active=True tick.
PREV_HS_ACTIVE="False"
PREV_HS_NEWDEV="False"
PREV_LG_VERDICT="ADMIT"
if [ -f "$FLAGS_STATE_FILE" ]; then
  while IFS='=' read -r _flag_k _flag_v; do
    case "$_flag_k" in
      HS_ACTIVE) PREV_HS_ACTIVE="$_flag_v" ;;
      HS_NEWDEV) PREV_HS_NEWDEV="$_flag_v" ;;
      LG_VERDICT) PREV_LG_VERDICT="$_flag_v" ;;
    esac
  done < "$FLAGS_STATE_FILE"
fi
# This tick's values, written back at the end -- empty/"unset" means "not computed this tick",
# so a transient error elsewhere does not blow away a previously-known value and cause a false
# transition the next time the flag is actually readable again.
CUR_HS_ACTIVE="__unset__"
CUR_HS_NEWDEV="__unset__"
CUR_LG_VERDICT="__unset__"

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
HS="$(cat "$HARDSTOP_FILE" 2>/dev/null)"
if [ -n "$HS" ]; then
  HS_ACTIVE="$(printf '%s' "$HS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("active"))' 2>/dev/null)"
  HS_NEWDEV="$(printf '%s' "$HS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("newDevStopActive"))' 2>/dev/null)"
  add "HARD-STOP: active=$HS_ACTIVE newDevStopActive=$HS_NEWDEV"
  # N3 (card 1c8f6d25): either flag being on used to just be a line in the report, never flagged
  # ACTIONABLE -- so a flip into hard-stop or newDevStop only woke MikroB if some OTHER section
  # happened to be actionable too.
  # F1 (card b7fe4a95): the original "fix" set ACTIONABLE=1 from the STATE itself, so a SUSTAINED
  # hard-stop/newDevStop (the normal case -- a weekly stop lasts days) woke MikroB on every single
  # tick, which is exactly the token-burning problem this whole script exists to solve. Wake only
  # on the TRANSITION: this tick's value differs from the previous tick's recorded value.
  CUR_HS_ACTIVE="$HS_ACTIVE"
  CUR_HS_NEWDEV="$HS_NEWDEV"
  [ "$HS_ACTIVE" != "$PREV_HS_ACTIVE" ] && ACTIONABLE=1
  [ "$HS_NEWDEV" != "$PREV_HS_NEWDEV" ] && ACTIONABLE=1
fi

# --- 5) load-guard -------------------------------------------------------------------------------
LG_OUT="$(bash "$LOADGUARD_BIN" 2>&1)"; LG_RC=$?
add "LOAD-GUARD: $LG_OUT"
if [ "$LG_RC" -gt 1 ]; then
  err "load-guard-check.sh exited $LG_RC"
elif ! printf '%s' "$LG_OUT" | grep -qE '^(ADMIT|HOLD)\b'; then
  err "load-guard-check.sh output unrecognised: $LG_OUT"
else
  # N3: a HOLD verdict was a recognised (non-err) shape, so it never woke MikroB either.
  # F1 (card b7fe4a95): sustained HOLD (every tick, for the duration of a load-guard hold) used
  # to wake every tick for the same STATE-vs-TRANSITION reason as the hard-stop flags above --
  # wake only when the verdict differs from the previous tick's.
  CUR_LG_VERDICT="$(printf '%s' "$LG_OUT" | grep -oE '^(ADMIT|HOLD)\b' | head -1)"
  [ "$CUR_LG_VERDICT" != "$PREV_LG_VERDICT" ] && ACTIONABLE=1
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
# N1 (card 1c8f6d25): a REVIEW whose Gate-SHA line (rule 4b) precedes the word REVIEW used to be
# invisible here, because this only matched REVIEW at content[0]. Skip the same leading
# Gate-SHA:/Skills: lines gate-closure-check.py already skips (_LEAD_SKIP) before matching.
# NO separate blank-line alternative here (WhiteHat2 pin gap, card b7fe4a95): the consuming
# has_review regex below already starts with its own `\s*`, so a bare blank line -- alone, or as
# the leftover after the Gate-SHA:/Skills: branches have already consumed their own lines -- is
# always absorbed there regardless. Measured directly: adding a `|\s*\n` alternative here changes
# the outcome of NO case (dead code), so it is left out rather than kept as a pin-gap no mutant
# can distinguish.
LEAD_SKIP = re.compile(r"^(?:\s*Gate-SHA:[^\n]*\n|\s*Skills:[^\n]*\n)*", re.I)
def body(content):
    content = content or ""
    return content[LEAD_SKIP.match(content).end():]
has_review = any(re.match(r"\s*(REVIEW|K[EÉ]SZ|DONE|ELK[EÉ]SZ[UÜ]LT|BEFEJEZ)", body(c.get("content")), re.I) for c in comments)
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

# F1: persist this tick's flag values for the NEXT tick's transition comparison. Only overwrites a
# key that was actually computed this tick (the "__unset__" sentinel means "skip, carry the old
# value forward") -- a transient error (e.g. HARDSTOP_FILE briefly unreadable) must not erase the
# last-known value and manufacture a false transition once it is readable again.
{
  [ "$CUR_HS_ACTIVE" != "__unset__" ] && printf 'HS_ACTIVE=%s\n' "$CUR_HS_ACTIVE" || { [ -n "$PREV_HS_ACTIVE" ] && printf 'HS_ACTIVE=%s\n' "$PREV_HS_ACTIVE"; }
  [ "$CUR_HS_NEWDEV" != "__unset__" ] && printf 'HS_NEWDEV=%s\n' "$CUR_HS_NEWDEV" || { [ -n "$PREV_HS_NEWDEV" ] && printf 'HS_NEWDEV=%s\n' "$PREV_HS_NEWDEV"; }
  [ "$CUR_LG_VERDICT" != "__unset__" ] && printf 'LG_VERDICT=%s\n' "$CUR_LG_VERDICT" || { [ -n "$PREV_LG_VERDICT" ] && printf 'LG_VERDICT=%s\n' "$PREV_LG_VERDICT"; }
  true
} > "$FLAGS_STATE_FILE"

# --- N4 (card 1c8f6d25): replay a previously FAILED wake's report, instead of leaving it stuck in
# --- PENDING_FILE forever. Read-and-clear here so a wake that fails AGAIN re-appends fresh (below)
# --- rather than this block re-reading the same backlog on every future tick.
# F2 (card b7fe4a95): the backlog used to be replayed WHOLE and the append side had no cap, so a
# backlog above ~128 KB (MAX_ARG_STRLEN) made the wake fail with E2BIG forever, with no recovery
# short of a manual purge, and each further failed tick appended the whole (already-huge) report
# again, growing it further. Cap the replay to the last PENDING_CAP_BYTES, with a byte count of
# the full backlog so nothing is silently lost from the report (just truncated, with that said).
PENDING_CAP_BYTES="${HEARTBEAT_SCRIPTFIRST_PENDING_CAP_BYTES:-8192}"
PENDING_BACKLOG_RAW="$(cat "$PENDING_FILE" 2>/dev/null || true)"
if [ -n "$PENDING_BACKLOG_RAW" ]; then
  : > "$PENDING_FILE"
  ACTIONABLE=1
  PENDING_BACKLOG_BYTES=$(printf '%s' "$PENDING_BACKLOG_RAW" | wc -c)
  PENDING_BACKLOG="$(printf '%s' "$PENDING_BACKLOG_RAW" | tail -c "$PENDING_CAP_BYTES")"
  add "PENDING-REPLAY (korabban sikertelen wake, most ujra probalva, ${PENDING_BACKLOG_BYTES} B teljes, utolso ${PENDING_CAP_BYTES} B):"
  add "$PENDING_BACKLOG"
fi

# --- 12) token_usage_daily staleness (card d8f44d15 req 3): classifyTokenPruneLag already --------
# existed (HBDBKUSZOB823) but was never called from anywhere -- a guard nobody reads is not a
# guard. ACTIONABLE only on 'stale' (a real multi-sweep-cycle miss); 'ok'/'empty' are silent,
# 'invalid' is a config fault and wakes via err() same as any other allowlist miss.
if [ -n "$TOKENLAG_FIXTURE" ]; then
  TOKENLAG_JSON="$(cat "$TOKENLAG_FIXTURE" 2>/dev/null)"
else
  TOKENLAG_JSON="$(curl -s --max-time 15 -H @"$hf" "${DASH}/api/token-usage/daily-lag" 2>/dev/null)"
fi
TOKENLAG_STATE="$(printf '%s' "$TOKENLAG_JSON" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("state", ""))
except Exception: print("")
' 2>/dev/null)"
case "$TOKENLAG_STATE" in
  ok|empty) add "TOKEN-USAGE-DAILY-LAG: $TOKENLAG_JSON" ;;
  stale) add "TOKEN-USAGE-DAILY-LAG: $TOKENLAG_JSON"; ACTIONABLE=1 ;;
  invalid) err "token-usage daily-lag reports invalid config: $TOKENLAG_JSON" ;;
  *) err "token-usage daily-lag fetch failed or unrecognised: $TOKENLAG_JSON" ;;
esac

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
      # F2 (card b7fe4a95): cap the APPEND side the same way as the read side above -- otherwise a
      # run of failed ticks grows this file by one whole report each time, with no bound, straight
      # back into the E2BIG hole this fix exists to close.
      { date '+%Y-%m-%d %H:%M:%S %Z'; printf '%s\n' "$REPORT"; echo "---"; } >> "$PENDING_FILE"
      if [ "$(wc -c < "$PENDING_FILE" 2>/dev/null || echo 0)" -gt "$PENDING_CAP_BYTES" ]; then
        tail -c "$PENDING_CAP_BYTES" "$PENDING_FILE" > "${PENDING_FILE}.tmp" && mv "${PENDING_FILE}.tmp" "$PENDING_FILE"
      fi
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
