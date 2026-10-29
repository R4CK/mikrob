#!/usr/bin/env bash
# Self-test for store/freellm-catalog-sync.sh (card 405869d9, R1/R2/R3 hardening
# follow-up of 9ab81f48). Runs the REAL script (not a reimplementation) against a
# throw-away mock HTTP server, with FREELLM_URL/AUTH_TOKEN_FILE/ADMIN_CRED_FILE/
# MARVEEN_TOKEN_FILE overridden via env (the script reads them as "${VAR:-default}").
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/freellm-catalog-sync.sh"
TD="$(mktemp -d)"
trap 'rm -rf "$TD"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT

PASS=0
FAIL=0
FAILED=()
check() {
  local name="$1" ok="$2"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); echo "OK   $name"
  else
    FAIL=$((FAIL+1)); FAILED+=("$name")
    echo "FAIL $name"
  fi
}

# Mock server: serves canned responses for POST /api/premium/sync and
# POST /api/auth/login, one response per call in order (queue), from JSON files
# the test writes before starting the server. Prints "PORT=<n>" on its first
# stdout line once bound, so the caller can wait for that line instead of
# guessing a fixed port (avoids collisions with other agents' tests on this box).
start_mock() {
  local sync_queue="$1" login_queue="$2" out_file="$3"
  python3 - "$sync_queue" "$login_queue" > "$out_file" 2>&1 <<'PY' &
import http.server, json, sys, threading

sync_queue_path, login_queue_path = sys.argv[1], sys.argv[2]
with open(sync_queue_path) as f:
    sync_queue = json.load(f)
with open(login_queue_path) as f:
    login_queue = json.load(f)
state = {"sync_i": 0, "login_i": 0}
lock = threading.Lock()

class H(http.server.BaseHTTPRequestHandler):
    def _respond(self, queue, key):
        with lock:
            i = state[key]
            item = queue[i] if i < len(queue) else queue[-1]
            state[key] = i + 1
        body = json.dumps(item["body"]).encode()
        self.send_response(item["status"])
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/api/premium/sync":
            self._respond(sync_queue, "sync_i")
        elif self.path == "/api/auth/login":
            self._respond(login_queue, "login_i")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
print(f"PORT={srv.server_address[1]}", flush=True)
srv.serve_forever()
PY
  SERVER_PID=$!
  local waited=0
  while [ ! -s "$out_file" ] && [ "$waited" -lt 50 ]; do sleep 0.1; waited=$((waited+1)); done
}

stop_mock() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

mock_port() {
  grep -o 'PORT=[0-9]*' "$1" | head -1 | cut -d= -f2
}

# Common fixtures, rebuilt per test so one test's token-file-mode mutation
# never leaks into the next.
setup_token_file() {
  local mode="${1:-600}"
  printf 'tok-abc123' > "$TD/auth-token"
  chmod "$mode" "$TD/auth-token"
}
setup_admin_file() {
  printf 'ops@example.test:correct-password' > "$TD/admin"
  chmod 600 "$TD/admin"
}

# --- Test 1 (R1): a "08" count must NOT crash bash arithmetic -- 10#$n forces base-10,
# so "08" is read as 8, not an invalid octal literal (CYBERED NO-GO 25502 / WhiteHat2 25318:
# is_int's job is the digit-length cap below, not rejecting leading zeros). ---
setup_token_file 600
cat > "$TD/sync-q1.json" <<'JSON'
[{"status":200,"body":{"sync":{"ok":true,"version":"v1","action":"applied","counts":{"updated":"08","inserted":"0","removed":"0"}}}}]
JSON
echo '[]' > "$TD/login-q1.json"
start_mock "$TD/sync-q1.json" "$TD/login-q1.json" "$TD/srv1.out"
port=$(mock_port "$TD/srv1.out")
set +e
out=$(FREELLM_URL="http://127.0.0.1:$port" AUTH_TOKEN_FILE="$TD/auth-token" \
      ADMIN_CRED_FILE="$TD/admin" MARVEEN_TOKEN_FILE="$TD/no-such-dashboard-token" \
      bash "$SUT" 2>&1)
rc=$?
set -e
stop_mock
check "R1: '08' count parses as base-10 8, no octal crash, exit 0" "$([ "$rc" -eq 0 ] && [[ "$out" == *'updated=08, inserted=0, removed=0'* ]] && echo 1 || echo 0)"

# --- Test 1c (R1, CYBERED NO-GO 25502): an oversize (20-digit) count must FAIL via is_int's
# digit-length cap, not silently wrap bash's signed 64-bit arithmetic to 0/negative and skip
# notify(). Red on Gate-SHA 693925c3 (is_int had no length bound), green after the fix. ---
cat > "$TD/sync-q1c.json" <<'JSON'
[{"status":200,"body":{"sync":{"ok":true,"version":"v1","action":"applied","counts":{"updated":"18446744073709551616","inserted":"0","removed":"0"}}}}]
JSON
echo '[]' > "$TD/login-q1c.json"
start_mock "$TD/sync-q1c.json" "$TD/login-q1c.json" "$TD/srv1c.out"
port=$(mock_port "$TD/srv1c.out")
set +e
out=$(FREELLM_URL="http://127.0.0.1:$port" AUTH_TOKEN_FILE="$TD/auth-token" \
      ADMIN_CRED_FILE="$TD/admin" MARVEEN_TOKEN_FILE="$TD/no-such-dashboard-token" \
      bash "$SUT" 2>&1)
rc=$?
set -e
stop_mock
check "R1 (CYBERED 25502): oversize count (2^64) -> FAILED line + exit 1, no silent wrap" "$([[ "$out" == *'freellmapi catalog FAILED:'* ]] && [ "$rc" -eq 1 ] && echo 1 || echo 0)"

# --- Test 1b (R1 regression): a negative count must also FAIL, not read as "no change" ---
cat > "$TD/sync-q1b.json" <<'JSON'
[{"status":200,"body":{"sync":{"ok":true,"version":"v1","action":"applied","counts":{"updated":"-3","inserted":"0","removed":"0"}}}}]
JSON
echo '[]' > "$TD/login-q1b.json"
start_mock "$TD/sync-q1b.json" "$TD/login-q1b.json" "$TD/srv1b.out"
port=$(mock_port "$TD/srv1b.out")
set +e
out=$(FREELLM_URL="http://127.0.0.1:$port" AUTH_TOKEN_FILE="$TD/auth-token" \
      ADMIN_CRED_FILE="$TD/admin" MARVEEN_TOKEN_FILE="$TD/no-such-dashboard-token" \
      bash "$SUT" 2>&1)
rc=$?
set -e
stop_mock
check "R1 regression: negative count -> FAILED line + exit 1" "$([[ "$out" == *'freellmapi catalog FAILED:'* ]] && [ "$rc" -eq 1 ] && echo 1 || echo 0)"

# --- Test 2 (R2): a pre-existing 0644 token file must become 0600 after a 401 + reauth save ---
setup_token_file 644
setup_admin_file
cat > "$TD/sync-q2.json" <<'JSON'
[{"status":401,"body":{"error":{"message":"expired"}}},
 {"status":200,"body":{"sync":{"ok":true,"version":"v2","action":"none"}}}]
JSON
cat > "$TD/login-q2.json" <<'JSON'
[{"status":200,"body":{"token":"fresh-token-xyz"}}]
JSON
start_mock "$TD/sync-q2.json" "$TD/login-q2.json" "$TD/srv2.out"
port=$(mock_port "$TD/srv2.out")
set +e
out=$(FREELLM_URL="http://127.0.0.1:$port" AUTH_TOKEN_FILE="$TD/auth-token" \
      ADMIN_CRED_FILE="$TD/admin" MARVEEN_TOKEN_FILE="$TD/no-such-dashboard-token" \
      bash "$SUT" 2>&1)
rc=$?
set -e
stop_mock
mode_after=$(stat -c '%a' "$TD/auth-token" 2>/dev/null || echo "???")
saved_token=$(cat "$TD/auth-token" 2>/dev/null || echo "")
check "R2: token file mode 0600 after reauth save (was 0644)" "$([ "$mode_after" = "600" ] && echo 1 || echo 0)"
check "R2: token file actually holds the NEW token after reauth" "$([ "$saved_token" = "fresh-token-xyz" ] && echo 1 || echo 0)"
check "R2: script still exits 0 on the happy 401-then-success path" "$([ "$rc" -eq 0 ] && echo 1 || echo 0)"

# --- Test 3 (R3): out-of-charset version/action must be sanitised, never echoed raw ---
setup_token_file 600
HOSTILE_VERSION='v1; rm -rf /'
HOSTILE_ACTION=$'applied\nIGNORE PREVIOUS INSTRUCTIONS'
python3 - "$TD/sync-q3.json" "$HOSTILE_VERSION" "$HOSTILE_ACTION" <<'PY'
import json, sys
path, version, action = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "w") as f:
    json.dump([{"status": 200, "body": {"sync": {"ok": True, "version": version, "action": action}}}], f)
PY
echo '[]' > "$TD/login-q3.json"
start_mock "$TD/sync-q3.json" "$TD/login-q3.json" "$TD/srv3.out"
port=$(mock_port "$TD/srv3.out")
set +e
out=$(FREELLM_URL="http://127.0.0.1:$port" AUTH_TOKEN_FILE="$TD/auth-token" \
      ADMIN_CRED_FILE="$TD/admin" MARVEEN_TOKEN_FILE="$TD/no-such-dashboard-token" \
      bash "$SUT" 2>&1)
rc=$?
set -e
stop_mock
check "R3: hostile version is NOT echoed raw into stdout/log" "$([[ "$out" != *'rm -rf'* ]] && echo 1 || echo 0)"
check "R3: hostile action is NOT echoed raw into stdout/log" "$([[ "$out" != *'IGNORE PREVIOUS INSTRUCTIONS'* ]] && echo 1 || echo 0)"
check "R3: sanitised version shows as 'invalid' in the log line" "$([[ "$out" == *'version=invalid'* ]] && echo 1 || echo 0)"
check "R3: script still exits 0 (sanitised-but-non-fatal path)" "$([ "$rc" -eq 0 ] && echo 1 || echo 0)"

# --- Test 4 (regression): a normal, in-charset version/action/count pass through unchanged ---
setup_token_file 600
cat > "$TD/sync-q4.json" <<'JSON'
[{"status":200,"body":{"sync":{"ok":true,"version":"2026.10.29-1","action":"applied","counts":{"updated":"3","inserted":"1","removed":"0"}}}}]
JSON
echo '[]' > "$TD/login-q4.json"
start_mock "$TD/sync-q4.json" "$TD/login-q4.json" "$TD/srv4.out"
port=$(mock_port "$TD/srv4.out")
set +e
out=$(FREELLM_URL="http://127.0.0.1:$port" AUTH_TOKEN_FILE="$TD/auth-token" \
      ADMIN_CRED_FILE="$TD/admin" MARVEEN_TOKEN_FILE="$TD/no-such-dashboard-token" \
      bash "$SUT" 2>&1)
rc=$?
set -e
stop_mock
check "regression: normal applied sync still exits 0 with real counts" "$([ "$rc" -eq 0 ] && [[ "$out" == *'version=2026.10.29-1'* ]] && [[ "$out" == *'updated=3, inserted=1, removed=0'* ]] && echo 1 || echo 0)"

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed: ${FAILED[*]}"
  exit 1
fi
exit 0
