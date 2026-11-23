#!/usr/bin/env bash
# restart-recovery-note.selftest.sh -- controls for restart-recovery-note.sh (card 7c1e6a65).
#
# Stands up a fake dashboard (same one-port-per-case pattern as fleet-nudger.selftest.sh, card
# f3757cc7) with a known set of in_progress cards, a known backlog, and a scratch land-run
# journal, points the real script at them via DASH/MARVEEN_MAIN/LAND_RUN_JOURNAL_FILE, and
# asserts the --dry-run PLAN lines and the --apply send/idempotency behaviour.
#
# No secrets, no writes outside a temp dir, never touches the live dashboard or the live journal.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/restart-recovery-note.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
ok() { echo "  ok   $1"; }
no() { echo "  FAIL $1"; fail=1; }

mkdir -p "$TMP/main/store"
echo "test-token" > "$TMP/main/store/.dashboard-token"

cat > "$TMP/fakeboard.py" <<'PYEOF'
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT_FILE, POSTS_FILE = sys.argv[1], sys.argv[2]
FAIL_POSTS_FILE = sys.argv[3]

CARDS = [
    # Two in_progress cards for the SAME agent (backend), inprog02 OLDER than inprog01 -- proves
    # oldest-first ordering (CYBERSEC NO-GO 37713, required assertion (b)), not just a single card.
    {'id': 'inprog02', 'status': 'in_progress', 'assignee': 'backend', 'created_at': 60},
    {'id': 'inprog01', 'status': 'in_progress', 'assignee': 'backend', 'created_at': 100},
    {'id': 'deadcard1', 'status': 'waiting', 'assignee': 'backend2', 'created_at': 50},
    {'id': 'donecard1', 'status': 'done', 'assignee': 'backend3', 'created_at': 10},
]
CARDS_BY_ID = {c['id']: c for c in CARDS}
# CYBERSEC NO-GO 37713 MEDIUM-1: the REAL GET /api/messages/backlog shape is {agent, pending,
# oldestAgeSeconds} (src/db.ts getPendingBacklogByAgent) -- the old fixture invented
# count/oldest_age_s, which do not exist on the real endpoint, so the selftest stayed green while
# the production script silently read "none" for every real agent.
BACKLOG = [
    {'agent': 'qa', 'pending': 2, 'oldestAgeSeconds': 500},
    {'agent': 'backend3', 'pending': 1, 'oldestAgeSeconds': 10},
]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/api/kanban?status=in_progress'):
            self._send([c for c in CARDS if c['status'] == 'in_progress'])
        elif self.path.startswith('/api/kanban/'):
            cid = self.path.split('/')[-1]
            rec = CARDS_BY_ID.get(cid)
            self._send(rec if rec else {}, 200 if rec else 404)
        elif self.path == '/api/messages/backlog':
            self._send(BACKLOG)
        else:
            self._send([])

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length)
        with open(POSTS_FILE, 'a') as f:
            f.write(body.decode() + "\n")
        # Toggle for the LOW-1 selftest case (CYBERSEC NO-GO 37713): a sentinel file makes every
        # POST answer 500 while still logging the attempt, so the test can assert the boot id was
        # NOT recorded after a failed send.
        if os.path.exists(FAIL_POSTS_FILE):
            self._send({'ok': False}, 500)
        else:
            self._send({'ok': True})


srv = HTTPServer(('127.0.0.1', 0), H)
with open(PORT_FILE, 'w') as _f:
    _f.write(str(srv.server_port))
srv.serve_forever()
PYEOF

PORT_FILE="$TMP/port"
POSTS_FILE="$TMP/posts.log"
touch "$POSTS_FILE"
FAIL_POSTS_FILE="$TMP/fail-posts"
python3 "$TMP/fakeboard.py" "$PORT_FILE" "$POSTS_FILE" "$FAIL_POSTS_FILE" &
BOARD_PID=$!
trap 'kill "$BOARD_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

BOARD_PORT=""
for _ in $(seq 1 40); do
  [ -s "$PORT_FILE" ] && BOARD_PORT="$(cat "$PORT_FILE")" && break
  sleep 0.25
done
[ -n "$BOARD_PORT" ] || { echo "FAIL: fake board never reported a port"; exit 1; }

DASH="http://127.0.0.1:$BOARD_PORT"
JOURNAL="$TMP/land-runs.jsonl"
: > "$JOURNAL"

run() {
  MARVEEN_MAIN="$TMP/main" DASH="$DASH" LAND_RUN_JOURNAL_FILE="$JOURNAL" \
    RESTART_RECOVERY_STATE_FILE="$TMP/boot-state" \
    RESTART_RECOVERY_BOOT_ID="${TEST_BOOT_ID:-boot-aaaa}" \
    bash "$SCRIPT" "$@" 2>&1
}

# 1. Plain in_progress cards -> appear in the plan, no backlog, OLDEST FIRST (inprog02 @60 before
#    inprog01 @100) -- required assertion (b).
out="$(run --dry-run)"
echo "$out" | grep -q "PLAN agent=backend cards=inprog02, inprog01 backlog=none" \
  && ok "in_progress cards show up for their owner, oldest first" \
  || no "in_progress cards missing or wrongly ordered in plan: $out"

# 2. A dead land run tied to a WAITING card -> that agent gains the card even with no in_progress
#    row of its own. pid 999999999 is never a real process.
printf '%s\n' '{"run_id":"r1","event":"started","script":"marveen-land.sh","agent":"backend2","card":"deadcard1","ts":1,"pid":999999999,"pid_start":"1"}' >> "$JOURNAL"
out="$(STALE_AFTER_SECONDS=1 run --dry-run)"
echo "$out" | grep -q "agent=backend2 cards=deadcard1" \
  && ok "killed land run on a waiting card surfaces for its agent" \
  || no "killed land run missing from plan: $out"

# 3. A dead land run tied to a DONE card (donecard1, backend3) must NOT surface -- the card moved
#    on since the run died, so the journal entry is stale info, not a live signal. backend3 DOES
#    have a backlog row, but it is not a gate agent, so it must not appear via backlog alone either.
printf '%s\n' '{"run_id":"r2","event":"started","script":"marveen-land.sh","agent":"backend3","card":"donecard1","ts":1,"pid":999999998,"pid_start":"1"}' >> "$JOURNAL"
out="$(STALE_AFTER_SECONDS=1 run --dry-run)"
echo "$out" | grep -q "agent=backend3" \
  && no "a done card's stale run, or a non-gate agent's bare backlog, leaked into the plan: $out" \
  || ok "done card's stale run and non-gate backlog-only agent correctly excluded"

# 4. Gate agent with backlog but no card -> included, cards=none, backlog count shown.
out="$(run --dry-run)"
echo "$out" | grep -q "agent=qa cards=none backlog=2 message(s)" \
  && ok "gate agent with only a backlog is included" \
  || no "gate-agent-by-backlog-only missing: $out"

# 5. --apply sends one POST per planned agent.
: > "$POSTS_FILE"
TEST_BOOT_ID="boot-bbbb" run --apply >/dev/null
sent_to="$(python3 -c "
import json
agents=set()
with open('$POSTS_FILE') as f:
    for line in f:
        line=line.strip()
        if not line: continue
        agents.add(json.loads(line)['to'])
print(','.join(sorted(agents)))
")"
[ "$sent_to" = "backend,backend2,qa" ] \
  && ok "--apply sends exactly to the planned agents (backend,backend2,qa)" \
  || no "--apply sent to the wrong set: got [$sent_to]"

# 5b. Required assertions (a) and (c) (CYBERSEC NO-GO 37713): inspect the qa note's own content
# field, not just its "to" -- (a) the REAL backlog count (2, from the "pending" key) reaches the
# text, and (c) the note starts with the [RESTART-RECOVERY] marker + the fixed text.
qa_content="$(python3 -c "
import json
with open('$POSTS_FILE') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if rec['to'] == 'qa':
            print(rec['content'])
            break
")"
echo "$qa_content" | grep -qF "Unread backlog: 2 message(s)" \
  && ok "(a) qa note shows the real backlog count (2 message(s), from the pending key)" \
  || no "(a) qa note missing the real backlog count: [$qa_content]"
case "$qa_content" in
  "[RESTART-RECOVERY] host restarted; check your worktree, git log and origin/develop before repeating any outward action (push, land, Telegram, comment)."*)
    ok "(c) note starts with [RESTART-RECOVERY] + the fixed text" ;;
  *)
    no "(c) note does not start with [RESTART-RECOVERY] + the fixed text: [$qa_content]" ;;
esac

# 6. Second --apply for the SAME boot id is a no-op (idempotent).
: > "$POSTS_FILE"
out="$(TEST_BOOT_ID="boot-bbbb" run --apply)"
[ ! -s "$POSTS_FILE" ] && echo "$out" | grep -q "already sent for boot boot-bbbb" \
  && ok "second --apply for the same boot id sends nothing" \
  || no "second --apply for the same boot id was not a no-op: posts=[$(cat "$POSTS_FILE")] out=[$out]"

# 7. A NEW boot id (simulated reboot) sends again.
: > "$POSTS_FILE"
TEST_BOOT_ID="boot-cccc" run --apply >/dev/null
[ -s "$POSTS_FILE" ] \
  && ok "a new boot id resends the recovery notes" \
  || no "a new boot id did not resend: posts file empty"

# 8. --dry-run never consults or writes the boot-id state file, even after an --apply recorded one.
rm -f "$TMP/boot-state"
TEST_BOOT_ID="boot-cccc" run --apply >/dev/null
[ -f "$TMP/boot-state" ] || { no "setup: boot-state not written"; }
out="$(TEST_BOOT_ID="boot-cccc" run --dry-run)"
echo "$out" | grep -q "^PLAN " \
  && ok "--dry-run still prints a plan even when --apply already recorded this boot id" \
  || no "--dry-run wrongly treated itself as already-sent: $out"

# 9. Required assertion (d): the no-argument (bare) invocation must behave exactly like --dry-run
# and post nothing.
: > "$POSTS_FILE"
run >/dev/null
[ ! -s "$POSTS_FILE" ] \
  && ok "(d) no-argument invocation posts nothing" \
  || no "(d) no-argument invocation posted something: $(cat "$POSTS_FILE")"

# 10. Required assertion (e): --dry-run posts nothing (explicit check on the POSTS_FILE itself,
# not inferred from other assertions).
: > "$POSTS_FILE"
run --dry-run >/dev/null
[ ! -s "$POSTS_FILE" ] \
  && ok "(e) --dry-run posts nothing" \
  || no "(e) --dry-run posted something: $(cat "$POSTS_FILE")"

# 11. LOW-1 (CYBERSEC NO-GO 37713): when a send does not come back 2xx, the boot id must NOT be
# recorded -- otherwise a transient dashboard failure permanently blocks the retry for that boot.
rm -f "$TMP/boot-state"
: > "$FAIL_POSTS_FILE"
out="$(TEST_BOOT_ID="boot-dddd" run --apply)"
rc=$?
rm -f "$FAIL_POSTS_FILE"
[ "$rc" -ne 0 ] \
  && ok "LOW-1: --apply exits non-zero when a send does not come back 2xx" \
  || no "LOW-1: --apply exited 0 despite a failed (500) send: $out"
[ ! -f "$TMP/boot-state" ] \
  && ok "LOW-1: boot id NOT recorded after a failed send (retry stays possible)" \
  || no "LOW-1: boot id was recorded despite a failed send: $(cat "$TMP/boot-state")"
# Positive control: with the board healthy again, the SAME boot id now sends and records fine.
: > "$POSTS_FILE"
out="$(TEST_BOOT_ID="boot-dddd" run --apply)"
[ -s "$POSTS_FILE" ] && [ -f "$TMP/boot-state" ] \
  && ok "LOW-1 positive control: once sends succeed, the same boot id sends and records normally" \
  || no "LOW-1 positive control failed: posts=[$(cat "$POSTS_FILE" 2>/dev/null)] state=[$(cat "$TMP/boot-state" 2>/dev/null)]"

kill "$BOARD_PID" 2>/dev/null

if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi
