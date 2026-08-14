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

FIX = {
    'all-answered': ALL_ANSWERED, 'one-open': ONE_OPEN, 'no-review': NO_REVIEW,
    'designated': DESIGNATED, 'labeled': LABELED, 'eng-one-planned': ENG_ONE_PLANNED,
    'eng-planned-moved': ENG_PLANNED_MOVED,
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

  # Isolated per call (card bb1751f2's no-change precheck persists a fingerprint across runs) --
  # without this EVERY case here would default to the LIVE store/.fleet-nudger-state.json, both
  # corrupting the real cron job's persisted state AND letting one case's fingerprint silently
  # suppress the next case's decision (measured: identical placeholder card ids + absent
  # updated_at across these fixtures made every case after the first look like a no-op).
  got="$(DASH="http://127.0.0.1:$port" NUDGER_STATE_FILE="$TMP/state-$scen-$port.json" bash "$NUDGER" --dry-run 2>/dev/null | sed -n "s/^${field}://p")"
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

# MISSING TIER DECISION -> LOUD (card 50d75b47). Rule 4 makes the gate set a per-card DECISION; a
# card with neither a label nor a Gate: line never had one made, and the pipeline used to be unable
# to tell that apart from a deliberate default. These assert the new GATE-TIER-MISSING line.
# all-answered is the load-bearing fixture: c1 carries no designation (reported) while c2 is
# BLOKKOLT (a bound block is not gate work, so it must NOT appear) -- one case, both directions.
run_case all-answered 38821 "c1" "GATE-TIER-MISSING"
run_case designated   38822 ""   "GATE-TIER-MISSING"   # a Gate: line IS a decision
run_case labeled      38823 ""   "GATE-TIER-MISSING"   # so is a gate label, with no line at all
run_case no-review    38824 "c1" "GATE-TIER-MISSING"   # due at card open, not when a REVIEW lands

# ENG-CONDITIONAL (MikroB decision, msg 9910, follow-up to card 14acfadd): backend/fullstack must
# respect plan[a] the same way the gate loop respects designation -- "there is always a
# sec-followup" was the same unconditional assumption the OLD gate predicate made. fron-ted/
# fron-teddy stay unconditional on purpose (design-impl always has a next screen), so they are NOT
# asserted here -- ENG-WORK only ever reports on the conditional pair.
run_case eng-one-planned 38815 "backend"       "ENG-WORK"  # positive: only backend has a planned card
run_case no-review       38816 ""              "ENG-WORK"  # negative: no planned card for either

# PROJECT DISPATCH PRIORITY (card 2d6587fe): PROJECT_PRIORITY_CONFIG override, same isolation
# pattern as the rest of this file -- a throwaway file, never the live setting.
PRIO_FILE="$TMP/priority.json"
echo '{"priority":["marveen-infra","cleancore"]}' > "$PRIO_FILE"
python3 "$TMP/fakeboard.py" no-review 38817 &
PRIO_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:38817/api/kanban" && break; sleep 0.25; done
prio_out="$(DASH="http://127.0.0.1:38817" PROJECT_PRIORITY_CONFIG="$PRIO_FILE" NUDGER_STATE_FILE="$TMP/state-prio.json" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^PRIORITY-PROJECTS://p')"
kill "$PRIO_PID" 2>/dev/null; wait "$PRIO_PID" 2>/dev/null
if [ "$prio_out" = "marveen-infra, cleancore" ]; then echo "  ok   priority config read, order preserved -> '$prio_out'"
else echo "  FAIL priority config -> got '$prio_out'"; fail=1; fi

# Missing/empty config -> "none", unchanged wording (already exercised implicitly by every case
# above, none of which set PROJECT_PRIORITY_CONFIG -- this makes the "none" default explicit).
python3 "$TMP/fakeboard.py" no-review 38818 &
NOPRIO_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:38818/api/kanban" && break; sleep 0.25; done
noprio_out="$(DASH="http://127.0.0.1:38818" PROJECT_PRIORITY_CONFIG="$TMP/does-not-exist.json" NUDGER_STATE_FILE="$TMP/state-noprio.json" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^PRIORITY-PROJECTS://p')"
kill "$NOPRIO_PID" 2>/dev/null; wait "$NOPRIO_PID" 2>/dev/null
if [ "$noprio_out" = "none" ]; then echo "  ok   missing config -> none (default order, unchanged wording)"
else echo "  FAIL missing config -> got '$noprio_out'"; fail=1; fi

# TIER-SIGNAL SUPPRESSION (card 50d75b47): the same undesignated SET, seen twice, must be reported
# once. Without this the signal would re-fire every minute on a standing backlog -- which is how a
# loud signal trains its reader to ignore it, and the whole point is that MikroB acts on it.
# Its own fingerprint, deliberately not the gate one, so the two are asserted independently here.
TIER_STATE_FILE="$TMP/tier-state.json"
python3 "$TMP/fakeboard.py" all-answered 38825 &
TIER_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:38825/api/kanban" && break; sleep 0.25; done
tier1="$(DASH="http://127.0.0.1:38825" NUDGER_STATE_FILE="$TIER_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-TIER-MISSING://p')"
tier2_missing="$(DASH="http://127.0.0.1:38825" NUDGER_STATE_FILE="$TIER_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-TIER-MISSING://p')"
tier2_suppressed="$(DASH="http://127.0.0.1:38825" NUDGER_STATE_FILE="$TIER_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-TIER-SUPPRESSED://p')"
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
python3 "$TMP/fakeboard.py" one-open 38819 &
PRECHECK_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:38819/api/kanban" && break; sleep 0.25; done
run1="$(DASH="http://127.0.0.1:38819" NUDGER_STATE_FILE="$NUDGE_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-WORK://p')"
run2="$(DASH="http://127.0.0.1:38819" NUDGER_STATE_FILE="$NUDGE_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-WORK://p')"
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
python3 "$TMP/fakeboard.py" eng-one-planned 38820 &
CHANGED_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:38820/api/kanban" && break; sleep 0.25; done
run3="$(DASH="http://127.0.0.1:38820" NUDGER_STATE_FILE="$NUDGE_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null | sed -n 's/^GATE-WORK://p')"
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
eng_run() { # $1 = scenario, $2 = port -> sets ENG_WORK / ENG_UNCH
  local pid
  python3 "$TMP/fakeboard.py" "$1" "$2" &
  pid=$!
  for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$2/api/kanban" && break; sleep 0.25; done
  local out
  out="$(DASH="http://127.0.0.1:$2" NUDGER_STATE_FILE="$ENG_STATE_FILE" bash "$NUDGER" --dry-run 2>/dev/null)"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  ENG_WORK="$(echo "$out" | sed -n 's/^ENG-WORK://p' | xargs)"
  ENG_UNCH="$(echo "$out" | sed -n 's/^ENG-UNCHANGED://p' | xargs)"
}

eng_run eng-one-planned 38821
if [ "$ENG_WORK" = "backend" ] && [ "$ENG_UNCH" = "none" ]; then
  echo "  ok   eng precheck run 1 (fresh state) -> nudged 'backend', nothing suppressed"
else echo "  FAIL eng precheck run 1 -> work='$ENG_WORK' unchanged='$ENG_UNCH', expected 'backend' / 'none'"; fail=1; fi

eng_run eng-one-planned 38822
if [ "$ENG_WORK" = "none" ] && [ "$ENG_UNCH" = "backend" ]; then
  echo "  ok   eng precheck run 2 (identical board) -> suppressed, nudge NOT resent"
else echo "  FAIL eng precheck run 2 -> work='$ENG_WORK' unchanged='$ENG_UNCH', expected 'none' / 'backend'"; fail=1; fi

# The load-bearing negative control: plan['backend'] is True in BOTH fixtures, so anything keyed on
# the boolean passes run 2 above and still fails here.
eng_run eng-planned-moved 38823
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
