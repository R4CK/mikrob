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
NO_PAUSE="$TMP/no-such-pause.json"

common_env() { # $1 = case name
  local case_name="${1:?case name required}"
  export AGENT_BOOT_RECONCILE_FIXTURE_DIR="$TMP/fixtures"
  export AGENT_BOOT_RECONCILE_START_BIN="$TMP/start-recorder.sh"
  export AGENT_BOOT_RECONCILE_MESSAGE_BIN="$TMP/message-recorder.sh"
  export AGENT_BOOT_RECONCILE_TELEGRAM_BIN="$TMP/telegram-recorder.sh"
  export AGENT_BOOT_RECONCILE_HARDSTOP_FILE="$NO_HARDSTOP"
  export AGENT_BOOT_RECONCILE_PRIORITY_CONFIG="$NO_PRIORITY"
  export AGENT_BOOT_RECONCILE_PAUSE_FILE="$NO_PAUSE"
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
cards = [{'id':'a0000001','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "in_progress: started marker" "started:" "$OUT"
check "in_progress: agent name in output" "backend" "$OUT"
check "in_progress: start call recorded" "START: backend" "$(cat "$START_CALLS")"
check "in_progress: resume message recorded" "MESSAGE: backend" "$(cat "$MESSAGE_CALLS")"
check "in_progress: card id in resume message" "a0000001" "$(cat "$MESSAGE_CALLS")"
check "in_progress: telegram summary sent" "backend" "$(cat "$TELEGRAM_CALLS")"

# --- 2. in_progress card, agent ALREADY running -> no start, no message, no telegram --------------
common_env alreadyrunning
python3 -c "
import json
cards = [{'id':'a0000002','status':'in_progress','assignee':'backend2'}]
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
cards = [{'id':'a0000003','status':'waiting','assignee':'qa'}]
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
cards = [{'id':'a0000004','status':'waiting','assignee':'fron-ted'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'fron-ted','running': False}], open('$TMP/fixtures/agents.json','w'))
"
echo '[{"content":"REVIEW: done\nGate-SHA: abc1234"}]' > "$TMP/fixtures/comments-a0000004.json"
OUT="$(bash "$BIN" 2>&1)"
check "waiting-review: started marker" "started:" "$OUT"
check "waiting-review: card id in resume message" "a0000004" "$(cat "$MESSAGE_CALLS")"

# --- 4b. waiting card, REVIEW is NOT the first word of the comment (Gate-SHA-first convention,
#         CLAUDE.md 4b/4c) -> still qualifies (multiline match, LOW fix) -----------------------
common_env waitingreviewmultiline
python3 -c "
import json
cards = [{'id':'a0000005','status':'waiting','assignee':'fron-teddy'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'fron-teddy','running': False}], open('$TMP/fixtures/agents.json','w'))
"
echo '[{"content":"Gate-SHA: abc1234\nREVIEW: done"}]' > "$TMP/fixtures/comments-a0000005.json"
OUT="$(bash "$BIN" 2>&1)"
check "waiting-review-multiline: started marker" "started:" "$OUT"
check "waiting-review-multiline: card id in resume message" "a0000005" "$(cat "$MESSAGE_CALLS")"

# --- 5. assignee is mikrob -> never started by this script (that's its own channels unit) ---------
common_env mikrobexcluded
python3 -c "
import json
cards = [{'id':'a0000006','status':'in_progress','assignee':'mikrob'}]
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
cards = [{'id':'a0000007','status':'in_progress','assignee':'backend3'}]
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
cards = [{'id':'a0000008','status':'in_progress','assignee':'backend','title':'[BLOKKOLT-Peti-stop] [mopsion][BE] x'}]
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
cards = [{'id':'a0000009','status':'in_progress','assignee':'backend2'}]
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
cards = [{'id':'a000000a','status':'in_progress','assignee':'backend3','project':'mopsion'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend3','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "priority-exclusion-removed: started marker" "started:" "$OUT"
check "priority-exclusion-removed: card id in resume message" "a000000a" "$(cat "$MESSAGE_CALLS")"
unset AGENT_BOOT_RECONCILE_PRIORITY_CONFIG

# --- 11b. same priority list, card's project IS in it -> also starts (project is irrelevant either
#          way, kept as a second data point against any accidental re-introduction of filtering) ----
common_env priorityincluded
echo '{"priority": ["MikroB"]}' > "$TMP/fixtures/priority2.json"
export AGENT_BOOT_RECONCILE_PRIORITY_CONFIG="$TMP/fixtures/priority2.json"
python3 -c "
import json
cards = [{'id':'a000000b','status':'in_progress','assignee':'backend3','project':'MikroB'}]
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
cards = [{'id':'a0000010','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "priority-project-none: started marker" "started:" "$OUT"
check "priority-project-none: card id in resume message" "a0000010" "$(cat "$MESSAGE_CALLS")"
unset AGENT_BOOT_RECONCILE_PRIORITY_CONFIG

# --- 12. F2: assignee not present in the SAME /api/agents fetch -> not started (no guessing) -------
common_env assigneeghost
python3 -c "
import json
cards = [{'id':'a000000c','status':'in_progress','assignee':'ghost'}]
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
cards = [{'id':'a000000d','status':'in_progress','assignee':'../kanban/zzzzzzzz/move?x='}]
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
cards = [{'id':'a000000e','status':'in_progress','assignee':'backend'}]
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
cards = [{'id':'a000000f','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "message-stopped: still started" "started:" "$OUT"
check "message-stopped: telegram flags the stopped recipient" "backend" "$(cat "$TELEGRAM_CALLS")"
unset MESSAGE_RECORDER_STOPPED

# --- 16. card a4689243: manual-dispatch-pause ACTIVE -> real in_progress work is logged as
#          "would start", nothing is actually started/messaged/telegrammed -------------------------
common_env pauseactive
echo '{"active": true, "reason": "Peti 11965"}' > "$TMP/fixtures/pause.json"
export AGENT_BOOT_RECONCILE_PAUSE_FILE="$TMP/fixtures/pause.json"
python3 -c "
import json
cards = [{'id':'a0000011','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "pause-active: would-start marker" "manual-dispatch-pause active -- would start:" "$OUT"
check "pause-active: agent+card named in the log" "backend(a0000011)" "$OUT"
check_absent "pause-active: no start call" "START" "$(cat "$START_CALLS")"
check_absent "pause-active: no resume message" "MESSAGE" "$(cat "$MESSAGE_CALLS")"
check_absent "pause-active: no telegram" "TELEGRAM" "$(cat "$TELEGRAM_CALLS")"
unset AGENT_BOOT_RECONCILE_PAUSE_FILE

# --- 17. pause file present but explicitly {"active": false} (lifted-in-place) -> normal start ------
common_env pauseinactive
echo '{"active": false}' > "$TMP/fixtures/pause2.json"
export AGENT_BOOT_RECONCILE_PAUSE_FILE="$TMP/fixtures/pause2.json"
python3 -c "
import json
cards = [{'id':'a0000012','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "pause-inactive: started marker" "started:" "$OUT"
check "pause-inactive: card id in resume message" "a0000012" "$(cat "$MESSAGE_CALLS")"
unset AGENT_BOOT_RECONCILE_PAUSE_FILE

# --- 18. pause file present but CORRUPT (unparseable JSON) -> fail-closed, treated as active --------
common_env pausecorrupt
printf '{not valid json' > "$TMP/fixtures/pause3.json"
export AGENT_BOOT_RECONCILE_PAUSE_FILE="$TMP/fixtures/pause3.json"
python3 -c "
import json
cards = [{'id':'a0000013','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "pause-corrupt: fail-closed, would-start marker (not a normal start)" "manual-dispatch-pause active -- would start:" "$OUT"
check_absent "pause-corrupt: no start call" "START" "$(cat "$START_CALLS")"
unset AGENT_BOOT_RECONCILE_PAUSE_FILE

# --- 19. mutation test: a copy of the script with the ENTIRE pause-check block deleted (simulating
#          "the pause-ellenorzes kivetele", exactly the acceptance criterion) must turn case 16 RED --
#          i.e. under the mutant, the paused agent gets started anyway. Proves case 16 is load-bearing,
#          not vacuous. The block is found by its own markers (PAUSE_ACTIVE=0 ... matching fi), not a
#          fixed line number, so this survives future edits to the script around it.
common_env mutationcheck
MUTANT="$TMP/agent-boot-reconcile.mutant.sh"
awk '
  /^PAUSE_ACTIVE=0$/ { print; skip=1; next }
  skip && /^fi$/ { skip=0; next }
  skip { next }
  { print }
' "$BIN" > "$MUTANT"
chmod +x "$MUTANT"
if ! diff -q "$BIN" "$MUTANT" >/dev/null 2>&1; then
  echo "  ok   mutation: the pause-check block was actually found and stripped from the mutant"
else
  echo "  FAIL mutation: the mutant is byte-identical to the original -- the awk markers did not match, nothing was mutated"
  fail=1
fi
echo '{"active": true, "reason": "Peti 11965"}' > "$TMP/fixtures/pause.json"
export AGENT_BOOT_RECONCILE_PAUSE_FILE="$TMP/fixtures/pause.json"
python3 -c "
import json
cards = [{'id':'a0000014','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
MUT_OUT="$(bash "$MUTANT" 2>&1)"
if printf '%s' "$MUT_OUT" | grep -q 'started:'; then
  echo "  ok   mutation: with the pause-check removed, the paused agent gets started -- case 16 would catch this regression"
else
  echo "  FAIL mutation: removing the pause-check should have made the mutant start the agent anyway, but it still didn't -> $MUT_OUT"
  fail=1
fi
unset AGENT_BOOT_RECONCILE_PAUSE_FILE

# ===========================================================================
# RedHat NO-GO (comment 17886, Gate-SHA 1199bea9) delta: H1, H2, H3a, H3b.
# ===========================================================================

# --- 20. H1: hard-stop file EXISTS but is CORRUPT (truncated JSON) -> fail-closed, not started ----
common_env hardstopcorrupt
printf '{not valid json' > "$TMP/fixtures/hardstop-corrupt.json"
export AGENT_BOOT_RECONCILE_HARDSTOP_FILE="$TMP/fixtures/hardstop-corrupt.json"
python3 -c "
import json
cards = [{'id':'b0000001','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "hard-stop-corrupt: fail-closed marker (not started)" "could not be understood" "$OUT"
check_absent "hard-stop-corrupt: no start call" "START" "$(cat "$START_CALLS")"
unset AGENT_BOOT_RECONCILE_HARDSTOP_FILE

# --- 21. H1: hard-stop file is a DIRECTORY, not a file -> fail-closed (the -e fix) -----------------
common_env hardstopdir
mkdir -p "$TMP/fixtures/hardstop-is-a-dir"
export AGENT_BOOT_RECONCILE_HARDSTOP_FILE="$TMP/fixtures/hardstop-is-a-dir"
python3 -c "
import json
cards = [{'id':'b0000002','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "hard-stop-dir: fail-closed marker (not started)" "could not be understood" "$OUT"
check_absent "hard-stop-dir: no start call" "START" "$(cat "$START_CALLS")"
unset AGENT_BOOT_RECONCILE_HARDSTOP_FILE

# --- 22. H1: hard-stop file is a JSON ARRAY at the root (valid JSON, not an object) -> fail-closed -
common_env hardstoparray
echo '[1, 2, 3]' > "$TMP/fixtures/hardstop-array.json"
export AGENT_BOOT_RECONCILE_HARDSTOP_FILE="$TMP/fixtures/hardstop-array.json"
python3 -c "
import json
cards = [{'id':'b0000003','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "hard-stop-array: fail-closed marker (not started)" "could not be understood" "$OUT"
check_absent "hard-stop-array: no start call" "START" "$(cat "$START_CALLS")"
unset AGENT_BOOT_RECONCILE_HARDSTOP_FILE

# --- 23. H1 control: hard-stop file MISSING ENTIRELY -> stays fail-OPEN (by design, unchanged) -----
common_env hardstopmissing
python3 -c "
import json
cards = [{'id':'b0000004','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "hard-stop-missing: still starts (missing file stays fail-open by design)" "started:" "$OUT"

# --- 24. H1 MUTANT PROOF: reverting to the old bare try/except (d={} on any error) makes the
#         corrupt-file case (20) start the agent anyway -------------------------------------------
common_env hardstopmutant
MUTANT_H1="$TMP/agent-boot-reconcile.mutant-h1.sh"
python3 - "$BIN" "$MUTANT_H1" <<'PYEOF'
import sys
src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    content = f.read()
old = '''  HS_STATE="$(python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as fh:
        d = json.load(fh)
    if not isinstance(d, dict):
        print("corrupt")
    else:
        print("1" if d.get("active") else "0")
except Exception:
    print("corrupt")
' "$HARDSTOP_FILE" 2>/dev/null)"'''
new = '''  HS_STATE="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
print("1" if d.get("active") else "0")
' "$HARDSTOP_FILE" 2>/dev/null)"'''
assert old in content, "H1 mutant marker not found -- did the source change shape?"
content = content.replace(old, new)
with open(dst_path, "w") as f:
    f.write(content)
PYEOF
chmod +x "$MUTANT_H1"
printf '{not valid json' > "$TMP/fixtures/hardstop-corrupt2.json"
MUT_OUT="$(AGENT_BOOT_RECONCILE_HARDSTOP_FILE="$TMP/fixtures/hardstop-corrupt2.json" bash "$MUTANT_H1" 2>&1)"
if printf '%s' "$MUT_OUT" | grep -q 'started:'; then
  echo "  ok   H1 mutant: reverting to the old fail-open parse flips the corrupt-file case to started"
else
  echo "  FAIL H1 mutant: reverting to the old fail-open parse should have started the agent anyway, but it did not -> $MUT_OUT"
  fail=1
fi

# --- 25. H2: a LOWERCASE "blokkolt" title is NOT qualifying work -----------------------------------
common_env blokkoltlower
python3 -c "
import json
cards = [{'id':'b0000005','status':'in_progress','assignee':'backend','title':'[blokkolt-peti-stop] x'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "blokkolt-lower: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "blokkolt-lower: no start call" "START" "$(cat "$START_CALLS")"

# --- 26. H2: BLOKKOLT present ONLY as a LABEL (title carries no such text) -> not qualifying -------
common_env blokkoltlabel
python3 -c "
import json
cards = [{'id':'b0000006','status':'in_progress','assignee':'backend','title':'[mopsion][BE] x',
          'labels':[{'name':'BLOKKOLT-Peti-stop'}]}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "blokkolt-label: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "blokkolt-label: no start call" "START" "$(cat "$START_CALLS")"

# --- 27. H2 MUTANT PROOF: reverting to the old case-sensitive, title-only check flips (25) and (26)
#         from excluded to started -------------------------------------------------------------------
common_env blokkoltmutant
MUTANT_H2="$TMP/agent-boot-reconcile.mutant-h2.sh"
python3 - "$BIN" "$MUTANT_H2" <<'PYEOF'
import sys
src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    content = f.read()
old = '''    title = (c.get("title") or "").upper()
    label_names = " ".join((lbl.get("name") or "") for lbl in (c.get("labels") or []) if isinstance(lbl, dict)).upper()
    if "BLOKKOLT" in title or "BLOKKOLT" in label_names:
        continue'''
new = '''    title = c.get("title") or ""
    if "BLOKKOLT" in title:
        continue'''
assert old in content, "H2 mutant marker not found -- did the source change shape?"
content = content.replace(old, new)
with open(dst_path, "w") as f:
    f.write(content)
PYEOF
chmod +x "$MUTANT_H2"
python3 -c "
import json
cards = [{'id':'b0000007','status':'in_progress','assignee':'backend','title':'[blokkolt-peti-stop] x'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
MUT_OUT="$(bash "$MUTANT_H2" 2>&1)"
if printf '%s' "$MUT_OUT" | grep -q 'started:'; then
  echo "  ok   H2 mutant: reverting to the case-sensitive title-only check flips the lowercase case to started"
else
  echo "  FAIL H2 mutant: reverting to the old check should have started the agent on lowercase blokkolt, but it did not -> $MUT_OUT"
  fail=1
fi

# --- 28. H3a: a waiting+REVIEW card that gate-closure-check.py reads as fully AGREEd -> NOT
#         qualifying work (its builder must not be restarted every 5 minutes on a closed card) ----
# A plain Python script, not bash: the real caller invokes `python3 "$GATECLOSURE_BIN"`
# (hardcoded interpreter, matching gate-closure-check.py's own CLI), so the override must be
# something python3 can actually run.
cat > "$TMP/gateclosure-agree.sh" <<'EOF'
import sys
sys.stdin.read()   # consume stdin (the comments JSON), same contract as the real tool
print("AGREE|abc1234|QA PASS, CYBERSEC GO, same sha")
EOF
common_env gateclosureagree
export AGENT_BOOT_RECONCILE_GATECLOSURE_BIN="$TMP/gateclosure-agree.sh"
python3 -c "
import json
cards = [{'id':'b0000008','status':'waiting','assignee':'qa2'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'qa2','running': False}], open('$TMP/fixtures/agents.json','w'))
"
echo '[{"content":"REVIEW: done\nGate-SHA: abc1234"},{"author":"qa","content":"QA PASS\nGate-SHA: abc1234"}]' > "$TMP/fixtures/comments-b0000008.json"
OUT="$(bash "$BIN" 2>&1)"
check "gate-closure-agree: nothing-to-do marker (already fully gated)" "no agent had qualifying work" "$OUT"
check_absent "gate-closure-agree: no start call" "START" "$(cat "$START_CALLS")"
unset AGENT_BOOT_RECONCILE_GATECLOSURE_BIN

# --- 29. H3a control: the SAME waiting+REVIEW card, but gate-closure-check.py reads anything other
#         than AGREE (here MISSING, a gate has not verdicted yet) -> still qualifies, started -----
cat > "$TMP/gateclosure-missing.sh" <<'EOF'
import sys
sys.stdin.read()
print("MISSING|cybersec has no verdict")
EOF
common_env gateclosuremissing
export AGENT_BOOT_RECONCILE_GATECLOSURE_BIN="$TMP/gateclosure-missing.sh"
python3 -c "
import json
cards = [{'id':'b0000009','status':'waiting','assignee':'qa2'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'qa2','running': False}], open('$TMP/fixtures/agents.json','w'))
"
echo '[{"content":"REVIEW: done\nGate-SHA: abc1234"}]' > "$TMP/fixtures/comments-b0000009.json"
OUT="$(bash "$BIN" 2>&1)"
check "gate-closure-missing: still started (gate not fully closed yet)" "started:" "$OUT"
check "gate-closure-missing: card id in resume message" "b0000009" "$(cat "$MESSAGE_CALLS")"
unset AGENT_BOOT_RECONCILE_GATECLOSURE_BIN

# --- 30. H3a MUTANT PROOF: removing the AGREE check flips (28) from excluded to started ------------
common_env gateclosuremutant
MUTANT_H3A="$TMP/agent-boot-reconcile.mutant-h3a.sh"
python3 - "$BIN" "$MUTANT_H3A" <<'PYEOF'
import sys
src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    content = f.read()
old = '''    closure="$(printf '%s' "$comments_json" | python3 "$GATECLOSURE_BIN" 2>/dev/null)"
    case "$closure" in
      AGREE\\|*) continue ;;
    esac
    qualifying_waiting="$qualifying_waiting $cid"'''
new = '''    qualifying_waiting="$qualifying_waiting $cid"'''
assert old in content, "H3a mutant marker not found -- did the source change shape?"
content = content.replace(old, new)
with open(dst_path, "w") as f:
    f.write(content)
PYEOF
chmod +x "$MUTANT_H3A"
export AGENT_BOOT_RECONCILE_GATECLOSURE_BIN="$TMP/gateclosure-agree.sh"
python3 -c "
import json
cards = [{'id':'b000000a','status':'waiting','assignee':'qa2'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'qa2','running': False}], open('$TMP/fixtures/agents.json','w'))
"
echo '[{"content":"REVIEW: done\nGate-SHA: abc1234"}]' > "$TMP/fixtures/comments-b000000a.json"
MUT_OUT="$(bash "$MUTANT_H3A" 2>&1)"
if printf '%s' "$MUT_OUT" | grep -q 'started:'; then
  echo "  ok   H3a mutant: removing the AGREE check flips the fully-closed card to started"
else
  echo "  FAIL H3a mutant: removing the AGREE check should have started the agent anyway, but it did not -> $MUT_OUT"
  fail=1
fi
unset AGENT_BOOT_RECONCILE_GATECLOSURE_BIN

# --- 31. H3b: a card id that is NOT the board's hex8 shape (e.g. a long readable identifier) is
#         dropped before it can reach a start/resume/Telegram call -----------------------------
common_env cardidbad
python3 -c "
import json
cards = [{'id':'IGNORE-RULES-this-is-not-a-hex8-id','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
OUT="$(bash "$BIN" 2>&1)"
check "card-id-bad: nothing-to-do marker" "no agent had qualifying work" "$OUT"
check_absent "card-id-bad: no start call" "START" "$(cat "$START_CALLS")"
check_absent "card-id-bad: the bad id never reaches a message" "IGNORE-RULES" "$(cat "$MESSAGE_CALLS")"

# --- 32. H3b MUTANT PROOF: removing the CARD_ID_RX check flips (31) from excluded to started --------
common_env cardidmutant
MUTANT_H3B="$TMP/agent-boot-reconcile.mutant-h3b.sh"
python3 - "$BIN" "$MUTANT_H3B" <<'PYEOF'
import sys
src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    content = f.read()
old = '''    cid = c.get("id")
    if not isinstance(cid, str) or not CARD_ID_RX.match(cid):
        continue
    status = c.get("status")
    if status in ("in_progress", "waiting"):
        by_agent.setdefault(assignee, []).append((cid, status))'''
new = '''    status = c.get("status")
    if status in ("in_progress", "waiting"):
        by_agent.setdefault(assignee, []).append((c["id"], status))'''
assert old in content, "H3b mutant marker not found -- did the source change shape?"
content = content.replace(old, new)
with open(dst_path, "w") as f:
    f.write(content)
PYEOF
chmod +x "$MUTANT_H3B"
python3 -c "
import json
cards = [{'id':'IGNORE-RULES-this-is-not-a-hex8-id','status':'in_progress','assignee':'backend'}]
json.dump(cards, open('$TMP/fixtures/kanban.json','w'))
json.dump([{'name':'backend','running': False}], open('$TMP/fixtures/agents.json','w'))
"
MUT_OUT="$(bash "$MUTANT_H3B" 2>&1)"
if printf '%s' "$MUT_OUT" | grep -q 'started:'; then
  echo "  ok   H3b mutant: removing the hex8 id check flips the malformed-id case to started"
else
  echo "  FAIL H3b mutant: removing the id check should have started the agent anyway, but it did not -> $MUT_OUT"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
