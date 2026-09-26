#!/usr/bin/env bash
# Self-test for the push-time gate-verdict RECHECK wired into mopsion-land.sh (card 517cbcbe,
# backend3's plan-grilling finding on acc197c8). Runs the REAL mopsion-land.sh end to end against a
# minimal scratch repo (--skip-typecheck/--skip-bundle and evidence-mode=off keep the fixture to
# what this specific gate needs -- the same proportionate-fixture choice
# mopsion-suite-evidence-gate.selftest.sh and landing-gate-verdict-check.selftest.sh's own land_case
# already made for the two gates one door over).
#
# THE ONE THING NEITHER SIBLING SELFTEST COULD PROVE. landing-gate-verdict-check.selftest.sh drives
# the real lander with --dry-run, but its fixture sha ('abc1234') is not a real commit, so the
# script refuses on an EARLIER precondition every time -- it never reaches this card's code.
# mopsion-suite-evidence-gate.selftest.sh reaches past that point with a real git fixture, but its
# GATE_CHECK_TOKEN_FILE is a fixed /nonexistent/token for every call, so its FIRST and SECOND
# gate_verdict_check calls always return the SAME rc (1, tolerated by --allow-ungated) -- nothing
# in that fixture can ever make the two checks disagree. This file borrows the git-fixture half from
# the former and the stub-HTTP-server half from the latter, and adds the one ingredient neither had:
# a stub that answers DIFFERENTLY on the second request, so the two live gate_verdict_check calls
# inside one real mopsion-land.sh run can actually be made to disagree.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND="$HERE/mopsion-land.sh"
fail=0
n=0

WORK="$(mktemp -d)"
MAIN="$WORK/main"
git init -q -b main "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/notes.txt"
git -C "$MAIN" add "$MAIN/notes.txt"
git -C "$MAIN" commit -qm base

ORIGIN="$WORK/origin.git"
git init -q --bare -b main "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin main

git -C "$MAIN" checkout -q -b work-branch
echo "work change" >> "$MAIN/notes.txt"
git -C "$MAIN" add "$MAIN/notes.txt"
git -C "$MAIN" commit -qm "the gated work"
SHA="$(git -C "$MAIN" rev-parse work-branch)"
git -C "$MAIN" checkout -q main

MODE_FILE="$WORK/mode.json"
echo '{"mode":"off"}' > "$MODE_FILE"   # the suite-evidence gate is a different card's concern
TOKEN_TMP="$WORK/token"; echo tok > "$TOKEN_TMP"

# A stub dashboard whose /api/kanban/<card>/comments answer CHANGES after the Nth request -- the
# one thing this file exists to add. $1 = card json before the flip, $2 = card json from the flip
# onward, $3 = 1-based request number at which it flips (a flip at 2 means: 1st request sees $1,
# 2nd request onward sees $2).
stub_pid=""
stub_port=""
stub_up() {
  local portfile="$WORK/stub.port"
  rm -f "$portfile"
  python3 - "$1" "$2" "$3" "$portfile" <<'PYSTUB' &
import http.server, json, sys
BEFORE = json.loads(open(sys.argv[1]).read())
AFTER = json.loads(open(sys.argv[2]).read())
FLIP_AT = int(sys.argv[3])
count = {"n": 0}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        count["n"] += 1
        body = BEFORE if count["n"] < FLIP_AT else AFTER
        b = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
with open(sys.argv[4], 'w') as f:
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
  if [ -z "$stub_port" ]; then echo "  FAIL stub server never reported a port"; fail=1; fi
}
stub_down() { [ -n "$stub_pid" ] && kill "$stub_pid" 2>/dev/null; wait "$stub_pid" 2>/dev/null; stub_pid=""; }

PASS_JSON="$WORK/pass.json"
FAIL_JSON="$WORK/fail.json"
printf '%s' "{\"comments\":[{\"author\":\"qa\",\"content\":\"QA PASS\\nGate-SHA: $SHA\"}]}" > "$PASS_JSON"
printf '%s' "{\"comments\":[{\"author\":\"qa\",\"content\":\"QA FAIL\\nGate-SHA: $SHA\\n\\nbroken\"}]}" > "$FAIL_JSON"

OUT_FILE="$WORK/out.txt"
land() { # $1 = card, $2 = before json, $3 = after json, $4 = flip-at request number. Sets $rc; output in $OUT_FILE.
  stub_up "$2" "$3" "$4"
  GATE_CHECK_API="http://127.0.0.1:$stub_port" GATE_CHECK_TOKEN_FILE="$TOKEN_TMP" \
    CLEANCORE_MAIN="$MAIN" MOPSION_SUITE_EVIDENCE_MODE_FILE="$MODE_FILE" \
    timeout 40 bash "$LAND" "$1" "$SHA" --dry-run --skip-typecheck --skip-bundle >"$OUT_FILE" 2>&1
  rc=$?
  stub_down
}

echo "mopsion-land.sh push-time verdict recheck selftest (card 517cbcbe)"

n=$((n + 1))
land card-stable "$PASS_JSON" "$PASS_JSON" 999
if [ "$rc" = 0 ] && grep -q "DRY-RUN: not pushing" "$OUT_FILE"; then
  echo "  ok   a stable PASS across both checks proceeds to the (dry-run) push"
else
  echo "  FAIL stable PASS should proceed -> rc=$rc:"; tail -5 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

n=$((n + 1))
land card-flip-to-fail "$PASS_JSON" "$FAIL_JSON" 2
if [ "$rc" = 3 ] && grep -q "changed between the start of this landing" "$OUT_FILE"; then
  echo "  ok   a PASS that flips to FAIL between the two checks REFUSES at the second one"
else
  echo "  FAIL a PASS->FAIL flip should refuse (rc 3, named) -> rc=$rc:"; tail -5 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

n=$((n + 1))
if grep -q "was rc=0, now rc=2" "$OUT_FILE"; then
  echo "  ok   the refusal names the OLD and NEW rc, not just that something changed"
else
  echo "  FAIL the refusal message did not name both rc values:"; tail -5 "$OUT_FILE" | sed 's/^/       /'
  fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
