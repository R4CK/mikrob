#!/usr/bin/env bash
# agent-boot-reconcile.selftest.sh -- controls for agent-boot-reconcile.sh (card 43d98136).
# Runs against fixture kanban/agents JSON and recorder stubs for start/message, so it never
# touches the live dashboard. Usage: store/agent-boot-reconcile.selftest.sh (exit 0 = PASS).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/agent-boot-reconcile.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { case "$3" in *"$2"*) echo "  ok   $1" ;; *) echo "  FAIL $1 -> needle '$2' not in '$3'"; fail=1 ;; esac; }
check_absent() { case "$3" in *"$2"*) echo "  FAIL $1 -> needle '$2' unexpectedly present"; fail=1 ;; *) echo "  ok   $1" ;; esac; }

mkdir -p "$TMP/fixtures"
cat > "$TMP/start-recorder.sh" <<'EOF'
#!/usr/bin/env bash
echo "START: $1" >> "$START_CALLS"
EOF
cat > "$TMP/message-recorder.sh" <<'EOF'
#!/usr/bin/env bash
echo "MESSAGE: $1 :: $2" >> "$MESSAGE_CALLS"
EOF
chmod +x "$TMP"/*.sh

common_env() { # $1 = case name
  local case_name="${1:?case name required}"
  export AGENT_BOOT_RECONCILE_FIXTURE_DIR="$TMP/fixtures"
  export AGENT_BOOT_RECONCILE_START_BIN="$TMP/start-recorder.sh"
  export AGENT_BOOT_RECONCILE_MESSAGE_BIN="$TMP/message-recorder.sh"
  export START_CALLS="$TMP/start-calls-$case_name.txt"
  export MESSAGE_CALLS="$TMP/message-calls-$case_name.txt"
  : > "$START_CALLS"
  : > "$MESSAGE_CALLS"
}

echo "agent-boot-reconcile controls"

# --- 1. in_progress card, agent NOT running -> started + resumed, card id in message -------------
common_env inprogress
python3 -c "
import json
cards = [{'id':'cardAAA','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "in_progress: started marker" "started:" "$OUT"
check "in_progress: agent name in output" "backend" "$OUT"
check "in_progress: start call recorded" "START: backend" "$(cat "$START_CALLS")"
check "in_progress: resume message recorded" "MESSAGE: backend" "$(cat "$MESSAGE_CALLS")"
check "in_progress: card id in resume message" "cardAAA" "$(cat "$MESSAGE_CALLS")"

# --- 2. in_progress card, agent ALREADY running -> no start, no message --------------------------
common_env alreadyrunning
python3 -c "
import json
cards = [{'id':'cardBBB','status':'in_progress','assignee':'backend2'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend2','running': True}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "already-running: no-op marker" "already running -- nothing to do" "$OUT"
check_absent "already-running: no start call" "START" "$(cat "$START_CALLS")"
check_absent "already-running: no message" "MESSAGE" "$(cat "$MESSAGE_CALLS")"

# --- 3. waiting card WITHOUT a REVIEW comment -> not qualifying work, agent not started -----------
common_env waitingnoreview
python3 -c "
import json
cards = [{'id':'cardCCC','status':'waiting','assignee':'qa'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'qa','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "waiting-no-review: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "waiting-no-review: no start call" "START" "$(cat "$START_CALLS")"

# --- 4. waiting card WITH a REVIEW comment, agent not running -> qualifies, started ---------------
common_env waitingreview
python3 -c "
import json
cards = [{'id':'cardDDD','status':'waiting','assignee':'fron-ted'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'fron-ted','running': False}], open('$TMP/fixtures/agents.json','w'))
"
echo '[{"content":"REVIEW: done\nGate-SHA: abc1234"}]' > "$TMP/fixtures/comments-cardDDD.json"
OUT="$(bash "$BIN" 2>&1)"
check "waiting-review: started marker" "started:" "$OUT"
check "waiting-review: card id in resume message" "cardDDD" "$(cat "$MESSAGE_CALLS")"

# --- 5. assignee is mikrob -> never started by this script (that's its own channels unit) ---------
common_env mikrobexcluded
python3 -c "
import json
cards = [{'id':'cardEEE','status':'in_progress','assignee':'mikrob'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'mikrob','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "mikrob-excluded: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "mikrob-excluded: no start call" "mikrob" "$(cat "$START_CALLS")"

# --- 6. empty board -> nothing to do, no calls ------------------------------------------------------
common_env empty
echo '[]' > "$TMP/fixtures/kanban.json"
echo '[]' > "$TMP/fixtures/agents.json"
OUT="$(bash "$BIN" 2>&1)"
check "empty: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "empty: no start call" "START" "$(cat "$START_CALLS")"

# --- 7. idempotency: running the already-started case again issues no new calls -------------------
common_env idempotent
python3 -c "
import json
cards = [{'id':'cardFFF','status':'in_progress','assignee':'backend3'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend3','running': False}], open('$TMP/fixtures/agents.json','w'))
"
bash "$BIN" >/dev/null 2>&1
FIRST_CALLS="$(cat "$START_CALLS")"
# second run: fixture now shows the agent as running (as the real start would have made true)
python3 -c "
import json
json.dump([{'name':'backend3','running': True}], open('$TMP/fixtures/agents.json','w'))
"
bash "$BIN" >/dev/null 2>&1
SECOND_CALLS="$(cat "$START_CALLS")"
check "idempotent: first run started it" "backend3" "$FIRST_CALLS"
if [ "$FIRST_CALLS" = "$SECOND_CALLS" ]; then
  echo "  ok   idempotent: second run issued no new start call"
else
  echo "  FAIL idempotent: second run issued an extra start call ($SECOND_CALLS)"
  fail=1
fi

# --- 8. fetch failure (empty kanban response) -> fail-closed exit 1 --------------------------------
common_env fetchfail
rm -f "$TMP/fixtures/kanban.json" "$TMP/fixtures/agents.json"
OUT="$(bash "$BIN" 2>&1)"; RC=$?
check "fetch-fail: FAILED marker" "FAILED to fetch" "$OUT"
if [ "$RC" -eq 1 ]; then echo "  ok   fetch-fail: exit 1"; else echo "  FAIL fetch-fail: exit $RC, expected 1"; fail=1; fi

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
