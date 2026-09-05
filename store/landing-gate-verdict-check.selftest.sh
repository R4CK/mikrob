#!/usr/bin/env bash
# Self-test for landing-gate-verdict-check.sh + landing-gate-verdict-parse.py (card 9081d02d).
#
# Run:  bash store/landing-gate-verdict-check.selftest.sh
# Exit: 0 = all pass, 1 = at least one case wrong.
#
# The parser cases run on fixture JSON, so they need no dashboard and no network -- which is the
# point: this control decides whether a landing happens, and a check that can only be exercised
# against a live board is one nobody runs.
#
# The REFUSAL cases matter most. This gate sits in front of every CleanCore landing, so an
# over-eager refusal blocks real work and a lax one recreates the 08dcc153 incident it exists to
# prevent. Both directions are listed on purpose.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARSER="$HERE/landing-gate-verdict-parse.py"
fail=0
n=0

t() { # $1 = label, $2 = expected KIND, $3 = sha, stdin = comments JSON
  n=$((n + 1))
  local got kind
  got="$(python3 "$PARSER" "$3")"
  kind="${got%%|*}"
  if [ "$kind" = "$2" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1 -> expected $2, got $got"
    fail=1
  fi
}

j() { # build a comments payload from author/content pairs
  python3 -c '
import json, sys
out = []
args = sys.argv[1:]
for i in range(0, len(args), 2):
    out.append({"author": args[i], "content": args[i + 1]})
print(json.dumps({"comments": out}))' "$@"
}

echo "landing-gate-verdict-check selftest"

t "a QA PASS naming the sha satisfies the gate" OK abc1234 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234

looks good')"

t "a SHORT sha in the comment still matches a long one being landed" OK abc1234def5678 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234')"

t "...and the other way round, a long sha in the comment vs a short one landed" OK abc1234 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234def5678')"

t "several shas on one Gate-SHA line, one of them ours" OK bbb2222 \
  <<<"$(j qa 'QA PASS
Gate-SHA: aaa1111, bbb2222')"

t "a QA PASS for a DIFFERENT sha does not cover this landing" OTHERSHA zzz9999 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234')"

t "a QA FAIL naming the sha refuses, even alongside a pass" FAILED abc1234 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234' qa 'QA FAIL
Gate-SHA: abc1234
the fix was never re-gated')"

# Rule 4: QA runs on EVERY card; a security gate is risk-tiered on top of it. So a lone security
# GO means half the gate ran, not that the card was gated.
t "a lone CYBERSEC GO is reported but does NOT satisfy the check" NOQA abc1234 \
  <<<"$(j cybersec 'CYBERSEC GO
Gate-SHA: abc1234')"

t "a card with no verdict at all -- the 08dcc153 shape" NONE abc1234 \
  <<<"$(j backend 'REVIEW: done
Gate-SHA: abc1234')"

# Rule 4c: the verdict word must be the comment's FIRST line. Pinned because the fleet's own
# scanners key on it, and a comment that buries the verdict is invisible to all of them alike.
t "a verdict below the Gate-SHA line is not recognised (rule 4c)" NONE abc1234 \
  <<<"$(j qa 'Gate-SHA: abc1234
QA PASS')"

t "a QA PASS with NO Gate-SHA line names no sha, so it covers none" OTHERSHA abc1234 \
  <<<"$(j qa 'QA PASS

I checked the branch')"

t "an empty Gate-SHA line names no sha, so it covers nothing" OTHERSHA abc1234 \
  <<<"$(j qa 'QA PASS
Gate-SHA:')"

# THE MISPLACED GUARD, kept as two cases because a mutation is what found it. The original guard
# defended the wrong operand: an entry in the comment can never be empty (the sha pattern needs 7+
# characters), so deleting that guard changed nothing. The live hole was the sha being LANDED --
# with an empty one, `f.startswith("")` is true for every verdict on the card, so the check passed
# on a completely unrelated commit.
t "an EMPTY sha to check must never match a verdict" UNREADABLE "" \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234')"

t "...and a sha too short to identify a commit is refused, not prefix-matched" UNREADABLE abc \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234')"

t "prose merely mentioning a verdict mid-sentence is not a verdict" NONE abc1234 \
  <<<"$(j backend 'I will ask for a QA PASS next
Gate-SHA: abc1234')"

t "malformed JSON is UNREADABLE, not silently empty" UNREADABLE abc1234 <<<'not json at all'
t "an empty comment list is NONE" NONE abc1234 <<<'[]'
t "an unexpected response shape is UNREADABLE" UNREADABLE abc1234 <<<'{"error":"nope"}'

# --- the shell wrapper: fail-closed vs report ------------------------------------------------
# shellcheck source=./landing-gate-verdict-check.sh
. "$HERE/landing-gate-verdict-check.sh"

n=$((n + 1))
if GATE_CHECK_TOKEN_FILE=/nonexistent/token gate_verdict_check c1 abc1234 refuse >/dev/null 2>&1; then
  echo "  FAIL an unreadable token in REFUSE mode must fail closed"; fail=1
else
  echo "  ok   an unreadable token in REFUSE mode fails CLOSED"
fi

n=$((n + 1))
if GATE_CHECK_TOKEN_FILE=/nonexistent/token gate_verdict_check c1 abc1234 report >/dev/null 2>&1; then
  echo "  ok   ...and the same in REPORT mode does not block a marveen landing"
else
  echo "  FAIL report mode must never block"; fail=1
fi

# --- THE RETURN-CODE CONTRACT AND THE LANDER'S FLAG PATH (card 171c9f42) -----------------------
#
# These are BEHAVIOUR cases, deliberately, and they exist because the source-text ones did not do
# the job. Cybersec mutated `return 1` -> `return 0` in this helper and the wiring test stayed
# GREEN, because it asserted on the helper's echo strings rather than on what the lander DOES. A
# test that cannot fail when the control is removed is not evidence.
#
# The interaction below was the actual hole: --allow-ungated did not override the DECISION, it
# skipped the CALL, so the FAILED branch never ran. Three separate places -- this helper's message,
# cleancore-land.sh's comment and the card's QA verdict -- claimed a failing verdict could never be
# waved through, and none of them was true.
stub_pid=""
stub_port=""
# THE PORT IS CHOSEN BY THE KERNEL, not written here. It used to be five hardcoded numbers
# (8801-8805), and this script runs in TWO vitest files -- its own wrapper and the store selftest
# discovery -- which vitest executes in PARALLEL. Two overlapping runs then bound the same port and
# the second died with "OSError: [Errno 98] Address already in use", failing a landing whose diff
# had nothing to do with it. Nothing about the test needs a known number: the caller is handed the
# port the kernel gave out. Waiting for the port FILE also replaces a fixed `sleep 0.6` with actual
# readiness -- HTTPServer() has already bound and listened by the time it writes.
stub_up() { # $1 = json file; sets $stub_port
  local portfile="$SELFTEST_TMP/stub.port"
  rm -f "$portfile"
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
  if [ -z "$stub_port" ]; then
    echo "  FAIL stub server never reported a port"; fail=1
  fi
}
stub_down() { [ -n "$stub_pid" ] && kill "$stub_pid" 2>/dev/null; wait "$stub_pid" 2>/dev/null; stub_pid=""; }

rc_case() { # $1 label, $2 expected rc, $3 json file
  n=$((n + 1))
  stub_up "$3"
  local got
  GATE_CHECK_API="http://127.0.0.1:$stub_port" GATE_CHECK_TOKEN_FILE="$TOKEN_TMP" \
    gate_verdict_check selftest-card abc1234 refuse >/dev/null 2>&1
  got=$?
  stub_down
  if [ "$got" = "$2" ]; then echo "  ok   $1"; else echo "  FAIL $1 -> expected rc $2, got $got"; fail=1; fi
}

SELFTEST_TMP="$(mktemp -d)"
TOKEN_TMP="$SELFTEST_TMP/token"; echo tok > "$TOKEN_TMP"
printf '%s' '{"comments":[{"author":"qa","content":"QA PASS\nGate-SHA: abc1234"}]}' > "$SELFTEST_TMP/ok.json"
printf '%s' '{"comments":[]}' > "$SELFTEST_TMP/none.json"
printf '%s' '{"comments":[{"author":"qa","content":"QA FAIL\nGate-SHA: abc1234\n\nbroken"}]}' > "$SELFTEST_TMP/failed.json"

source "$HERE/landing-gate-verdict-check.sh"
rc_case "a passing verdict returns 0" 0 "$SELFTEST_TMP/ok.json"
rc_case "NO usable verdict returns 1 -- overridable by an explicit flag" 1 "$SELFTEST_TMP/none.json"
rc_case "a FAILING verdict returns 2 -- its OWN code, so a caller can refuse only this one" 2 "$SELFTEST_TMP/failed.json"

# ...and now through the REAL lander, on its real flag path.
# args: label, json fixture, and 1 = must refuse at the gate / 0 = must get past it
land_case() {
  n=$((n + 1))
  stub_up "$2"
  local out rc
  out="$(GATE_CHECK_API="http://127.0.0.1:$stub_port" GATE_CHECK_TOKEN_FILE="$TOKEN_TMP" \
        timeout 40 bash "$HERE/cleancore-land.sh" selftest-card abc1234 --dry-run --allow-ungated 2>&1)"
  rc=$?
  stub_down
  local ok=0
  if [ "$3" = 1 ]; then
    # Must stop AT the gate: exit 3 and say why.
    [ "$rc" = 3 ] && printf '%s' "$out" | grep -q 'FAILING verdict is never overridden' && ok=1
  else
    # Must get PAST the gate. It then fails on a later precondition (the sha is not a real commit),
    # and that is the proof it went further -- the gate is not what stopped it.
    printf '%s' "$out" | grep -q 'TOLERATED by --allow-ungated' && ok=1
  fi
  if [ "$ok" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1 -> rc=$rc, output did not show the expected outcome"; fail=1; fi
}
land_case "--allow-ungated does NOT wave through a FAILING verdict (the hole this card closed)" \
  "$SELFTEST_TMP/failed.json" 1
land_case "--allow-ungated DOES tolerate a merely-missing verdict, and says so out loud" \
  "$SELFTEST_TMP/none.json" 0

rm -rf "$SELFTEST_TMP"

echo "

selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
