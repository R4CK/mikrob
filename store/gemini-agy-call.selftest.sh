#!/usr/bin/env bash
# Self-test for store/gemini-agy-call.sh (card 64788453). Uses a throw-away MARVEEN_ROOT and a stub
# in place of the real seged-hivo.py call (SEGED_HIVO_SCRIPT), while the hourly-count logic still
# runs against the REAL seged-hivo.py (symlinked into the throw-away root) so read_log()/calls_of()
# are exercised for real, not reimplemented a second time just for the test.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SELF_DIR/gemini-agy-call.sh"
REAL_SEGED_HIVO="$SELF_DIR/../scripts/seged-hivo.py"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
mkdir -p "$TD/store" "$TD/scripts" "$TD/base/w"
ln -s "$(cd "$(dirname "$REAL_SEGED_HIVO")" && pwd)/$(basename "$REAL_SEGED_HIVO")" "$TD/scripts/seged-hivo.py"
echo 'teszt-token' > "$TD/store/.dashboard-token"
PROMPT="$TD/prompt.md"
echo 'Hozz letre egy hello.txt fajlt.' > "$PROMPT"

STUB="$TD/stub-seged-hivo.py"
cat > "$STUB" <<'PYEOF'
import argparse, json, os, sys, time
from datetime import datetime
from pathlib import Path
ap = argparse.ArgumentParser()
ap.add_argument('--seged'); ap.add_argument('--mappa'); ap.add_argument('--prompt')
ap.add_argument('--hivo'); ap.add_argument('--kartya'); ap.add_argument('--feladattipus')
ap.add_argument('--timeout', type=int, default=120)
a = ap.parse_args()
root = Path(os.environ['MARVEEN_ROOT'])
store = root / 'store'
store.mkdir(exist_ok=True)
log = store / 'seged-hivo-naplo.jsonl'
engine, _, model = a.seged.partition(':')
delay = float(os.environ.get('STUB_CALL_DELAY_S', '0'))
if delay:
    time.sleep(delay)
now = datetime.now().astimezone().isoformat(timespec='milliseconds')
status = 'error' if (root / 'FORCE_ERROR').exists() else 'ok'
row = {'ido': now, 'hivas_id': os.urandom(8).hex(), 'hivo': a.hivo, 'kartya': a.kartya,
       'seged': engine, 'modell': model, 'feladattipus': a.feladattipus, 'status': status,
       'exit': 0 if status == 'ok' else 1, 'duracio_s': 0.1, 'tokens_total': 42}
with open(log, 'a') as f:
    f.write(json.dumps(row) + '\n')
print('STUB RESPONSE')
sys.exit(0 if status == 'ok' else 1)
PYEOF

LOG="$TD/store/seged-hivo-naplo.jsonl"
fails=()
n=0

seed_recent() {  # seed_recent COUNT -- COUNT agy rows, "now"
  local count="$1" i
  : > "$LOG"
  for ((i = 0; i < count; i++)); do
    python3 -c "
import json
from datetime import datetime
print(json.dumps({'ido': datetime.now().astimezone().isoformat(timespec='milliseconds'),
                   'hivas_id': 'seed-$i', 'hivo': 'teszt', 'kartya': 'x', 'seged': 'agy',
                   'modell': 'gemini-3.8-flash-medium', 'feladattipus': 'kod', 'status': 'ok'}))
" >> "$LOG"
  done
}

seed_old() {  # seed_old COUNT -- COUNT agy rows, 2 hours ago (outside the 60-minute window)
  local count="$1" i
  : > "$LOG"
  for ((i = 0; i < count; i++)); do
    python3 -c "
import json
from datetime import datetime, timedelta
ts = (datetime.now().astimezone() - timedelta(hours=2)).isoformat(timespec='milliseconds')
print(json.dumps({'ido': ts, 'hivas_id': 'old-$i', 'hivo': 'teszt', 'kartya': 'x', 'seged': 'agy',
                   'modell': 'gemini-3.8-flash-medium', 'feladattipus': 'kod', 'status': 'ok'}))
" >> "$LOG"
  done
}

run() {
  MARVEEN_ROOT="$TD" SEGED_HIVO_SCRIPT="$STUB" DASHBOARD_TOKEN_FILE="$TD/store/.dashboard-token" \
    SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 GEMINI_DASHBOARD_URL="${GEMINI_DASHBOARD_URL:-http://127.0.0.1:1}" \
    "$SUT" "$@" > "$TD/out" 2> "$TD/err"
}

case_() {  # case_ NAME WANT_RC -- args...
  local name="$1" want="$2"; shift 2
  n=$((n + 1))
  set +e
  run "$@"
  local got=$?
  set -e
  if [ "$got" != "$want" ]; then
    fails+=("$name: want rc=$want got rc=$got; stderr: $(cat "$TD/err" | tr '\n' ' ')")
  fi
}

# --- argument validation --------------------------------------------------
: > "$LOG"
case_ 'missing --kategoria -> usage error' 2 \
  --hivo teszt --kartya x --feladattipus kod --prompt "$PROMPT" --mappa "$TD/base/w"

case_ 'unknown category -> refused, fail-closed' 3 \
  --hivo teszt --kartya x --feladattipus kod --kategoria nemletezo --prompt "$PROMPT" --mappa "$TD/base/w"

for cat in security auth finance mopsion; do
  case_ "forbidden category '$cat' -> refused" 3 \
    --hivo teszt --kartya x --feladattipus kod --kategoria "$cat" --prompt "$PROMPT" --mappa "$TD/base/w"
done
if [ -s "$LOG" ]; then
  fails+=("forbidden/unknown category must not write any log row, but $LOG is non-empty")
fi

# --- hourly fleet-wide quota -----------------------------------------------
seed_recent 4
case_ 'hourly: 4 recent agy calls -> 5th goes (control)' 0 \
  --hivo teszt --kartya x --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"
if ! grep -q 'STUB RESPONSE' "$TD/out"; then
  fails+=("hourly control: expected the stub to actually run, stdout was: $(cat "$TD/out")")
fi

seed_recent 5
case_ 'hourly: 5 recent agy calls -> 6th blocked, exit 5' 5 \
  --hivo teszt --kartya x --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"
if grep -q 'STUB RESPONSE' "$TD/out"; then
  fails+=("hourly block: the stub must NOT have run when the fleet is already at 5/5")
fi

seed_old 5
case_ 'hourly: 5 calls 2h ago (outside window) -> goes (control)' 0 \
  --hivo teszt --kartya x --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"

# a call blocked by seged-hivo.py's OWN gates (status=blocked) must not count toward the hourly cap
: > "$LOG"
python3 -c "
import json
from datetime import datetime
rows = [{'ido': datetime.now().astimezone().isoformat(timespec='milliseconds'), 'hivas_id': f'b{i}',
         'hivo': 'teszt', 'kartya': 'x', 'seged': 'agy', 'modell': 'm', 'feladattipus': 'kod',
         'status': 'blocked', 'blokk': 'kapu'} for i in range(5)]
with open('$LOG', 'w') as f:
    for r in rows:
        f.write(json.dumps(r) + chr(10))
"
case_ 'hourly: 5 BLOCKED agy rows do not count -> still goes' 0 \
  --hivo teszt --kartya x --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"

# --- concurrent callers must not exceed the hourly cap (QA FAIL, comment 18226) -----------------
# Repro of QA's exact scenario: 4 recent agy rows seeded (sent_count=4 < 5 limit), two wrapper
# invocations launched at the SAME instant with a delay in the underlying call to widen the race
# window. Before the fix both passed (6/5 final count); after the fix exactly one must go through
# and the other must be blocked with exit 5.
seed_recent 4
n=$((n + 1))
MARVEEN_ROOT="$TD" SEGED_HIVO_SCRIPT="$STUB" DASHBOARD_TOKEN_FILE="$TD/store/.dashboard-token" \
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 GEMINI_DASHBOARD_URL="${GEMINI_DASHBOARD_URL:-http://127.0.0.1:1}" \
  STUB_CALL_DELAY_S=0.3 GEMINI_AGY_HOURLY_LOCK="$TD/store/hourly.lock" \
  "$SUT" --hivo teszt --kartya a --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w" \
  > "$TD/race-a.out" 2> "$TD/race-a.err" &
PID_A=$!
MARVEEN_ROOT="$TD" SEGED_HIVO_SCRIPT="$STUB" DASHBOARD_TOKEN_FILE="$TD/store/.dashboard-token" \
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 GEMINI_DASHBOARD_URL="${GEMINI_DASHBOARD_URL:-http://127.0.0.1:1}" \
  STUB_CALL_DELAY_S=0.3 GEMINI_AGY_HOURLY_LOCK="$TD/store/hourly.lock" \
  "$SUT" --hivo teszt --kartya b --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w" \
  > "$TD/race-b.out" 2> "$TD/race-b.err" &
PID_B=$!
set +e
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
set -e
ok_count=0
[ "$RC_A" -eq 0 ] && ok_count=$((ok_count + 1))
[ "$RC_B" -eq 0 ] && ok_count=$((ok_count + 1))
blocked_count=0
[ "$RC_A" -eq 5 ] && blocked_count=$((blocked_count + 1))
[ "$RC_B" -eq 5 ] && blocked_count=$((blocked_count + 1))
if [ "$ok_count" -ne 1 ] || [ "$blocked_count" -ne 1 ]; then
  fails+=("concurrent race: want exactly 1 ok (rc=0) + 1 blocked (rc=5), got rc_a=$RC_A rc_b=$RC_B")
fi
final_sent=$(grep -c '"status": "ok"' "$LOG" 2>/dev/null || true)
if [ "$final_sent" != "5" ]; then
  fails+=("concurrent race: want final sent count 5 (4 seed + 1 winner), got $final_sent in $LOG")
fi

# --- error propagation from the underlying call ----------------------------
: > "$LOG"
touch "$TD/FORCE_ERROR"
case_ 'underlying call failing propagates its exit code' 1 \
  --hivo teszt --kartya x --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"
rm -f "$TD/FORCE_ERROR"

# --- daily-log posting: status reaches the log, prompt text never does ----
: > "$LOG"
CAPTURE="$TD/capture.json"
python3 - "$CAPTURE" > "$TD/stub-server-port" 2>/dev/null <<'PYEOF' &
import json, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
capture_path = sys.argv[1]

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with open(capture_path, 'w') as f:
            json.dump(body, f)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')
    def log_message(self, *a):
        pass

srv = HTTPServer(('127.0.0.1', 0), H)
print(srv.server_port, flush=True)
srv.handle_request()
PYEOF
SRV_PID=$!
# wait for the stub server to print its port (bounded: this stub serves exactly one request)
for _ in $(seq 1 50); do
  [ -s "$TD/stub-server-port" ] && break
  sleep 0.1
done
PORT="$(cat "$TD/stub-server-port" 2>/dev/null || echo '')"
if [ -z "$PORT" ]; then
  fails+=("daily-log capture: stub HTTP server never printed a port")
else
  n=$((n + 1))
  MARVEEN_ROOT="$TD" SEGED_HIVO_SCRIPT="$STUB" DASHBOARD_TOKEN_FILE="$TD/store/.dashboard-token" \
    SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 GEMINI_DASHBOARD_URL="http://127.0.0.1:$PORT" \
    "$SUT" --hivo teszt --kartya kartya-123 --feladattipus kod --kategoria safe \
    --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err" || true
  wait "$SRV_PID" 2>/dev/null || true
  if [ ! -s "$CAPTURE" ]; then
    fails+=("daily-log capture: no POST body was captured")
  else
    body="$(cat "$CAPTURE")"
    if ! echo "$body" | grep -q 'kartya-123'; then
      fails+=("daily-log capture: card id missing from the logged content: $body")
    fi
    if echo "$body" | grep -qi 'hello.txt'; then
      fails+=("daily-log capture: prompt TEXT leaked into the daily-log content: $body")
    fi
  fi
fi

for f in "${fails[@]}"; do
  echo "FAIL: $f"
done
echo "gemini-agy-call.selftest: $n passed, ${#fails[@]} failed"
[ "${#fails[@]}" -eq 0 ]
