#!/usr/bin/env bash
# fleet-nudger.selftest.sh -- controls for fleet-nudger.sh's GATE predicate (card 14acfadd).
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
# Usage: store/fleet-nudger.selftest.sh          (exit 0 = PASS, 1 = FAIL)
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

SCENARIO, PORT_FILE = sys.argv[1], sys.argv[2]

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

# MISSING TIER DECISION (card 50d75b47): a gate candidate carrying a LABEL but no Gate: line has
# had its designation decided -- by the stronger of the two sources -- so it must NOT be reported as
# undesignated. This is the fixture that keeps the check keyed on "was a decision made", not on
# "is there a Gate: line".
LABELED = {
    'cards': [{
        'id': 'c1', 'status': 'waiting', 'title': 'plain card', 'assignee': 'backend',
        'labels': [{'name': '@qa'}],
    }],
    'comments': {'c1': [{'author': 'backend', 'created_at': 100, 'content': 'REVIEW -- kesz'}]},
}

# OUT-OF-SCOPE ANSWER IS AN ANSWER (card 8e4e5b58). Cybered measured the same card being handed
# to the same gate 5-7 times in a row after that gate had already said "not mine". The property
# that makes this self-correcting is subtle and was untested: gate-dispatch-check.sh counts ANY
# comment by the agent as its own word, not only a formal verdict -- so a one-line skip note ends
# the loop by itself. Here cybered has answered (out of scope) while cybersec has not, so exactly
# cybersec must be woken. If someone ever narrows `mine` to verdict-shaped comments, the 5-7x
# repetition comes straight back, and this case is what says so.
OUT_OF_SCOPE = {
    'cards': [{'id': 'c1', 'status': 'waiting', 'title': 'plain card', 'assignee': 'backend',
               'description': 'Gate: Cybersec + Cybered'}],
    'comments': {'c1': [
        {'author': 'backend', 'created_at': 100, 'content': 'REVIEW -- kesz'},
        {'author': 'cybered', 'created_at': 200,
         'content': 'CYBERED SKIP: nem az en hataskorom, a kartya nem jelol meg engem.'},
    ]},
}

# DESIGNATION end-to-end (card 5bc10089): the card names only QA in its own text, and NOBODY has
# verdicted yet. Without designation this would be GATE-WORK for all four; with it, only qa/qa2
# (QA's twin) should show up -- cybersec and cybered are excluded despite having no verdict, because
# they were never asked. Proves the board -> per-card labels/description -> decide wiring actually
# carries the fields, not just that gate-dispatch-check.sh's own unit-level selftest handles them.
# Gate: written mid-paragraph, preceded by a space not a newline (real card 165ff1af shape,
# 2026-08-13) -- must still exclude cybersec/cybered. A line-start-anchored regex misses this
# entirely (empty gate_line -> no exclusion -> cybersec gets nudged on a QA-only card, the real
# incident: 6+ repeat nudges on 165ff1af before this fixture caught it).
DESIGNATED = {
    'cards': [{
        'id': 'c1', 'status': 'waiting', 'title': 'plain card', 'assignee': 'backend',
        'description': 'Some feature. Gate: QA. (funkcionalis lefedettseg, nincs trust-boundary erintes)',
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

# Same SHAPE as ENG_ONE_PLANNED -- backend still has exactly one non-blocked planned card, so plan[a]
# is identical -- but the card moved (different id and updated_at). That is the distinction the
# per-agent precheck has to make: "backend has work" is unchanged, yet the WORK ITSELF is new, so the
# nudge must go out again. A precheck keyed on the boolean instead of the set would suppress this and
# starve a genuinely new card.
ENG_PLANNED_MOVED = {
    'cards': [
        {'id': 'p9', 'status': 'planned', 'title': 'a different real card', 'assignee': 'backend',
         'updated_at': 999},
        {'id': 'p2', 'status': 'planned', 'title': 'BLOKKOLT: parked', 'assignee': 'fullstack'},
    ],
    'comments': {},
}

# ENG-ALWAYS precheck (msg 18241, 2026-08-20): fron-ted has exactly one card of its own, sitting in
# waiting+REVIEW with no gate verdict yet -- the real shape of the incident (3 finished cards, all
# still waiting on QA, 6 identical resends in a row). assignee is the only thing the _always_fp
# fingerprint reads, so status does not matter for this fixture; what matters is that the card's
# (id, updated_at) pair is stable across repeats of this SAME fixture and different when it moves.
ENG_ALWAYS_ONE_CARD = {
    'cards': [{'id': 'a1', 'status': 'waiting', 'title': 'fron-ted own card', 'assignee': 'fron-ted',
               'updated_at': 500}],
    'comments': {'a1': [{'author': 'fron-ted', 'created_at': 100, 'content': 'REVIEW -- kesz'}]},
}

# Same shape, but the card moved (a QA verdict landed, bumping updated_at) -- the fingerprint must
# treat this as new work, not as the unchanged set the precheck exists to suppress.
ENG_ALWAYS_CARD_VERDICT = {
    'cards': [{'id': 'a1', 'status': 'waiting', 'title': 'fron-ted own card', 'assignee': 'fron-ted',
               'updated_at': 600}],
    'comments': {'a1': [
        {'author': 'fron-ted', 'created_at': 100, 'content': 'REVIEW -- kesz'},
        {'author': 'qa', 'created_at': 200, 'content': 'QA FAIL'},
    ]},
}

FIX = {
    'all-answered': ALL_ANSWERED, 'one-open': ONE_OPEN, 'no-review': NO_REVIEW,
    'designated': DESIGNATED, 'labeled': LABELED, 'out-of-scope': OUT_OF_SCOPE,
    'eng-one-planned': ENG_ONE_PLANNED,
    'eng-planned-moved': ENG_PLANNED_MOVED,
    'eng-always-one-card': ENG_ALWAYS_ONE_CARD,
    'eng-always-card-verdict': ENG_ALWAYS_CARD_VERDICT,
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


# PORT 0: the kernel hands out a free one (card f3757cc7). This file used to take a HARDCODED port
# from the caller (38811-38826), which made every case a fleet-wide singleton: two concurrent
# marveen-land.sh runs both execute this selftest, both tried to bind the same number, and the loser
# died with OSError [Errno 98] Address already in use -- a landing refused over a port, not a diff.
# The real port is written back for the caller; the bind has already succeeded by the time it is
# readable, so a caller that sees a number knows the socket is up.
srv = HTTPServer(('127.0.0.1', 0), H)
with open(PORT_FILE, 'w') as _f:
    _f.write(str(srv.server_port))
srv.serve_forever()
PYEOF

# ONE way to stand up a fake board (card f3757cc7).
#
# Every caller below used to inline the same three steps with its OWN hardcoded port number. That
# duplication is not a style complaint: when the port became kernel-assigned, the change had to be
# made in SEVEN places, and missing one did not fail loudly -- it left a board listening on an
# ephemeral port while the caller curled the old fixed number, so the nudger saw an unreachable
# board, printed nothing, and the case failed as "expected 'x', got ''". One starter means the next
# change to how a board comes up happens once.
#
# Sets BOARD_PORT and BOARD_PID. Returns non-zero if the board never reported a port or never
# answered -- callers must check, because an unreachable board makes the nudger print nothing, which
# reads exactly like a legitimate "nobody was woken".
board_n=0
start_board() { # $1 = scenario -> BOARD_PORT, BOARD_PID
  local portfile
  board_n=$((board_n + 1))
  portfile="$TMP/port-$board_n"
  python3 "$TMP/fakeboard.py" "$1" "$portfile" &
  BOARD_PID=$!
  BOARD_PORT=""
  for _ in $(seq 1 40); do
    [ -s "$portfile" ] && BOARD_PORT="$(cat "$portfile")" && break
    sleep 0.25
  done
  [ -n "$BOARD_PORT" ] || return 1
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:$BOARD_PORT/api/kanban" && return 0
    sleep 0.25
  done
  return 1
}

# Per-call counter. The state file used to be keyed on the PORT, which stopped being available when
# the port became ephemeral (card f3757cc7) -- and the port was never the point: the invariant the
# comment below describes is "isolated per CALL", which a counter states directly. It also survives
# the same scenario being run twice for different fields (all-answered appears under both GATE-WORK
# and GATE-TIER-MISSING), which is exactly the collision that comment warns about.
case_n=0

run_case() { # $1 = scenario, $2 = expected gate agents, $3 = field (default GATE-WORK)
  local scen="$1" want="$2" field="${3:-GATE-WORK}" pid got port
  case_n=$((case_n + 1))
  # An unreachable board makes the nudger exit early and print nothing, which would look exactly
  # like "nobody was woken" and pass two of the three cases for the wrong reason.
  if ! start_board "$scen"; then
    echo "  FAIL $scen -- fake board never came up (the control would be vacuous)"
    kill "$BOARD_PID" 2>/dev/null; fail=1; return
  fi
  port="$BOARD_PORT"; pid="$BOARD_PID"

  # Isolated per call (card bb1751f2's no-change precheck persists a fingerprint across runs) --
  # without this EVERY case here would default to the LIVE store/.fleet-nudger-state.json, both
  # corrupting the real cron job's persisted state AND letting one case's fingerprint silently
  # suppress the next case's decision (measured: identical placeholder card ids + absent
  # updated_at across these fixtures made every case after the first look like a no-op).
  got="$(DASH="http://127.0.0.1:$port" NUDGER_STATE_FILE="$TMP/state-$scen-$case_n.json" bash "$NUDGER" --dry-run 2>/dev/null | sed -n "s/^${field}://p")"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  [ "$(echo $got)" = "none" ] && got=""
  got="$(echo $got | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ *$//')"

  if [ "$got" = "$want" ]; then echo "  ok   $scen ($field) -> '${got:-<none>}'"
  else echo "  FAIL $scen ($field) -> got '$got', expected '$want'"; fail=1; fi
}

echo "fleet-nudger gate-predicate controls"
run_case one-open "cybered"   # positive: exactly the one agent that owes a verdict
run_case all-answered ""          # negative: the case the card is about
run_case no-review ""          # negative: parked card, nothing submitted
run_case designated "qa qa2"    # designation: Gate: QA. excludes cybersec/cybered end-to-end
# The gate that already answered (even with a one-line out-of-scope note) drops out; the one that
# has not still gets woken. Card 8e4e5b58.
run_case out-of-scope "cybersec"

# MISSING TIER DECISION -> LOUD (card 50d75b47). Rule 4 makes the gate set a per-card DECISION; a
# card with neither a label nor a Gate: line never had one made, and the pipeline used to be unable
# to tell that apart from a deliberate default. These assert the new GATE-TIER-MISSING line.
# all-answered is the load-bearing fixture: c1 carries no designation (reported) while c2 is
# BLOKKOLT (a bound block is not gate work, so it must NOT appear) -- one case, both directions.
run_case all-answered "c1" "GATE-TIER-MISSING"
run_case designated ""   "GATE-TIER-MISSING"   # a Gate: line IS a decision
run_case labeled ""   "GATE-TIER-MISSING"   # so is a gate label, with no line at all
run_case no-review "c1" "GATE-TIER-MISSING"   # due at card open, not when a REVIEW lands

# ENG-CONDITIONAL (MikroB decision, msg 9910, follow-up to card 14acfadd): backend/fullstack must
# respect plan[a] the same way the gate loop respects designation -- "there is always a
# sec-followup" was the same unconditional assumption the OLD gate predicate made. fron-ted/
# fron-teddy ASSUME work by default (design-impl always has a next screen), but that assumption gets
# its own precheck below (ENG-ALWAYS-WORK) rather than being asserted here -- this pair of runs is
# ENG-WORK only, which only ever reports on the conditional pair.
run_case eng-one-planned "backend"       "ENG-WORK"  # positive: only backend has a planned card
run_case no-review ""              "ENG-WORK"  # negative: no planned card for either

# ENG-ALWAYS precheck (msg 18241, 2026-08-20): fron-ted/fron-teddy's "always assume work" default
# stopped meaning "never suppress" the moment their own backlog can genuinely run dry -- the real
# incident was 6 identical resends to fron-ted while its 3 finished cards sat unchanged in
# waiting+REVIEW. Three runs, one state file: fresh send, suppressed identical resend, and a real
# verdict landing on the SAME card id (only updated_at moves) that must NOT be suppressed.
ENG_ALWAYS_STATE_FILE="$TMP/eng-always-state.json"
always_run() { # $1 = scenario -> sets ALWAYS_WORK / ALWAYS_UNCH
  local pid port out
  start_board "$1" || { echo "  FAIL $1 -- fake board never came up"; fail=1; return; }
  pid="$BOARD_PID"; port="$BOARD_PORT"
  out="$(DASH="http://127.0.0.1:$port" NUDGER_STATE_FILE="$ENG_ALWAYS_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null)"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  ALWAYS_WORK="$(echo "$out" | sed -n 's/^ENG-ALWAYS-WORK://p' | xargs)"
  ALWAYS_UNCH="$(echo "$out" | sed -n 's/^ENG-ALWAYS-UNCHANGED://p' | xargs)"
}

# fron-teddy owns zero cards in every fixture here, so it is its OWN independent case: a constant,
# non-empty fingerprint (hash of an empty set) that is new to a fresh state file on run 1 (nudged,
# same as everyone's first-sight behaviour elsewhere in this file), then unchanged on every run after
# since its own card set never moves. Asserted together with fron-ted, not filtered out, because that
# independence -- one agent's fingerprint never flips because of another agent's card -- is exactly
# what per-agent (not shared) state is for.
always_run eng-always-one-card
if [ "$ALWAYS_WORK" = "fron-ted fron-teddy" ] && [ "$ALWAYS_UNCH" = "none" ]; then
  echo "  ok   eng-always precheck run 1 (fresh state) -> nudged 'fron-ted fron-teddy', nothing suppressed"
else echo "  FAIL eng-always precheck run 1 -> work='$ALWAYS_WORK' unchanged='$ALWAYS_UNCH', expected 'fron-ted fron-teddy' / 'none'"; fail=1; fi

always_run eng-always-one-card
if [ "$ALWAYS_WORK" = "none" ] && [ "$ALWAYS_UNCH" = "fron-ted fron-teddy" ]; then
  echo "  ok   eng-always precheck run 2 (identical board) -> suppressed, nudge NOT resent"
else echo "  FAIL eng-always precheck run 2 -> work='$ALWAYS_WORK' unchanged='$ALWAYS_UNCH', expected 'none' / 'fron-ted fron-teddy'"; fail=1; fi

# Load-bearing negative control: fron-teds card id moved (a verdict landed) -- fron-ted must resend
# while fron-teddy (untouched, zero cards throughout) stays suppressed. Proves the fingerprint is
# genuinely per-agent, not one shared hash that a change to ANY always-agent's cards would re-arm for
# all of them (which is exactly the bug class bb1751f2 fixed for the gate branch).
always_run eng-always-card-verdict
if [ "$ALWAYS_WORK" = "fron-ted" ] && [ "$ALWAYS_UNCH" = "fron-teddy" ]; then
  echo "  ok   eng-always precheck run 3 (verdict landed, same card id) -> fron-ted resent, fron-teddy still suppressed"
else echo "  FAIL eng-always precheck run 3 -> work='$ALWAYS_WORK' unchanged='$ALWAYS_UNCH', expected 'fron-ted' / 'fron-teddy'"; fail=1; fi

# PROJECT DISPATCH PRIORITY (card 2d6587fe): PROJECT_PRIORITY_CONFIG override, same isolation
# pattern as the rest of this file -- a throwaway file, never the live setting.
PRIO_FILE="$TMP/priority.json"
echo '{"priority":["marveen-infra","cleancore"]}' > "$PRIO_FILE"
start_board no-review || { echo "  FAIL no-review -- fake board never came up"; fail=1; }
PRIO_PID="$BOARD_PID"; PRIO_PORT="$BOARD_PORT"
prio_out="$(DASH="http://127.0.0.1:$PRIO_PORT" PROJECT_PRIORITY_CONFIG="$PRIO_FILE" NUDGER_STATE_FILE="$TMP/state-prio.json" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^PRIORITY-PROJECTS://p')"
kill "$PRIO_PID" 2>/dev/null; wait "$PRIO_PID" 2>/dev/null
if [ "$prio_out" = "marveen-infra, cleancore" ]; then echo "  ok   priority config read, order preserved -> '$prio_out'"
else echo "  FAIL priority config -> got '$prio_out'"; fail=1; fi

# Missing/empty config -> "none", unchanged wording (already exercised implicitly by every case
# above, none of which set PROJECT_PRIORITY_CONFIG -- this makes the "none" default explicit).
start_board no-review || { echo "  FAIL no-review -- fake board never came up"; fail=1; }
NOPRIO_PID="$BOARD_PID"; NOPRIO_PORT="$BOARD_PORT"
noprio_out="$(DASH="http://127.0.0.1:$NOPRIO_PORT" PROJECT_PRIORITY_CONFIG="$TMP/does-not-exist.json" NUDGER_STATE_FILE="$TMP/state-noprio.json" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^PRIORITY-PROJECTS://p')"
kill "$NOPRIO_PID" 2>/dev/null; wait "$NOPRIO_PID" 2>/dev/null
if [ "$noprio_out" = "none" ]; then echo "  ok   missing config -> none (default order, unchanged wording)"
else echo "  FAIL missing config -> got '$noprio_out'"; fail=1; fi

# TIER-SIGNAL SUPPRESSION (card 50d75b47): the same undesignated SET, seen twice, must be reported
# once. Without this the signal would re-fire every minute on a standing backlog -- which is how a
# loud signal trains its reader to ignore it, and the whole point is that MikroB acts on it.
# Its own fingerprint, deliberately not the gate one, so the two are asserted independently here.
TIER_STATE_FILE="$TMP/tier-state.json"
start_board all-answered || { echo "  FAIL all-answered -- fake board never came up"; fail=1; }
TIER_PID="$BOARD_PID"; TIER_PORT="$BOARD_PORT"
tier1="$(DASH="http://127.0.0.1:$TIER_PORT" NUDGER_STATE_FILE="$TIER_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-TIER-MISSING://p')"
tier2_missing="$(DASH="http://127.0.0.1:$TIER_PORT" NUDGER_STATE_FILE="$TIER_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-TIER-MISSING://p')"
tier2_suppressed="$(DASH="http://127.0.0.1:$TIER_PORT" NUDGER_STATE_FILE="$TIER_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-TIER-SUPPRESSED://p')"
kill "$TIER_PID" 2>/dev/null; wait "$TIER_PID" 2>/dev/null
if [ "$(echo $tier1)" = "c1" ]; then echo "  ok   tier signal run 1 (fresh state) -> 'c1', reported"
else echo "  FAIL tier signal run 1 -> got '$tier1', expected 'c1'"; fail=1; fi
if [ "$(echo $tier2_missing)" = "none" ] && [ "$(echo $tier2_suppressed)" = "c1" ]; then
  echo "  ok   tier signal run 2 (identical set) -> suppressed, not re-reported"
else echo "  FAIL tier signal run 2 -> missing='$tier2_missing' suppressed='$tier2_suppressed', expected 'none' and 'c1'"; fail=1; fi

# NO-CHANGE PRECHECK (card bb1751f2, Cybersec msg 10933): the same GATE-WORK conclusion, reached
# twice in a row against a byte-identical board, must send the FULL nudge only the first time -- the
# second run is a short no-op. A genuinely CHANGED board (here: switching fixtures, same effect as a
# new comment bumping updated_at) must resend normally, proving the precheck is not a one-way switch
# that silences the nudger forever.
NUDGE_STATE_FILE="$TMP/nudge-state.json"
start_board one-open || { echo "  FAIL one-open -- fake board never came up"; fail=1; }
PRECHECK_PID="$BOARD_PID"; PRECHECK_PORT="$BOARD_PORT"
run1="$(DASH="http://127.0.0.1:$PRECHECK_PORT" NUDGER_STATE_FILE="$NUDGE_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-WORK://p')"
run2="$(DASH="http://127.0.0.1:$PRECHECK_PORT" NUDGER_STATE_FILE="$NUDGE_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-WORK://p')"
kill "$PRECHECK_PID" 2>/dev/null; wait "$PRECHECK_PID" 2>/dev/null
if [ "$(echo $run1)" = "cybered" ]; then echo "  ok   no-change precheck run 1 (fresh state) -> 'cybered', full decision made"
else echo "  FAIL no-change precheck run 1 -> got '$run1', expected 'cybered'"; fail=1; fi
if echo "$run2" | grep -q 'no-change precheck'; then echo "  ok   no-change precheck run 2 (identical board) -> no-op, nudge NOT resent"
else echo "  FAIL no-change precheck run 2 -> got '$run2', expected the no-op line (fingerprint should have matched)"; fail=1; fi

# A genuinely different candidate SET (fixture switch to zero waiting cards -- eng-one-planned has
# only 'planned' cards, none 'waiting') must NOT be suppressed -- the precheck compares fingerprints,
# not "did we already run once". NOT all-answered/no-review/designated: those fixtures' single
# waiting card also happens to be id "c1" with no updated_at field, same as one-open's -- the
# fingerprint is over (id, updated_at) pairs, so those genuinely collide with run1/run2's state
# (this IS the mechanism working correctly, not a test bug -- caught while writing this control).
start_board eng-one-planned || { echo "  FAIL eng-one-planned -- fake board never came up"; fail=1; }
CHANGED_PID="$BOARD_PID"; CHANGED_PORT="$BOARD_PORT"
run3="$(DASH="http://127.0.0.1:$CHANGED_PORT" NUDGER_STATE_FILE="$NUDGE_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-WORK://p')"
kill "$CHANGED_PID" 2>/dev/null; wait "$CHANGED_PID" 2>/dev/null
# "none" (the real, computed decision -- eng-one-planned has no WAITING cards at all, let alone gate
# work) is a DIFFERENT string than the no-change-precheck's own no-op line, even though both mean
# "nobody gets nudged
# this run" -- the assertion is that a REAL decision ran, not that gate agents ended up empty either way.
if [ "$(echo $run3)" = "none" ]; then
  echo "  ok   no-change precheck run 3 (different board) -> real decision made, not suppressed"
else echo "  FAIL no-change precheck run 3 -> got '$run3', expected 'none' (a real, non-precheck decision)"; fail=1; fi

# ENG-CONDITIONAL NO-CHANGE PRECHECK (card 4cdb7e31). plan[a] answers "is there a planned card",
# never "is there anything new", and four cards on the live board sit in planned by decision rather
# than by a BLOKKOLT- title -- so backend was sent the identical full rule-11 nudge every minute
# forever. Three runs against ONE state file: first send, suppressed resend, and a genuinely moved
# card that must NOT be suppressed.
ENG_STATE_FILE="$TMP/eng-state.json"
eng_run() { # $1 = scenario -> sets ENG_WORK / ENG_UNCH
  local pid
  start_board "$1" || { echo "  FAIL $1 -- fake board never came up"; fail=1; return; }
  pid="$BOARD_PID"; local port="$BOARD_PORT"
  local out
  out="$(DASH="http://127.0.0.1:$port" NUDGER_STATE_FILE="$ENG_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null)"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  ENG_WORK="$(echo "$out" | sed -n 's/^ENG-WORK://p' | xargs)"
  ENG_UNCH="$(echo "$out" | sed -n 's/^ENG-UNCHANGED://p' | xargs)"
}

eng_run eng-one-planned
if [ "$ENG_WORK" = "backend" ] && [ "$ENG_UNCH" = "none" ]; then
  echo "  ok   eng precheck run 1 (fresh state) -> nudged 'backend', nothing suppressed"
else echo "  FAIL eng precheck run 1 -> work='$ENG_WORK' unchanged='$ENG_UNCH', expected 'backend' / 'none'"; fail=1; fi

eng_run eng-one-planned
if [ "$ENG_WORK" = "none" ] && [ "$ENG_UNCH" = "backend" ]; then
  echo "  ok   eng precheck run 2 (identical board) -> suppressed, nudge NOT resent"
else echo "  FAIL eng precheck run 2 -> work='$ENG_WORK' unchanged='$ENG_UNCH', expected 'none' / 'backend'"; fail=1; fi

# The load-bearing negative control: plan['backend'] is True in BOTH fixtures, so anything keyed on
# the boolean passes run 2 above and still fails here.
eng_run eng-planned-moved
if [ "$ENG_WORK" = "backend" ] && [ "$ENG_UNCH" = "none" ]; then
  echo "  ok   eng precheck run 3 (card moved, same boolean) -> resent, not suppressed"
else echo "  FAIL eng precheck run 3 -> work='$ENG_WORK' unchanged='$ENG_UNCH', expected 'backend' / 'none'"; fail=1; fi

# STATE MERGE (card 4cdb7e31): two branches now persist into one file. The gate branch used to write
# the whole object, which would drop engFp on every run and silently turn the precheck just added
# back off -- with no visible symptom except the original bug returning. The runs above went through
# the gate branch too, so both keys must be present together.
keys="$(python3 -c "
import json
d = json.load(open('$ENG_STATE_FILE'))
print('gateFp' in d, 'engFp:backend' in d)
" 2>/dev/null)"
if [ "$keys" = "True True" ]; then
  echo "  ok   state file keeps gateFp and engFp:backend together (write merges, not replaces)"
else echo "  FAIL state merge -> got '$keys', expected 'True True' (one branch clobbered the other)"; fail=1; fi

[ $fail -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
