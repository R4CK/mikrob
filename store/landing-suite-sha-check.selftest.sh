#!/usr/bin/env bash
# Self-test for landing-suite-sha-check.sh + suite-sha-check.py (card 08eb6402).
#
# Run:  bash store/landing-suite-sha-check.selftest.sh
# Exit: 0 = all pass, 1 = at least one case wrong.
#
# suite-sha-check.py's own selftest (store/suite-sha-check.selftest.py) already pins the CONTENT
# comparison in isolation. This file pins the SHELL WRAPPER's contract: the mode/return-code split
# (refuse vs report, PRESENT/MISSING/STALE/UNRESOLVED -> 0/1/1/1/2), that --allow-stale-suite in
# the real lander tolerates MISSING but never STALE, and that an unreadable board fails closed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
n=0

# --- a real scratch git repo, the same reason suite-sha-check.selftest.py builds one: content
# equivalence is a question only git can answer. ------------------------------------------------
REPO="$(mktemp -d)"
_g() { git -C "$REPO" "$@" >/dev/null 2>&1; }
_rev() { git -C "$REPO" rev-parse "$1"; }

_g init -q -b main .
_g config user.email s@s
_g config user.name s
printf 'base\n' > "$REPO/a.txt"
_g add -A
_g commit -qm base
printf 'work content\n' > "$REPO/a.txt"
_g commit -qam "the work a gate reviewed"
WORK_SHA="$(_rev HEAD)"
_g checkout -q -b same-branch "$WORK_SHA"
printf 'unrelated\n' > "$REPO/c.txt"
_g add -A
_g commit -qm "merge added something unrelated"
MERGE_SAME="$(_rev HEAD)"
_g checkout -q "$WORK_SHA"
_g checkout -q -b stale-branch
printf 'DIFFERENT\n' > "$REPO/a.txt"
_g commit -qam "merge changed the reviewed file"
MERGE_STALE="$(_rev HEAD)"
_g checkout -q main

export MARVEEN_MAIN="$REPO"
export CLEANCORE_MAIN="/nonexistent-cleancore-for-this-selftest"

# --- HTTP stub, same recipe as landing-gate-verdict-check.selftest.sh (kernel-chosen port, no
# hardcoded numbers -- two parallel vitest discoveries of this file must not collide). -----------
stub_pid=""; stub_port=""
stub_up() { # $1 = json file
  local portfile
  portfile="$(mktemp)"; rm -f "$portfile"
  python3 - "$1" "$portfile" <<'PYSTUB' &
import http.server, json, sys
BODY = json.loads(open(sys.argv[1]).read())
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps(BODY).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
with open(sys.argv[2], 'w') as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PYSTUB
  stub_pid=$!
  stub_port=""
  local i
  for i in $(seq 1 200); do
    if [ -s "$portfile" ]; then stub_port="$(cat "$portfile")"; break; fi
    sleep 0.05
  done
  rm -f "$portfile"
  [ -n "$stub_port" ] || { echo "  FAIL stub server never reported a port"; fail=1; }
}
stub_down() { [ -n "$stub_pid" ] && kill "$stub_pid" 2>/dev/null; wait "$stub_pid" 2>/dev/null; stub_pid=""; }

TOKEN_TMP="$(mktemp)"; echo tok > "$TOKEN_TMP"
FIX="$(mktemp -d)"
printf '%s' "{\"comments\":[{\"author\":\"qa\",\"content\":\"QA PASS\\nSuite-SHA: $WORK_SHA 786/786 zold\"}]}" > "$FIX/present.json"
printf '%s' '{"comments":[{"author":"qa","content":"QA PASS\nGate-SHA: abc1234"}]}' > "$FIX/missing.json"
printf '%s' '{"comments":[]}' > "$FIX/none.json"

# shellcheck source=./landing-suite-sha-check.sh
. "$HERE/landing-suite-sha-check.sh"

echo "landing-suite-sha-check selftest"

rc_case() { # $1 label, $2 expected rc, $3 json file, $4 merge sha, $5 mode (default refuse)
  n=$((n + 1))
  stub_up "$3"
  local got
  SUITE_SHA_CHECK_API="http://127.0.0.1:$stub_port" SUITE_SHA_CHECK_TOKEN_FILE="$TOKEN_TMP" \
    suite_sha_check selftest-card "$4" "${5:-refuse}" >/dev/null 2>&1
  got=$?
  stub_down
  if [ "$got" = "$2" ]; then echo "  ok   $1"; else echo "  FAIL $1 -> expected rc $2, got $got"; fail=1; fi
}

rc_case "evidence content-equivalent to the merge result -> 0 (PRESENT)" 0 \
  "$FIX/present.json" "$MERGE_SAME"
rc_case "evidence exists but the merge result moved past it -> 2 (STALE), refuse mode" 2 \
  "$FIX/present.json" "$MERGE_STALE"
rc_case "no Suite-SHA line at all -> 1 (MISSING), refuse mode" 1 \
  "$FIX/missing.json" "$MERGE_SAME"
rc_case "no comments at all -> 1 (MISSING), refuse mode" 1 \
  "$FIX/none.json" "$MERGE_SAME"
# STALE is a CONFIRMED bad state, not merely absent evidence -- same relationship FAILED has to
# gate_verdict_check's own report mode (marveen-land.sh's caller): report mode tolerates "not yet
# checked", never "checked and it is wrong". Mirrored deliberately, not an oversight.
rc_case "report mode still refuses a CONFIRMED-STALE result (mirrors FAILED's precedent)" 2 \
  "$FIX/present.json" "$MERGE_STALE" report
rc_case "report mode NEVER blocks a MISSING result either" 0 \
  "$FIX/missing.json" "$MERGE_SAME" report

n=$((n + 1))
if SUITE_SHA_CHECK_TOKEN_FILE=/nonexistent/token suite_sha_check c1 "$MERGE_SAME" refuse >/dev/null 2>&1; then
  echo "  FAIL an unreadable token in refuse mode must fail closed"; fail=1
else
  echo "  ok   an unreadable token in refuse mode fails CLOSED"
fi

n=$((n + 1))
if SUITE_SHA_CHECK_TOKEN_FILE=/nonexistent/token suite_sha_check c1 "$MERGE_SAME" report >/dev/null 2>&1; then
  echo "  ok   ...and the same in report mode does not block"
else
  echo "  FAIL report mode must never block"; fail=1
fi

# --- the two-code contract must be DISTINGUISHABLE, same reason gate_verdict_check pins it: a
# caller that treats rc=1 and rc=2 the same reopens exactly the hole the split exists to close.
n=$((n + 1))
stub_up "$FIX/present.json"
out_stale="$(SUITE_SHA_CHECK_API="http://127.0.0.1:$stub_port" SUITE_SHA_CHECK_TOKEN_FILE="$TOKEN_TMP" \
  suite_sha_check selftest-card "$MERGE_STALE" refuse 2>&1)"
rc_stale=$?
stub_down
if [ "$rc_stale" = 2 ] && printf '%s' "$out_stale" | grep -q "moved past what the full suite"; then
  echo "  ok   STALE prints a distinct, actionable message and returns its OWN code (2)"
else
  echo "  FAIL STALE message/code not as expected (rc=$rc_stale)"; fail=1
fi

rm -rf "$REPO" "$FIX" "$TOKEN_TMP"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
