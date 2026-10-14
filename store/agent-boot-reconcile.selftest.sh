#!/usr/bin/env bash
# agent-boot-reconcile.selftest.sh -- controls for agent-boot-reconcile.sh (card 43d98136).
# Runs against fixture kanban/agents JSON and recorder stubs for start/message/telegram, so it never
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

# Recorders echo a result after logging, so the main script's http-code / targetRunning handling
# has something real to branch on (F3).
cat > "$TMP/start-recorder.sh" <<'EOF'
#!/usr/bin/env bash
echo "START: $1" >> "$START_CALLS"
echo "${START_RECORDER_CODE:-200}"
EOF
cat > "$TMP/message-recorder.sh" <<'EOF'
#!/usr/bin/env bash
echo "MESSAGE: $1 :: $2" >> "$MESSAGE_CALLS"
echo "${MESSAGE_RECORDER_CODE:-200}|${MESSAGE_RECORDER_STOPPED:-0}"
EOF
cat > "$TMP/telegram-recorder.sh" <<'EOF'
#!/usr/bin/env bash
echo "TELEGRAM: $1" >> "$TELEGRAM_CALLS"
EOF
chmod +x "$TMP"/*.sh

# No hard-stop / no priority-restriction by default (both files absent -> inactive, matching the
# live default when neither feature is engaged).
NO_HARDSTOP="$TMP/no-such-hardstop.json"
NO_PRIORITY="$TMP/no-such-priority.json"

common_env() { # $1 = case name
  local case_name="${1:?case name required}"
  export AGENT_BOOT_RECONCILE_FIXTURE_DIR="$TMP/fixtures"
  export AGENT_BOOT_RECONCILE_START_BIN="$TMP/start-recorder.sh"
  export AGENT_BOOT_RECONCILE_MESSAGE_BIN="$TMP/message-recorder.sh"
  export AGENT_BOOT_RECONCILE_TELEGRAM_BIN="$TMP/telegram-recorder.sh"
  export AGENT_BOOT_RECONCILE_HARDSTOP_FILE="$NO_HARDSTOP"
  export AGENT_BOOT_RECONCILE_PRIORITY_CONFIG="$NO_PRIORITY"
  export START_CALLS="$TMP/start-calls-$case_name.txt"
  export MESSAGE_CALLS="$TMP/message-calls-$case_name.txt"
  export TELEGRAM_CALLS="$TMP/telegram-calls-$case_name.txt"
  unset START_RECORDER_CODE MESSAGE_RECORDER_CODE MESSAGE_RECORDER_STOPPED
  : > "$START_CALLS"
  : > "$MESSAGE_CALLS"
  : > "$TELEGRAM_CALLS"
}

echo "agent-boot-reconcile controls"

# --- 1. in_progress card, agent NOT running -> started + resumed, card id in message, telegram sent
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
check "in_progress: telegram summary sent" "backend" "$(cat "$TELEGRAM_CALLS")"

# --- 2. in_progress card, agent ALREADY running -> no start, no message, no telegram --------------
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
check_absent "already-running: no telegram" "TELEGRAM" "$(cat "$TELEGRAM_CALLS")"

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

# --- 4b. waiting card, REVIEW is NOT the first word of the comment (Gate-SHA-first convention,
#         CLAUDE.md 4b/4c) -> still qualifies (multiline match, LOW fix) -----------------------
common_env waitingreviewmultiline
python3 -c "
import json
cards = [{'id':'cardD2D2','status':'waiting','assignee':'fron-teddy'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'fron-teddy','running': False}], open('$TMP/fixtures/agents.json','w'))
"
echo '[{"content":"Gate-SHA: abc1234\nREVIEW: done"}]' > "$TMP/fixtures/comments-cardD2D2.json"
OUT="$(bash "$BIN" 2>&1)"
check "waiting-review-multiline: started marker" "started:" "$OUT"
check "waiting-review-multiline: card id in resume message" "cardD2D2" "$(cat "$MESSAGE_CALLS")"

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

# --- 6. empty board -> nothing to do, no calls, no telegram ----------------------------------------
common_env empty
echo '[]' > "$TMP/fixtures/kanban.json"
echo '[]' > "$TMP/fixtures/agents.json"
OUT="$(bash "$BIN" 2>&1)"
check "empty: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "empty: no start call" "START" "$(cat "$START_CALLS")"
check_absent "empty: no telegram" "TELEGRAM" "$(cat "$TELEGRAM_CALLS")"

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

# --- 8b. fetch returns a non-array error object (e.g. an expired-token error body), not just an
#         empty string -> fail-closed exit 1 too (QA F2: this previously read as "no work") -------
common_env fetcherror
echo '{"error":"unauthorized"}' > "$TMP/fixtures/kanban.json"
echo '[{"name":"backend","running": false}]' > "$TMP/fixtures/agents.json"
OUT="$(bash "$BIN" 2>&1)"; RC=$?
check "fetch-error-object: FAILED marker" "FAILED to fetch" "$OUT"
if [ "$RC" -eq 1 ]; then echo "  ok   fetch-error-object: exit 1"; else echo "  FAIL fetch-error-object: exit $RC, expected 1"; fail=1; fi
check_absent "fetch-error-object: no start call" "START" "$(cat "$START_CALLS")"

# --- 9. WhiteHat F1 / QA repro: a [BLOKKOLT-*]-titled in_progress card is NOT qualifying work ------
common_env blokkolt
python3 -c "
import json
cards = [{'id':'cardGGG','status':'in_progress','assignee':'backend','title':'[BLOKKOLT-Peti-stop] [mopsion][BE] x'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "blokkolt: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "blokkolt: no start call" "START" "$(cat "$START_CALLS")"
check_absent "blokkolt: no telegram" "TELEGRAM" "$(cat "$TELEGRAM_CALLS")"

# --- 10. weekly hard-stop active -> nothing started, even with real in_progress work ---------------
common_env hardstop
echo '{"active": true}' > "$TMP/fixtures/hardstop.json"
export AGENT_BOOT_RECONCILE_HARDSTOP_FILE="$TMP/fixtures/hardstop.json"
python3 -c "
import json
cards = [{'id':'cardHHH','status':'in_progress','assignee':'backend2'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend2','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "hard-stop: active marker" "hard-stop active" "$OUT"
check_absent "hard-stop: no start call" "START" "$(cat "$START_CALLS")"
check_absent "hard-stop: no telegram" "TELEGRAM" "$(cat "$TELEGRAM_CALLS")"
unset AGENT_BOOT_RECONCILE_HARDSTOP_FILE

# --- 11. card 43d98136 QA FAIL (17906) + MikroB (17915): project-dispatch-priority exclusivity
#         must NOT apply here -- an in_progress card outside the active priority project is still
#         resumed. A prior version of this fix wrongly skipped it (reverted; see header comment).
common_env priorityexclusion
echo '{"priority": ["MikroB"]}' > "$TMP/fixtures/priority.json"
export AGENT_BOOT_RECONCILE_PRIORITY_CONFIG="$TMP/fixtures/priority.json"
python3 -c "
import json
cards = [{'id':'cardIII','status':'in_progress','assignee':'backend3','project':'mopsion'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend3','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "priority-exclusion-removed: started marker" "started:" "$OUT"
check "priority-exclusion-removed: card id in resume message" "cardIII" "$(cat "$MESSAGE_CALLS")"
unset AGENT_BOOT_RECONCILE_PRIORITY_CONFIG

# --- 11b. same priority list, card's project IS in it -> also starts (project is irrelevant either
#          way, kept as a second data point against any accidental re-introduction of filtering) ----
common_env priorityincluded
echo '{"priority": ["MikroB"]}' > "$TMP/fixtures/priority2.json"
export AGENT_BOOT_RECONCILE_PRIORITY_CONFIG="$TMP/fixtures/priority2.json"
python3 -c "
import json
cards = [{'id':'cardJJJ','status':'in_progress','assignee':'backend3','project':'MikroB'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend3','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "priority-included: started marker" "started:" "$OUT"
unset AGENT_BOOT_RECONCILE_PRIORITY_CONFIG

# --- 11c. project=None in_progress card (the exact live shape measured 2026-10-12 on 43d98136:
#          backend/backend2 in_progress cards with no project field at all, under an active
#          priority=["MikroB"] list) -> still resumed, not skipped --------------------------------
common_env priorityprojectnone
echo '{"priority": ["MikroB"]}' > "$TMP/fixtures/priority3.json"
export AGENT_BOOT_RECONCILE_PRIORITY_CONFIG="$TMP/fixtures/priority3.json"
python3 -c "
import json
cards = [{'id':'cardPPP','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "priority-project-none: started marker" "started:" "$OUT"
check "priority-project-none: card id in resume message" "cardPPP" "$(cat "$MESSAGE_CALLS")"
unset AGENT_BOOT_RECONCILE_PRIORITY_CONFIG

# --- 12. F2: assignee not present in the SAME /api/agents fetch -> not started (no guessing) -------
common_env assigneeghost
python3 -c "
import json
cards = [{'id':'cardKKK','status':'in_progress','assignee':'ghost'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "assignee-ghost: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "assignee-ghost: no start call" "START" "$(cat "$START_CALLS")"

# --- 13. F2: assignee is a path-traversal/arbitrary-endpoint attempt, not a valid name shape -------
common_env assigneetraversal
python3 -c "
import json
cards = [{'id':'cardLLL','status':'in_progress','assignee':'../kanban/zzzzzzzz/move?x='}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "assignee-traversal: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "assignee-traversal: no start call" "START" "$(cat "$START_CALLS")"
check_absent "assignee-traversal: no kanban-move leak" "kanban" "$(cat "$START_CALLS")"

# --- 14. F3: start call fails (non-2xx) -> reported as FAILED, no resume message is sent -----------
common_env starthttpfail
export START_RECORDER_CODE=500
python3 -c "
import json
cards = [{'id':'cardMMM','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "start-http-fail: FAILED marker" "FAILED" "$OUT"
check "start-http-fail: agent+code in report" "backend(start=500)" "$OUT"
check_absent "start-http-fail: no resume message sent" "MESSAGE" "$(cat "$MESSAGE_CALLS")"
check "start-http-fail: telegram still summarises the failure" "backend(start=500)" "$(cat "$TELEGRAM_CALLS")"
unset START_RECORDER_CODE

# --- 15. F3: message call reports the recipient was not yet running -> flagged, run still counts
#         as started (the agent WAS started; only the resume text delivery is in doubt) ------------
common_env messagestopped
export MESSAGE_RECORDER_STOPPED=1
python3 -c "
import json
cards = [{'id':'cardNNN','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "message-stopped: still started" "started:" "$OUT"
check "message-stopped: telegram flags the stopped recipient" "backend" "$(cat "$TELEGRAM_CALLS")"
unset MESSAGE_RECORDER_STOPPED

if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
