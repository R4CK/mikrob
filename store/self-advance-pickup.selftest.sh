#!/usr/bin/env bash
# self-advance-pickup.selftest.sh -- does the single self-advance entry point (card 3906d77b) hold
# its one hard invariant: PICKUP NEVER BLOCKS ON DRAFTING?
#
# A FAKE DASHBOARD, never localhost:3420 -- same discipline as card-build-route-24h-measure.selftest.sh:
# this script makes exactly one network call (the move POST), and a selftest must never depend on, or
# mutate, the live board.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/self-advance-pickup.sh"
TMP="$(mktemp -d)"

PASS=0; FAIL=0
declare -a FAILED=()

# --- fake dashboard: POST /api/kanban/<id>/move -> 200 unless FAIL_MOVE file exists; records the
# last request body to $TMP/last-move-body.json --------------------------------------------------
mkdir -p "$TMP/reqs"
cat > "$TMP/fake-dashboard.py" <<'PYEOF'
import http.server, sys, os
DIR = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''
        with open(os.path.join(DIR, 'last-move-body.json'), 'wb') as f:
            f.write(body)
        code = 500 if os.path.exists(os.path.join(DIR, 'FAIL_MOVE')) else 200
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(b'{"ok":true}' if code == 200 else b'{"error":"boom"}')
port = int(sys.argv[1])
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PYEOF

port=$((22000 + RANDOM % 9000))
python3 "$TMP/fake-dashboard.py" "$port" "$TMP/reqs" &
server_pid=$!
sleep 0.3
trap 'kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; rm -rf "$TMP"' EXIT
printf 'throwaway-not-real\n' > "$TMP/fake-token"

# --- stubs -------------------------------------------------------------------------------------
# Ollama health: exit 0 = up, exit 2 = down (mirrors local-llm.sh --health's own contract).
printf '#!/usr/bin/env bash\n[ "${1:-}" = "--health" ] && exit 0\nexit 4\n' > "$TMP/llm-up.sh"
printf '#!/usr/bin/env bash\n[ "${1:-}" = "--health" ] && exit 2\nexit 4\n' > "$TMP/llm-down.sh"
# card-build-route.sh stub: echoes a fixed verdict, records whether DISPATCHER was passed through.
printf '#!/usr/bin/env bash\necho "${CARD_BUILD_ROUTE_DISPATCHER:-unset}" > "%s/route-saw-dispatcher"\necho LOCAL\n' "$TMP" > "$TMP/route-local.sh"
printf '#!/usr/bin/env bash\necho "${CARD_BUILD_ROUTE_DISPATCHER:-unset}" > "%s/route-saw-dispatcher"\necho ONLINE\n' "$TMP" > "$TMP/route-online.sh"
# offload-dispatch.sh stub: just proves it was (or was not) invoked.
printf '#!/usr/bin/env bash\ntouch "%s/offload-was-called"\n' "$TMP" > "$TMP/offload-stub.sh"
chmod +x "$TMP"/*.sh

CARD="abcdef0123456789"

run() { # env overrides via caller, then the two positional args
  rm -f "$TMP/offload-was-called" "$TMP/route-saw-dispatcher" "$TMP/reqs/last-move-body.json"
  SELF_ADVANCE_PICKUP_LLM="${STUB_LLM:-$TMP/llm-up.sh}" \
  SELF_ADVANCE_PICKUP_ROUTE="${STUB_ROUTE:-$TMP/route-online.sh}" \
  SELF_ADVANCE_PICKUP_OFFLOAD="${STUB_OFFLOAD:-$TMP/offload-stub.sh}" \
  SELF_ADVANCE_PICKUP_API="http://127.0.0.1:$port" \
  SELF_ADVANCE_PICKUP_TOKEN_FILE="${STUB_TOKEN:-$TMP/fake-token}" \
  SELF_ADVANCE_PICKUP_FLAG_FILE="${STUB_FLAG:-$TMP/nonexistent-flag.json}" \
  SELF_ADVANCE_PICKUP_LOG="$TMP/route.log" \
  LOCAL_FIRST_DRAFT="${STUB_LOCAL_FIRST_DRAFT:-}" \
    bash "$SCRIPT" "${1:-backend2}" "${2:-$CARD}"
}

assert_moved() { # $1 label -- the move POST reached the fake dashboard with status=in_progress
  if [ -s "$TMP/reqs/last-move-body.json" ] && grep -q '"status": *"in_progress"' "$TMP/reqs/last-move-body.json"; then
    PASS=$((PASS+1)); printf 'OK   moved to in_progress                    %s\n' "$1"
  else
    FAIL=$((FAIL+1)); FAILED+=("$1 (no in_progress move reached the fake dashboard)")
    printf 'FAIL no in_progress move reached the dashboard  %s\n' "$1"
  fi
}
assert_not_moved() { # $1 label
  if [ ! -s "$TMP/reqs/last-move-body.json" ]; then
    PASS=$((PASS+1)); printf 'OK   no move attempted                       %s\n' "$1"
  else
    FAIL=$((FAIL+1)); FAILED+=("$1 (a move reached the dashboard, expected none)")
    printf 'FAIL a move reached the dashboard, expected none  %s\n' "$1"
  fi
}
assert_offload_called() { # $1 expect(yes|no) $2 label
  local called=no; [ -f "$TMP/offload-was-called" ] && called=yes
  if [ "$called" = "$1" ]; then
    PASS=$((PASS+1)); printf 'OK   offload-dispatch called=%-4s            %s\n' "$1" "$2"
  else
    FAIL=$((FAIL+1)); FAILED+=("$2 (wanted offload-dispatch called=$1, got $called)")
    printf 'FAIL offload-dispatch called=%s wanted %s      %s\n' "$called" "$1" "$2"
  fi
}
assert_dispatcher_seen() { # $1 expected $2 label
  local got; got="$(cat "$TMP/route-saw-dispatcher" 2>/dev/null || echo none)"
  if [ "$got" = "$1" ]; then
    PASS=$((PASS+1)); printf 'OK   card-build-route saw DISPATCHER=%-14s %s\n' "$1" "$2"
  else
    FAIL=$((FAIL+1)); FAILED+=("$2 (wanted DISPATCHER=$1, got $got)")
    printf 'FAIL DISPATCHER=%s wanted %s                 %s\n' "$got" "$1" "$2"
  fi
}
assert_exit() { # $1 got-rc $2 expected-rc $3 label
  if [ "$1" -eq "$2" ]; then
    PASS=$((PASS+1)); printf 'OK   exit %-3s                                %s\n' "$1" "$3"
  else
    FAIL=$((FAIL+1)); FAILED+=("$3 (wanted exit $2, got $1)")
    printf 'FAIL exit %s wanted %s                        %s\n' "$1" "$2" "$3"
  fi
}

echo "=== A. THE HARD INVARIANT: pickup always happens, whatever step 1-4 decide ==="
STUB_ROUTE="$TMP/route-online.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "ONLINE verdict -> still picks up"
assert_moved "ONLINE verdict"
assert_offload_called no "ONLINE verdict never drafts"
assert_dispatcher_seen self-advance "card-build-route.sh sees the attribution env var"

STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "LOCAL verdict -> picks up AND drafts"
assert_moved "LOCAL verdict"
assert_offload_called yes "LOCAL verdict triggers offload-dispatch"

echo
echo "=== B. FLAG OFF -- skips the draft entirely, still picks up (grilling point 2) ==="
STUB_LOCAL_FIRST_DRAFT=off STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "flag off -> still picks up"
assert_moved "flag off"
assert_offload_called no "flag off never even asks the router"

echo
echo "=== B2. FLAG FILE (no env var) -- store/local-first-draft.json {\"enabled\":false} ==="
printf '{"enabled":false}\n' > "$TMP/flag-off.json"
STUB_FLAG="$TMP/flag-off.json" STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "flag-file off -> still picks up"
assert_offload_called no "flag-file off never asks the router"

echo
echo "=== C. OLLAMA DOWN -- skips the draft, NEVER blocks pickup (grilling point 3) ==="
STUB_LLM="$TMP/llm-down.sh" STUB_ROUTE="$TMP/route-local.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 0 "ollama down -> still picks up"
assert_moved "ollama down"
assert_offload_called no "ollama down never reaches the router or offload-dispatch"

echo
echo "=== D. BAD USAGE -- exit 2, never touches the board ==="
rm -f "$TMP/reqs/last-move-body.json"
bash "$SCRIPT" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 2 "no arguments at all"
assert_not_moved "no arguments"

rm -f "$TMP/reqs/last-move-body.json"
SELF_ADVANCE_PICKUP_API="http://127.0.0.1:$port" bash "$SCRIPT" backend2 "not-a-hex-id!!" >/dev/null 2>&1; rc=$?
assert_exit "$rc" 2 "bad card id"
assert_not_moved "bad card id"

echo
echo "=== E. PUT in_progress ITSELF FAILS -- the one failure the caller must see (exit 1) ==="
touch "$TMP/reqs/FAIL_MOVE"
STUB_ROUTE="$TMP/route-online.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 1 "dashboard 500s the move"
rm -f "$TMP/reqs/FAIL_MOVE"

echo
echo "=== F. NO TOKEN -- exit 1, never attempts the move ==="
printf '' > "$TMP/empty-token"
rm -f "$TMP/reqs/last-move-body.json"
STUB_TOKEN="$TMP/empty-token" STUB_ROUTE="$TMP/route-online.sh" run >/dev/null 2>&1; rc=$?
assert_exit "$rc" 1 "empty token file"
assert_not_moved "empty token file"

echo
echo "-------------------------------------------------------------"
echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All cases passed."
exit 0
