#!/usr/bin/env bash
# fleet-nudger-selftest.sh -- controls for fleet-nudger.sh's GATE predicate (card 14acfadd).
#
# WHY THIS EXISTS. The nudger decides who gets woken, and its old gate predicate was
# `any waiting card exists` -- permanently true on this board (70 waiting cards, 49 of them
# BLOKKOLT-*), so all four gate agents were woken every run whether or not any of them had a card
# to answer. Cybered checked its 17 apparent hits and every one was a false positive.
#
# The only way to test a nudger is to observe who it pokes, and against the live board the answer
# depends on the live board. So this stands up a FAKE dashboard with a known set of cards and
# comments, points the real script at it via DASH, and asserts the decision.
#
# It asserts the PREDICATE (the --dry-run GATE-WORK line), not delivery. Delivery additionally drops
# agents with no tmux session or a busy pane -- real behaviour, but live state that would make these
# controls flap depending on who happens to be working.
#
# Usage: store/fleet-nudger-selftest.sh          (exit 0 = PASS, 1 = FAIL)
# No secrets, no writes outside a temp dir, and it never touches the live dashboard.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NUDGER="$HERE/fleet-nudger.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

cat > "$TMP/fakeboard.py" <<'PYEOF'
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

SCENARIO, PORT = sys.argv[1], int(sys.argv[2])

# Every waiting card is already answered by every gate -> nobody has work.
ALL_ANSWERED = {
    'cards': [
        {'id': 'c1', 'status': 'waiting', 'title': 'plain card', 'assignee': 'backend'},
        {'id': 'c2', 'status': 'waiting', 'title': 'BLOKKOLT: waiting on another card', 'assignee': 'backend'},
    ],
    'comments': {
        'c1': [
            {'author': 'backend', 'created_at': 100, 'content': 'REVIEW -- kesz'},
            {'author': 'qa', 'created_at': 200, 'content': 'QA PASS'},
            {'author': 'qa2', 'created_at': 201, 'content': 'QA2 PASS'},
            {'author': 'cybersec', 'created_at': 202, 'content': 'GO'},
            {'author': 'cybered', 'created_at': 203, 'content': 'GO'},
        ],
        # c2 is BLOKKOLT: dropped before any comment is fetched. If the title filter regressed, this
        # card looks like unanswered work for all four gates and the all-answered case goes red.
        'c2': [{'author': 'backend', 'created_at': 100, 'content': 'REVIEW -- kesz'}],
    },
}

# A REVIEW cybered has not answered -> exactly cybered has work.
ONE_OPEN = {
    'cards': [{'id': 'c1', 'status': 'waiting', 'title': 'plain card', 'assignee': 'backend'}],
    'comments': {
        'c1': [
            {'author': 'backend', 'created_at': 100, 'content': 'REVIEW -- kesz'},
            {'author': 'qa', 'created_at': 200, 'content': 'QA PASS'},
            {'author': 'qa2', 'created_at': 201, 'content': 'QA2 PASS'},
            {'author': 'cybersec', 'created_at': 202, 'content': 'GO'},
        ],
    },
}

# A waiting card with no submission is not gate work for anyone.
NO_REVIEW = {
    'cards': [{'id': 'c1', 'status': 'waiting', 'title': 'plain card', 'assignee': 'backend'}],
    'comments': {'c1': [{'author': 'mikrob', 'created_at': 100, 'content': 'kotott blokk, var'}]},
}

# DESIGNATION end-to-end (card 5bc10089): the card names only QA in its own text, and NOBODY has
# verdicted yet. Without designation this would be GATE-WORK for all four; with it, only qa/qa2
# (QA's twin) should show up -- cybersec and cybered are excluded despite having no verdict, because
# they were never asked. Proves the board -> per-card labels/description -> decide wiring actually
# carries the fields, not just that gate-dispatch-check.sh's own unit-level selftest handles them.
DESIGNATED = {
    'cards': [{
        'id': 'c1', 'status': 'waiting', 'title': 'plain card', 'assignee': 'backend',
        'description': 'Some feature.\n\nGate: QA.\n',
    }],
    'comments': {'c1': [{'author': 'backend', 'created_at': 100, 'content': 'REVIEW -- kesz'}]},
}

# ENG-CONDITIONAL end-to-end: one non-blocked planned card, assigned to backend. fullstack has
# none. Both must be idle/no-session in this fixture (no tmux to check against), so ENG-WORK is
# the only signal being asserted -- delivery itself is covered by the gate cases above.
ENG_ONE_PLANNED = {
    'cards': [
        {'id': 'p1', 'status': 'planned', 'title': 'a real card', 'assignee': 'backend'},
        {'id': 'p2', 'status': 'planned', 'title': 'BLOKKOLT: parked', 'assignee': 'fullstack'},
    ],
    'comments': {},
}

FIX = {
    'all-answered': ALL_ANSWERED, 'one-open': ONE_OPEN, 'no-review': NO_REVIEW,
    'designated': DESIGNATED, 'eng-one-planned': ENG_ONE_PLANNED,
}[SCENARIO]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/kanban':
            self._send(FIX['cards'])
        elif self.path.startswith('/api/kanban/') and self.path.endswith('/comments'):
            self._send(FIX['comments'].get(self.path.split('/')[3], []))
        else:
            self._send([])

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length') or 0))
        self._send({'ok': True})


HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PYEOF

run_case() { # $1 = scenario, $2 = port, $3 = expected gate agents, $4 = field (default GATE-WORK)
  local scen="$1" port="$2" want="$3" field="${4:-GATE-WORK}" pid got
  python3 "$TMP/fakeboard.py" "$scen" "$port" &
  pid=$!
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:$port/api/kanban" && break
    sleep 0.25
  done
  # An unreachable board makes the nudger exit early and print nothing, which would look exactly
  # like "nobody was woken" and pass two of the three cases for the wrong reason.
  if ! curl -sf -o /dev/null "http://127.0.0.1:$port/api/kanban"; then
    echo "  FAIL $scen -- fake board never came up (the control would be vacuous)"
    kill "$pid" 2>/dev/null; fail=1; return
  fi

  got="$(DASH="http://127.0.0.1:$port" bash "$NUDGER" --dry-run 2>/dev/null | sed -n "s/^${field}://p")"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  [ "$(echo $got)" = "none" ] && got=""
  got="$(echo $got | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ *$//')"

  if [ "$got" = "$want" ]; then echo "  ok   $scen ($field) -> '${got:-<none>}'"
  else echo "  FAIL $scen ($field) -> got '$got', expected '$want'"; fail=1; fi
}

echo "fleet-nudger gate-predicate controls"
run_case one-open     38811 "cybered"   # positive: exactly the one agent that owes a verdict
run_case all-answered 38812 ""          # negative: the case the card is about
run_case no-review    38813 ""          # negative: parked card, nothing submitted
run_case designated   38814 "qa qa2"    # designation: Gate: QA. excludes cybersec/cybered end-to-end

# ENG-CONDITIONAL (MikroB decision, msg 9910, follow-up to card 14acfadd): backend/fullstack must
# respect plan[a] the same way the gate loop respects designation -- "there is always a
# sec-followup" was the same unconditional assumption the OLD gate predicate made. fron-ted/
# fron-teddy stay unconditional on purpose (design-impl always has a next screen), so they are NOT
# asserted here -- ENG-WORK only ever reports on the conditional pair.
run_case eng-one-planned 38815 "backend"       "ENG-WORK"  # positive: only backend has a planned card
run_case no-review       38816 ""              "ENG-WORK"  # negative: no planned card for either

[ $fail -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
