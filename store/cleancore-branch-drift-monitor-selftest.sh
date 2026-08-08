#!/usr/bin/env bash
# cleancore-branch-drift-monitor-selftest.sh -- controls for cleancore-branch-drift-monitor.sh
# (card cf3c25ea). Fully sandboxed: own repo, own state file, own fake dashboard for the alert
# path. The real CleanCore checkout and the real dashboard are never touched.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="$HERE/cleancore-branch-drift-monitor.sh"
SB="$(mktemp -d "$HOME/fullstack-driftmon-XXXXXX")"
trap 'rm -rf "$SB"' EXIT
fail=0

mkrepo() { # $1 = dir -> a repo with origin/main and one WRONG branch (upstream=origin/main, no
           # matching origin/<branch>)
  git init -q "$1"
  git -C "$1" -c user.email=a@b -c user.name=t commit -q --allow-empty -m one
  git -C "$1" branch -M main
  git init -q --bare "$1.origin"
  git -C "$1" remote add origin "$1.origin"
  git -C "$1" push -q origin main
  git -C "$1" checkout -q -b "landing/probe1"
  git -C "$1" branch -q --set-upstream-to=origin/main "landing/probe1"
  git -C "$1" checkout -q main
}

fix_branch() { # $1 = repo dir, $2 = branch -> makes it clean (unset upstream, like --fix would)
  git -C "$1" branch --unset-upstream "$2" 2>/dev/null || true
}

add_wrong_branch() { # $1 = repo dir, $2 = new branch name -> another WRONG branch
  git -C "$1" checkout -q -b "$2"
  git -C "$1" branch -q --set-upstream-to=origin/main "$2"
  git -C "$1" checkout -q main
}

run() { # $1 = repo, $2 = state file, $3 = fake dash url, extra args...
  local repo="$1" state="$2" dash="$3"; shift 3
  CC_REPO="$repo" CC_DRIFT_STATE="$state" CC_DRIFT_DASH="$dash" bash "$MONITOR" "$@" 2>&1
}

cat > "$SB/fakeboard.py" <<'PYEOF'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
PORT = int(sys.argv[1])
LOG = sys.argv[2]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n)
        with open(LOG, 'ab') as f:
            f.write(body + b'\n')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PYEOF

PORT=38820
LOG="$SB/alerts.log"
python3 "$SB/fakeboard.py" "$PORT" "$LOG" &
FAKEPID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break; sleep 0.1; done
DASH="http://127.0.0.1:$PORT"

echo "cleancore-branch-drift-monitor.sh selftest (card cf3c25ea)"

REPO="$SB/repo"; STATE="$SB/state.json"
mkrepo "$REPO"

# --- Case 1: first run -> baseline recorded, NO alert (the bug caught and fixed before shipping) -
out="$(run "$REPO" "$STATE" "$DASH")"
if echo "$out" | grep -q "RESULT:OK (baseline recorded"; then echo "  ok   first run: baseline, no false WORSENED"
else echo "  FAIL first run -> $out"; fail=1; fi
[ -s "$LOG" ] && { echo "  FAIL first run sent an alert (it must not)"; fail=1; } || echo "  ok   first run sent no alert"

# --- Case 2: same drift again -> OK, no alert (a monitor that shouts about known drift every run
#     is muted by the operator, which is worse than not monitoring) -----------------------------
out="$(run "$REPO" "$STATE" "$DASH")"
echo "$out" | grep -q "^RESULT:OK$" && echo "  ok   unchanged drift -> OK" || { echo "  FAIL unchanged drift -> $out"; fail=1; }
[ -s "$LOG" ] && { echo "  FAIL unchanged drift sent an alert"; fail=1; } || echo "  ok   unchanged drift sent no alert"

# --- Case 3: a NEW branch drifts -> WORSENED, alert DOES fire, with the new name in it -----------
add_wrong_branch "$REPO" "landing/probe2"
out="$(run "$REPO" "$STATE" "$DASH")"
echo "$out" | grep -q "^RESULT:WORSENED$" && echo "  ok   new drift -> WORSENED" || { echo "  FAIL new drift -> $out"; fail=1; }
if [ -s "$LOG" ] && grep -q "landing/probe2" "$LOG"; then echo "  ok   alert fired and names the new branch"
else echo "  FAIL alert missing or does not name landing/probe2 (log: $(cat "$LOG" 2>/dev/null))"; fail=1; fi
: > "$LOG"

# --- Case 4: one of the two gets fixed, no NEW branch -> IMPROVED, no alert ----------------------
fix_branch "$REPO" "landing/probe1"
out="$(run "$REPO" "$STATE" "$DASH")"
echo "$out" | grep -q "^RESULT:IMPROVED$" && echo "  ok   fewer drifted branches -> IMPROVED" || { echo "  FAIL improved case -> $out"; fail=1; }
[ -s "$LOG" ] && { echo "  FAIL improved case sent an alert"; fail=1; } || echo "  ok   improved case sent no alert"

# --- Case 5: --status prints the recorded state without re-measuring ----------------------------
out="$(run "$REPO" "$STATE" "$DASH" --status)"
echo "$out" | grep -q "landing/probe2" && echo "  ok   --status reflects the last measurement" \
  || { echo "  FAIL --status missing expected content: $out"; fail=1; }

# --- Case 6: alert isolation -- an unreachable DASH must not crash a WORSENING run. Cases 1-4
#     already prove the override actually redirects delivery to a real endpoint that DOES receive
#     it (the stronger proof). This case needs its OWN pre-seeded baseline: a fresh state file
#     would hit the first-run path, which never even tries to alert, so it would pass vacuously
#     without exercising the curl-to-unreachable-DASH branch at all -- caught while writing this.
REPO6="$SB/repo6"; STATE6="$SB/state6.json"
mkrepo "$REPO6"
run "$REPO6" "$STATE6" "$DASH" >/dev/null   # seed a real baseline first (not first-run)
add_wrong_branch "$REPO6" "landing/probe3"  # now worsen it
out2="$(CC_REPO="$REPO6" CC_DRIFT_STATE="$STATE6" CC_DRIFT_DASH="http://127.0.0.1:1" bash "$MONITOR" 2>&1)"
if echo "$out2" | grep -q "^RESULT:WORSENED$" && echo "$out2" | grep -q "could not reach the message API"; then
  echo "  ok   unreachable DASH on a real WORSENING still fails closed with the documented note"
else echo "  FAIL unreachable DASH -> $out2"; fail=1; fi

kill "$FAKEPID" 2>/dev/null; wait "$FAKEPID" 2>/dev/null

[ $fail -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
