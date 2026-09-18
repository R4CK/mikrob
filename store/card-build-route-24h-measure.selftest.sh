#!/usr/bin/env bash
# card-build-route-24h-measure.selftest.sh -- does the measurement count what it claims to count?
# (card 3c075d74)
#
# A FAKE DASHBOARD, never localhost:3420 -- the same discipline as card-build-route.selftest.sh's
# vram_fake_dashboard: this script makes exactly one network call per content-considered card (to
# read its comments), and a selftest must never depend on, or mutate, the live board.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/card-build-route-24h-measure.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
declare -a FAILED=()

now_epoch="$(date +%s)"
now_fmt() { date -d "@$1" '+%Y-%m-%d %H:%M:%S'; }

# --- fake dashboard: GET /api/kanban/<id>/comments -> $TMP/comments/<id>.json (default: []) --------
mkdir -p "$TMP/comments"
cat > "$TMP/fake-dashboard.py" <<'PYEOF'
import http.server, sys, os
DIR = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        parts = self.path.strip('/').split('/')
        card = parts[2] if len(parts) >= 4 else '?'
        path = os.path.join(DIR, card + '.json')
        body = b'[]'
        if os.path.exists(path):
            with open(path, 'rb') as f:
                body = f.read()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(body)
port = int(sys.argv[1])
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PYEOF

port=$((21000 + RANDOM % 9000))
python3 "$TMP/fake-dashboard.py" "$port" "$TMP/comments" &
server_pid=$!
sleep 0.3
trap 'kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; rm -rf "$TMP"' EXIT
printf 'throwaway-not-real\n' > "$TMP/fake-token"

run() { # writes $TMP/log from stdin, runs the script against the fake dashboard, prints its stdout
  cat > "$TMP/log"
  CARD_BUILD_ROUTE_MEASURE_LOG="$TMP/log" \
  CARD_BUILD_ROUTE_MEASURE_API="http://127.0.0.1:$port" \
  CARD_BUILD_ROUTE_MEASURE_TOKEN_FILE="$TMP/fake-token" \
    bash "$SCRIPT" "$@"
}

field() { python3 -c "import json,sys; print(json.load(sys.stdin)[sys.argv[1]])" "$1"; }

assert_field() { # $1 json, $2 field, $3 expected, $4 label
  local got; got="$(printf '%s' "$1" | field "$2")"
  if [ "$got" = "$3" ]; then
    PASS=$((PASS+1)); printf 'OK   %-22s = %-4s  %s\n' "$2" "$got" "$4"
  else
    FAIL=$((FAIL+1)); FAILED+=("$4 ($2: wanted $3, got $got)")
    printf 'FAIL %-22s = %-4s  wanted %-4s  %s\n' "$2" "$got" "$3" "$4"
  fi
}

echo "=== A. NO LOG AT ALL -- reports zero, does not error ==="
out="$(CARD_BUILD_ROUTE_MEASURE_LOG="/nonexistent/$RANDOM.log" CARD_BUILD_ROUTE_MEASURE_API="http://127.0.0.1:$port" bash "$SCRIPT" --json 2>&1)"
rc=$?
assert_field "$out" dispatches 0 "no log -> zero dispatches"
if [ "$rc" -eq 0 ]; then PASS=$((PASS+1)); echo "OK   exit 0 with no log"; else FAIL=$((FAIL+1)); FAILED+=("exit code with no log"); echo "FAIL exit $rc with no log"; fi

echo
echo "=== B. CAPACITY REASONS ARE EXCLUDED FROM content_considered ==="
out="$(run --json <<EOF
$(now_fmt "$now_epoch")	aaaa000000000000000000000000000000000a	ONLINE	vram-hold	calls=0	chars=10
$(now_fmt "$now_epoch")	bbbb000000000000000000000000000000000b	ONLINE	model-busy	calls=1	chars=10
EOF
)"
assert_field "$out" dispatches 2 "B: two capacity-only dispatches counted"
assert_field "$out" capacity_skipped 2 "B: both were capacity-skipped"
assert_field "$out" content_considered 0 "B: none were content decisions"

echo
echo "=== C. THE FOUR CONTENT OUTCOMES, ONE CARD EACH ==="
cardA=cccc0000000000000000000000000000000001  # LOCAL, drafted, continued (ELFOGADVA)
cardB=cccc0000000000000000000000000000000002  # ONLINE/deterministic-*, drafted, rejected (ELUTASITVA)
cardC=cccc0000000000000000000000000000000003  # LOCAL, drafted, still pending (no review yet)
cardD=cccc0000000000000000000000000000000004  # ONLINE, content decision, NO draft ever posted

cat > "$TMP/comments/$cardA.json" <<JSON
[{"author":"local-llm","content":"[LOCAL-LLM DRAFT | dispatch-offload] ...","created_at":$now_epoch},
 {"author":"backend","content":"Draft-Review: ELFOGADVA, beepitve.","created_at":$((now_epoch+10))}]
JSON
cat > "$TMP/comments/$cardB.json" <<JSON
[{"author":"local-llm","content":"[LOCAL-LLM DRAFT | dispatch-offload] ...","created_at":$now_epoch},
 {"author":"backend2","content":"Draft-Review: ELUTASITVA, nem volt hasznalhato.","created_at":$((now_epoch+10))}]
JSON
cat > "$TMP/comments/$cardC.json" <<JSON
[{"author":"local-llm","content":"[LOCAL-LLM DRAFT | dispatch-offload] ...","created_at":$now_epoch}]
JSON
cat > "$TMP/comments/$cardD.json" <<JSON
[]
JSON

out="$(run --json <<EOF
$(now_fmt "$now_epoch")	$cardA	LOCAL	all-stages-passed	calls=3	chars=80
$(now_fmt "$now_epoch")	$cardB	ONLINE	deterministic-multi-decision	calls=0	chars=80
$(now_fmt "$now_epoch")	$cardC	LOCAL	all-stages-passed	calls=2	chars=80
$(now_fmt "$now_epoch")	$cardD	ONLINE	route-classify-security	calls=0	chars=80
EOF
)"
assert_field "$out" dispatches 4 "C: four dispatches"
assert_field "$out" capacity_skipped 0 "C: none were capacity"
assert_field "$out" content_considered 4 "C: all four were content decisions"
assert_field "$out" drafted 3 "C: three of four actually got a draft comment"
assert_field "$out" continued_with_draft 1 "C: exactly one continued (ELFOGADVA)"
assert_field "$out" rejected_draft 1 "C: exactly one rejected (ELUTASITVA)"
assert_field "$out" pending_review 1 "C: exactly one still pending"
assert_field "$out" exhausted_no_draft 1 "C: exactly one never got a draft at all"

echo
echo "=== D. ONLY THE LATEST VERDICT PER CARD COUNTS ==="
cardE=dddd0000000000000000000000000000000005
cat > "$TMP/comments/$cardE.json" <<'JSON'
[]
JSON
out="$(run --json <<EOF
$(now_fmt "$((now_epoch-100))")	$cardE	ONLINE	vram-hold	calls=0	chars=5
$(now_fmt "$now_epoch")	$cardE	ONLINE	deterministic-money	calls=0	chars=5
EOF
)"
assert_field "$out" dispatches 1 "D: one card, one row, not two"
assert_field "$out" capacity_skipped 0 "D: the LATER (content) verdict wins over the earlier capacity one"
assert_field "$out" content_considered 1 "D: latest verdict was content"

echo
echo "=== E. ENTRIES OUTSIDE THE WINDOW ARE EXCLUDED ==="
cardF=eeee0000000000000000000000000000000006
out="$(run --hours 24 --json <<EOF
$(now_fmt "$((now_epoch-48*3600))")	$cardF	ONLINE	deterministic-money	calls=0	chars=5
EOF
)"
assert_field "$out" dispatches 0 "E: a 48h-old entry is outside a 24h window"

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
