#!/usr/bin/env bash
# heartbeat-scriptfirst.selftest.sh -- controls for heartbeat-scriptfirst.sh (card 6d0775bb).
# Every case runs against FAKE tool stand-ins and fixture JSON, so it never touches the live
# dashboard, tmux, or real system load. Usage: store/heartbeat-scriptfirst.selftest.sh (exit 0=PASS).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/heartbeat-scriptfirst.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { # $1=label $2=needle $3=haystack
  case "$3" in *"$2"*) echo "  ok   $1" ;; *) echo "  FAIL $1 -> needle '$2' not in output"; fail=1 ;; esac
}
check_absent() { # $1=label $2=needle $3=haystack
  case "$3" in *"$2"*) echo "  FAIL $1 -> needle '$2' unexpectedly present"; fail=1 ;; *) echo "  ok   $1" ;; esac
}

mkdir -p "$TMP/fixtures"
cat > "$TMP/quota-ok.sh" <<'EOF'
#!/usr/bin/env bash
echo "RECOVERED-STALE:"
echo "NEW:"
echo "CURRENT:"
EOF
cat > "$TMP/quota-new.sh" <<'EOF'
#!/usr/bin/env bash
echo "RECOVERED-STALE:"
echo "NEW:backend"
echo "CURRENT:"
EOF
cat > "$TMP/loadguard-admit.sh" <<'EOF'
#!/usr/bin/env bash
echo "ADMIT log_only"
EOF
cat > "$TMP/concurrency-no.sh" <<'EOF'
#!/usr/bin/env bash
echo "ALERT:no (nothing to see)"
EOF
cat > "$TMP/redispatch-empty.sh" <<'EOF'
#!/usr/bin/env bash
echo "[]"
EOF
cat > "$TMP/wake-recorder.sh" <<'EOF'
#!/usr/bin/env bash
echo "WOKE: $*" >> "$WAKE_CALLS"
EOF
# Fakes the real gate-closure-check.py's verdict, decoupled from its own landedness check (which
# needs a real git clone containing the sha -- out of scope for this script's OWN selftest, that
# tool already has gate-closure-check.selftest.py for itself).
cat > "$TMP/gateclosure-agree.py" <<'EOF'
#!/usr/bin/env python3
print("AGREE|abc1234")
EOF
chmod +x "$TMP"/*.sh "$TMP/gateclosure-agree.py"

common_env() { # $1 = case name -- own state/wake/active files per case, no cross-case diff pollution
  local case_name="${1:?case name required}"
  export HEARTBEAT_SCRIPTFIRST_LOADGUARD_BIN="$TMP/loadguard-admit.sh"
  export HEARTBEAT_SCRIPTFIRST_CONCURRENCY_BIN="$TMP/concurrency-no.sh"
  export HEARTBEAT_SCRIPTFIRST_REDISPATCH_BIN="$TMP/redispatch-empty.sh"
  export HEARTBEAT_SCRIPTFIRST_GATECLOSURE_BIN="$HERE/gate-closure-check.py"
  export HEARTBEAT_SCRIPTFIRST_WAKE_BIN="$TMP/wake-recorder.sh"
  export HEARTBEAT_SCRIPTFIRST_STATE_FILE="$TMP/state-$case_name.txt"
  export HEARTBEAT_SCRIPTFIRST_ACTIVE_SUBAGENTS_FILE="$TMP/active-subagents-$case_name.json"
  export HEARTBEAT_SCRIPTFIRST_FIXTURE_DIR="$TMP/fixtures"
  export WAKE_CALLS="$TMP/wake-calls-$case_name.txt"
  : > "$WAKE_CALLS"
  echo '[]' > "$HEARTBEAT_SCRIPTFIRST_ACTIVE_SUBAGENTS_FILE"
}

echo "heartbeat-scriptfirst controls"

# --- 1. ROUTINE: nothing actionable, no cards, ADMIT/empty everywhere -> silent, no wake ---------
# (first run of a fresh state file always reports changed=1 -- that is correct, there is no
# "previous round" yet -- so the silent assertion is on the SECOND run, same baseline.)
common_env routine
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
echo '[]' > "$TMP/fixtures/kanban.json"
echo '[]' > "$TMP/fixtures/agents.json"
bash "$BIN" >/dev/null 2>&1
OUT="$(bash "$BIN" 2>&1)"
check "routine: silent marker" "routine, no change, silent" "$OUT"
check_absent "routine: no wake" "WOKE" "$(cat "$WAKE_CALLS")"

# --- 2. QUOTA NEW -> actionable, wakes MikroB ------------------------------------------------------
common_env quotanew
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-new.sh"
echo '[]' > "$TMP/fixtures/kanban.json"
echo '[]' > "$TMP/fixtures/agents.json"
OUT="$(bash "$BIN" 2>&1)"
check "quota-new: actionable=1" "actionable=1" "$OUT"
check "quota-new: wake recorded" "WOKE" "$(cat "$WAKE_CALLS")"

# --- 3. WAITING-SWEEP AGREE (closable card) -> actionable, wake mentions the card id --------------
common_env agree
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
export HEARTBEAT_SCRIPTFIRST_GATECLOSURE_BIN="$TMP/gateclosure-agree.py"
python3 -c "
import json
cards = [{'id':'cardAAA','status':'waiting','title':'some card','assignee':'backend','parent_id':None,'updated_at':0}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([], open('$TMP/fixtures/agents.json','w'))
comments = [
  {'author':'backend','content':'REVIEW: done\nGate-SHA: abc1234'},
  {'author':'qa','content':'QA PASS\nGate-SHA: abc1234'},
  {'author':'cybersec','content':'CYBERSEC GO\nGate-SHA: abc1234'},
]
json.dump(comments, open('$TMP/fixtures/comments-cardAAA.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "agree: actionable=1" "actionable=1" "$OUT"
check "agree: card id surfaced" "cardAAA" "$OUT"
check "agree: wake mentions AGREE" "AGREE" "$(cat "$WAKE_CALLS")"

# --- 4. WAITING-SWEEP explicit NO-GO -> FAIL/re-dispatch surfaced -----------------------------------
common_env nogo
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
python3 -c "
import json
cards = [{'id':'cardBBB','status':'waiting','title':'some card','assignee':'backend','parent_id':None,'updated_at':0}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([], open('$TMP/fixtures/agents.json','w'))
comments = [
  {'author':'backend','content':'REVIEW: done\nGate-SHA: def5678'},
  {'author':'cybersec','content':'CYBERSEC NO-GO\nGate-SHA: def5678\nexploit found'},
]
json.dump(comments, open('$TMP/fixtures/comments-cardBBB.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "no-go: FAIL list" "FAIL/NO-GO" "$OUT"
check "no-go: card id surfaced" "cardBBB" "$OUT"

# --- 5. WAITING card with REVIEW but NO gate verdict at all -> no-gate-dispatched-yet ---------------
common_env nogateyet
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
python3 -c "
import json
cards = [{'id':'cardCCC','status':'waiting','title':'some card','assignee':'backend','parent_id':None,'updated_at':0}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([], open('$TMP/fixtures/agents.json','w'))
comments = [{'author':'backend','content':'REVIEW: done, no gate yet\nGate-SHA: aaa0000'}]
json.dump(comments, open('$TMP/fixtures/comments-cardCCC.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "no-gate-yet: surfaced" "REVIEW-no-gate-dispatched-yet" "$OUT"
check "no-gate-yet: card id" "cardCCC" "$OUT"

# --- 6. BLOKKOLT waiting card -> excluded from the sweep entirely -----------------------------------
common_env blokkolt
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
python3 -c "
import json
cards = [{'id':'cardDDD','status':'waiting','title':'BLOKKOLT-Peti valami','assignee':'backend','parent_id':None,'updated_at':0}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([], open('$TMP/fixtures/agents.json','w'))
"
bash "$BIN" >/dev/null 2>&1
OUT="$(bash "$BIN" 2>&1)"
check "blokkolt: routine" "routine, no change, silent" "$OUT"

# --- 7. STUCK card (in_progress, 20 min old, not an active subagent) -> surfaced --------------------
common_env stuck
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
python3 -c "
import json, time
now = time.time()
cards = [{'id':'cardEEE','status':'in_progress','title':'stuck one','assignee':'backend','parent_id':None,'updated_at': now - 1200}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "stuck: surfaced" "cardEEE" "$OUT"
check "stuck: actionable" "actionable=1" "$OUT"

# --- 8. STUCK exempted: active subagent, under 40 min -> NOT surfaced -------------------------------
common_env stuckexempt
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
python3 -c "
import json, time
now = time.time()
cards = [{'id':'cardFFF','status':'in_progress','title':'active one','assignee':'backend','parent_id':None,'updated_at': now - 1200}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([], open('$TMP/fixtures/agents.json','w'))
"
echo '["backend"]' > "$HEARTBEAT_SCRIPTFIRST_ACTIVE_SUBAGENTS_FILE"
bash "$BIN" >/dev/null 2>&1
OUT="$(bash "$BIN" 2>&1)"
check "stuck-exempt: routine" "routine, no change, silent" "$OUT"

# --- 9. IDLE-PARK candidate: running agent, no in_progress, no waiting card -> surfaced --------------
common_env idlepark
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
echo '[]' > "$TMP/fixtures/kanban.json"
python3 -c "
import json
json.dump([{'name':'fron-ted','running': True}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "idle-park: surfaced" "fron-ted" "$OUT"
check "idle-park: actionable" "actionable=1" "$OUT"

# --- 10. IDLE-PARK: gate agent excluded even if running+idle -----------------------------------------
common_env idleparkgate
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
echo '[]' > "$TMP/fixtures/kanban.json"
python3 -c "
import json
json.dump([{'name':'qa','running': True}], open('$TMP/fixtures/agents.json','w'))
"
bash "$BIN" >/dev/null 2>&1
OUT="$(bash "$BIN" 2>&1)"
check "idle-park gate-excluded: routine" "routine, no change, silent" "$OUT"

# --- 11. Diffed-but-not-actionable run: changes stdout report but does NOT wake ----------------------
common_env changednotactionable
export HEARTBEAT_SCRIPTFIRST_QUOTA_BIN="$TMP/quota-ok.sh"
echo '[]' > "$TMP/fixtures/kanban.json"
echo '[]' > "$TMP/fixtures/agents.json"
bash "$BIN" >/dev/null 2>&1   # first run establishes baseline
export HEARTBEAT_SCRIPTFIRST_LOADGUARD_BIN="$TMP/loadguard-admit.sh"
cat > "$TMP/loadguard-hold.sh" <<'EOF'
#!/usr/bin/env bash
echo "HOLD soft (stop_new_dispatch)"
exit 1
EOF
chmod +x "$TMP/loadguard-hold.sh"
export HEARTBEAT_SCRIPTFIRST_LOADGUARD_BIN="$TMP/loadguard-hold.sh"
OUT="$(bash "$BIN" 2>&1)"
check "changed-not-actionable: changed=1" "changed=1" "$OUT"
check "changed-not-actionable: actionable=0" "actionable=0" "$OUT"
check_absent "changed-not-actionable: no wake" "WOKE" "$(cat "$WAKE_CALLS")"

# --- 12. feature flag off -> immediate silent exit, nothing else runs -------------------------------
common_env flagoff
export HEARTBEAT_SCRIPTFIRST=off
OUT="$(bash "$BIN" 2>&1)"
check "flag-off: disabled marker" "disabled (HEARTBEAT_SCRIPTFIRST=off)" "$OUT"
unset HEARTBEAT_SCRIPTFIRST

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
