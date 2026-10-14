#!/usr/bin/env bash
# Self-test for store/gemini-agy-call.sh (card 64788453). Uses a throw-away MARVEEN_ROOT and a stub
# in place of the real seged-hivo.py call (SEGED_HIVO_SCRIPT), while the hourly-count logic still
# runs against the REAL seged-hivo.py (symlinked into the throw-away root) so read_log()/calls_of()
# are exercised for real, not reimplemented a second time just for the test.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_SUT="$SELF_DIR/gemini-agy-call.sh"
REAL_SEGED_HIVO="$SELF_DIR/../scripts/seged-hivo.py"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
mkdir -p "$TD/store" "$TD/scripts" "$TD/base/w"

# F-B (card f6f67dff, WhiteHat2): the live script no longer understands --root/--seged-script/
# --dashboard-token-file/--dashboard-url/--category-check at all (no env flag can re-enable them
# any more). This whole file is the only place that still needs them, so it builds its OWN copy
# with that parsing re-inserted, once, here -- every "$SUT" call below runs against that copy, not
# the real, shipped script. $REAL_SUT (above) stays untouched, for the handful of tests that
# specifically check the live file's behavior.
SUT="$TD/test-sut-gemini-agy-call.sh"
python3 - "$REAL_SUT" "$SUT" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
anchor = '    *) echo "gemini-agy-call: unknown argument: $1" >&2; exit 2 ;;'
assert s.count(anchor) == 1, 'anchor not found exactly once -- gemini-agy-call.sh parsing changed shape'
override_arm = '''    --root|--seged-script|--dashboard-token-file|--dashboard-url|--category-check)
      case "$1" in
        --root) ROOT="$2"; STORE="$ROOT/store"; SEGED_HIVO_HELPERS="$ROOT/scripts/seged-hivo.py"
                SEGED_HIVO="$ROOT/scripts/seged-hivo.py"; DASHBOARD_TOKEN_FILE="$STORE/.dashboard-token" ;;
        --seged-script) SEGED_HIVO="$2" ;;
        --dashboard-token-file) DASHBOARD_TOKEN_FILE="$2" ;;
        --dashboard-url) DASHBOARD_URL="$2" ;;
        --category-check) CATEGORY_CHECK_OVERRIDE="$2" ;;
      esac
      shift 2 ;;
'''
open(dst, 'w').write(s.replace(anchor, override_arm + anchor, 1))
PY
chmod +x "$SUT"
# A COPY, not a symlink (F-A follow-on): seged-hivo.py's own ROOT is __file__-based now, and
# Path(__file__).resolve() follows a symlink straight back to the real repo root, which would
# defeat this sandbox's isolation for the hourly-count import below (same reasoning as
# titok-kapu-onteszt.test.ts's P1-pin and seged-hivo.py's own quota_selftest()).
cp "$REAL_SEGED_HIVO" "$TD/scripts/seged-hivo.py"
ln -s "$SELF_DIR/gemini-agy-category-check.py" "$TD/store/gemini-agy-category-check.py"
echo 'teszt-token' > "$TD/store/.dashboard-token"
PROMPT="$TD/prompt.md"
echo 'Hozz letre egy hello.txt fajlt.' > "$PROMPT"

STUB="$TD/stub-seged-hivo.py"
cat > "$STUB" <<'PYEOF'
import argparse, json, os, sys, time
from datetime import datetime
from pathlib import Path
ap = argparse.ArgumentParser()
ap.add_argument('--seged'); ap.add_argument('--mappa'); ap.add_argument('--prompt')
ap.add_argument('--hivo'); ap.add_argument('--kartya'); ap.add_argument('--feladattipus')
ap.add_argument('--timeout', type=int, default=120)
a = ap.parse_args()
root = Path(os.environ['MARVEEN_ROOT'])
store = root / 'store'
store.mkdir(exist_ok=True)
log = store / 'seged-hivo-naplo.jsonl'
engine, _, model = a.seged.partition(':')
delay = float(os.environ.get('STUB_CALL_DELAY_S', '0'))
if delay:
    time.sleep(delay)
now = datetime.now().astimezone().isoformat(timespec='milliseconds')
status = 'error' if (root / 'FORCE_ERROR').exists() else 'ok'
row = {'ido': now, 'hivas_id': os.urandom(8).hex(), 'hivo': a.hivo, 'kartya': a.kartya,
       'seged': engine, 'modell': model, 'feladattipus': a.feladattipus, 'status': status,
       'exit': 0 if status == 'ok' else 1, 'duracio_s': 0.1, 'tokens_total': 42}
with open(log, 'a') as f:
    f.write(json.dumps(row) + '\n')
print('STUB RESPONSE')
sys.exit(0 if status == 'ok' else 1)
PYEOF

LOG="$TD/store/seged-hivo-naplo.jsonl"
fails=()
n=0

# A persistent fake fleet-dashboard: serves GET /api/kanban/<id> with a fixed card JSON (F1's
# server-side category check) and captures any POST body (the daily-log append) to CAPTURE_FILE
# if given. One process per test-section, killed via its own PID -- `run()`'s default points here
# so the many pre-existing tests below (hourly cap, race, error propagation) don't all need their
# own dashboard stub just to get past the new F1 check.
#
# N3-javitas (card 09117e0a, RedHat NO-GO komment 18498): the category-check now requires
# card.id == the requested --kartya, so the GET handler stamps the trailing path segment (the
# requested card id) into the returned JSON as "id" -- the same static card_json template then
# works for every --kartya value the tests use, instead of needing one stub per id.
start_dashboard_stub() {  # start_dashboard_stub CARD_JSON [CAPTURE_FILE] -- sets DASH_STUB_PORT/DASH_STUB_PID
  # (NOT via command substitution: a `$(...)` call runs in a subshell, and the PID assigned to
  # DASH_STUB_PID below would then be lost the instant that subshell exits.)
  local card_json="$1" capture_file="${2:-}"
  cat <<'PYEOF' > "$TD/dash-stub.py"
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
card_json = sys.argv[1]
capture_file = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        card = json.loads(card_json)
        card['id'] = self.path.rstrip('/').rsplit('/', 1)[-1]
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(card).encode())

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(length)
        if capture_file:
            with open(capture_file, 'wb') as f:
                f.write(body)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')

    def log_message(self, *a):
        pass

srv = HTTPServer(('127.0.0.1', 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PYEOF
  rm -f "$TD/dash-stub-port"
  python3 "$TD/dash-stub.py" "$card_json" "$capture_file" > "$TD/dash-stub-port" 2>/dev/null &
  DASH_STUB_PID=$!
  for _ in $(seq 1 50); do
    [ -s "$TD/dash-stub-port" ] && break
    sleep 0.1
  done
  DASH_STUB_PORT="$(cat "$TD/dash-stub-port" 2>/dev/null || true)"
}

# N3-javitas: a dashboard egy ismeretlen/lejart kartyara is ERVENYES JSON-hibatestet ad vissza
# (404 "Kartya nem talalhato", 401 "Unauthorized"), csak NEM 200-as HTTP-statusszal. Ezt
# utanozza, sets DASH_STUB_PORT/DASH_STUB_PID like start_dashboard_stub.
start_error_dashboard_stub() {  # start_error_dashboard_stub HTTP_STATUS JSON_BODY
  local status="$1" body="$2"
  cat <<PYEOF > "$TD/dash-error-stub.py"
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response($status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'''$body''')

    def log_message(self, *a):
        pass

srv = HTTPServer(('127.0.0.1', 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PYEOF
  rm -f "$TD/dash-stub-port"
  python3 "$TD/dash-error-stub.py" > "$TD/dash-stub-port" 2>/dev/null &
  DASH_STUB_PID=$!
  for _ in $(seq 1 50); do
    [ -s "$TD/dash-stub-port" ] && break
    sleep 0.1
  done
  DASH_STUB_PORT="$(cat "$TD/dash-stub-port" 2>/dev/null || true)"
}

CLEAN_CARD='{"title":"Clean boilerplate card","description":"normal work","labels":["@backend"]}'
start_dashboard_stub "$CLEAN_CARD"
DEFAULT_DASH_PORT="$DASH_STUB_PORT"
DEFAULT_DASH_PID="$DASH_STUB_PID"
if [ -z "$DEFAULT_DASH_PORT" ]; then
  echo "FATAL: default dashboard stub never printed a port" >&2
  exit 2
fi
EXTRA_DASH_PIDS=()
cleanup_dashboard_stubs() {
  kill "$DEFAULT_DASH_PID" 2>/dev/null || true
  for p in "${EXTRA_DASH_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
}
trap 'cleanup_dashboard_stubs; rm -rf "$TD"' EXIT

seed_recent() {  # seed_recent COUNT -- COUNT agy rows, "now"
  local count="$1" i
  : > "$LOG"
  for ((i = 0; i < count; i++)); do
    python3 -c "
import json
from datetime import datetime
print(json.dumps({'ido': datetime.now().astimezone().isoformat(timespec='milliseconds'),
                   'hivas_id': 'seed-$i', 'hivo': 'teszt', 'kartya': 'x', 'seged': 'agy',
                   'modell': 'gemini-3.8-flash-medium', 'feladattipus': 'kod', 'status': 'ok'}))
" >> "$LOG"
  done
}

seed_old() {  # seed_old COUNT -- COUNT agy rows, 2 hours ago (outside the 60-minute window)
  local count="$1" i
  : > "$LOG"
  for ((i = 0; i < count; i++)); do
    python3 -c "
import json
from datetime import datetime, timedelta
ts = (datetime.now().astimezone() - timedelta(hours=2)).isoformat(timespec='milliseconds')
print(json.dumps({'ido': ts, 'hivas_id': 'old-$i', 'hivo': 'teszt', 'kartya': 'x', 'seged': 'agy',
                   'modell': 'gemini-3.8-flash-medium', 'feladattipus': 'kod', 'status': 'ok'}))
" >> "$LOG"
  done
}

run() {
  # --root/--seged-script/--dashboard-url are CLI flags, not env (M1, card 09117e0a): the real
  # dispatch path never passes them, only this selftest does.
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
    "$SUT" --root "$TD" --seged-script "$STUB" \
    --dashboard-url "${GEMINI_DASHBOARD_URL:-http://127.0.0.1:$DEFAULT_DASH_PORT}" "$@" > "$TD/out" 2> "$TD/err"
}

case_() {  # case_ NAME WANT_RC -- args...
  local name="$1" want="$2"; shift 2
  n=$((n + 1))
  set +e
  run "$@"
  local got=$?
  set -e
  if [ "$got" != "$want" ]; then
    fails+=("$name: want rc=$want got rc=$got; stderr: $(cat "$TD/err" | tr '\n' ' ')")
  fi
}

# --- argument validation --------------------------------------------------
: > "$LOG"
case_ 'missing --kategoria -> usage error' 2 \
  --hivo teszt --kartya aaaaaaaa --feladattipus kod --prompt "$PROMPT" --mappa "$TD/base/w"

case_ 'unknown category -> refused, fail-closed' 3 \
  --hivo teszt --kartya aaaaaaaa --feladattipus kod --kategoria nemletezo --prompt "$PROMPT" --mappa "$TD/base/w"

for cat in security auth finance mopsion; do
  case_ "forbidden category '$cat' -> refused" 3 \
    --hivo teszt --kartya aaaaaaaa --feladattipus kod --kategoria "$cat" --prompt "$PROMPT" --mappa "$TD/base/w"
done
if [ -s "$LOG" ]; then
  fails+=("forbidden/unknown category must not write any log row, but $LOG is non-empty")
fi

# --- F1: server-side category check on declared 'safe' (card 09117e0a) ---------------------
: > "$LOG"
start_dashboard_stub '{"title":"[MikroB][INFRA][SEC][HIGH] valami","description":"x","labels":[]}'
SEC_PORT="$DASH_STUB_PORT"
EXTRA_DASH_PIDS+=("$DASH_STUB_PID")
n=$((n + 1))
if [ -z "$SEC_PORT" ]; then
  fails+=("F1 security-titled card stub: never printed a port")
else
  set +e
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
    "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$SEC_PORT" \
    --hivo teszt --kartya 5ec00001 --feladattipus kod --kategoria safe \
    --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err"
  got=$?
  set -e
  [ "$got" = 3 ] || fails+=("F1: a card titled [SEC] declared kategoria=safe must be refused (rc=3), got rc=$got, err=$(cat "$TD/err")")
  grep -q 'STUB RESPONSE' "$TD/out" && fails+=("F1: the underlying helper must NOT have run for a refused security-signalled card")
fi
if [ -s "$LOG" ]; then
  fails+=("F1 refusal must not write any log row, but $LOG is non-empty")
fi

# negative control: a clean card declared safe must still go through (uses the DEFAULT clean stub)
: > "$LOG"
case_ "F1 negative control: clean card + kategoria=safe -> goes" 0 \
  --hivo teszt --kartya c1ea0001 --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"
grep -q 'STUB RESPONSE' "$TD/out" || fails+=("F1 negative control: the underlying helper should have run for a clean card")

# --- F-B: the LIVE, shipped script must refuse --root/--seged-script/--dashboard-url
# unconditionally -- no env var can ever re-enable them (card f6f67dff, WhiteHat2). Runs against
# $REAL_SUT, not the test harness's own patched $SUT copy above, so this is the actual production
# file's behavior being checked.
: > "$LOG"
n=$((n + 1))
set +e
SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  "$REAL_SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$DEFAULT_DASH_PORT" \
  --hivo teszt --kartya c1ea0002 --feladattipus kod --kategoria safe \
  --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err"
got=$?
set -e
[ "$got" = 2 ] || fails+=("F-B: the live gemini-agy-call.sh must refuse --root/--seged-script/--dashboard-url unconditionally (rc=2), got rc=$got, err=$(cat "$TD/err")")
grep -qi 'unknown argument' "$TD/err" || fails+=("F-B: the refusal should read as a plain unknown-argument error, not a special test-mode message, err=$(cat "$TD/err")")

# --- F-C: ambient env poisoning must have no effect -- only the CLI flags on the test harness's
# own $SUT copy can redirect anything; a plain env var sitting in the caller's shell must not
# (card 09117e0a, WhiteHat2 NO-GO komment 18851, MikroB 18854 pont 2). Regression target:
# line "CATEGORY_CHECK=...". A [SEC]-titled card declared safe must still be refused even with a
# no-op category-check path and other bogus values sitting in the environment -- this does NOT
# use the CLI overrides for them, only ambient env, which the script never reads for these names.
: > "$LOG"
n=$((n + 1))
NOOP_CHECK="$TD/noop-category-check.py"
echo 'pass' > "$NOOP_CHECK"
set +e
GEMINI_AGY_CATEGORY_CHECK="$NOOP_CHECK" MARVEEN_ROOT=/nonexistent-poison-root \
  SEGED_HIVO_SCRIPT=/bin/true DASHBOARD_TOKEN_FILE=/dev/null GEMINI_DASHBOARD_URL="http://127.0.0.1:1" \
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$SEC_PORT" \
  --hivo teszt --kartya 5ec00002 --feladattipus kod --kategoria safe \
  --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err"
got=$?
set -e
[ "$got" = 3 ] || fails+=("F-C: ambient env poisoning (GEMINI_AGY_CATEGORY_CHECK/MARVEEN_ROOT/etc) must not weaken the [SEC]+safe refusal (rc=3), got rc=$got, err=$(cat "$TD/err")")
grep -q 'STUB RESPONSE' "$TD/out" && fails+=("F-C: the underlying helper must NOT have run when ambient env tried to poison the gate")

# --- WR1/WR4/WR5/WR6 (RedHat NO-GO komment 18915, M1p'): the F-C case above always supplies ALL
# five CLI overrides, so a hypothetical env-fallback added to any ONE of them stays invisible
# (the CLI value wins regardless of what the mutant's fallback would have picked). Each case below
# withholds exactly the ONE flag whose env name it targets, with a WORKING attacker substitute (not
# a broken/unreachable path), so a future regression is caught as a real bypass, not masked by an
# unrelated override or hidden behind an accidental fail-closed on a bad path. -----------------
GOOD_ROOT="$TD/good-root"
mkdir -p "$GOOD_ROOT/store" "$GOOD_ROOT/scripts/muszertar"
cp "$SUT" "$GOOD_ROOT/store/gemini-agy-call.sh"
chmod +x "$GOOD_ROOT/store/gemini-agy-call.sh"
cp "$REAL_SEGED_HIVO" "$GOOD_ROOT/scripts/seged-hivo.py"
cp "$SELF_DIR/../scripts/muszertar/titok-kapu.py" "$GOOD_ROOT/scripts/muszertar/titok-kapu.py"
cp "$SELF_DIR/gemini-agy-category-check.py" "$GOOD_ROOT/store/gemini-agy-category-check.py"
echo 'teszt-token' > "$GOOD_ROOT/store/.dashboard-token"
GOOD_SUT="$GOOD_ROOT/store/gemini-agy-call.sh"
WR_SEGED_BASE="$TD/wr-seged-munka"
mkdir -p "$WR_SEGED_BASE/w"
WR_SECRET_PROMPT="$TD/wr-secret.md"
printf 'sk-ant-api03-%s9zQ\n' "$(python3 -c "print('A' * 30)")" > "$WR_SECRET_PROMPT"
# WR1/WR4 invoke a REAL (unstubbed) seged-hivo.py, so if either regresses, run_helper() would try
# to really spawn bwrap+agy -- BWRAP_BIN here stands in so even a caught mutant never reaches a
# real, paid Gemini call (same stand-in shape as seged-hivo.py's own quota_selftest bwrap-stub).
WR_BWRAP_STUB="$TD/wr-bwrap-stub.sh"
printf '#!/bin/sh\necho '"'"'{"status": "SUCCESS", "response": "", "usage": {"total_tokens": 1}}'"'"'\n' > "$WR_BWRAP_STUB"
chmod +x "$WR_BWRAP_STUB"

start_validating_dashboard_stub() {  # start_validating_dashboard_stub CARD_JSON EXPECTED_TOKEN
  local card_json="$1" expected="$2"
  cat <<PYEOF > "$TD/dash-validate-stub.py"
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
card_json = sys.argv[1]
expected = 'Bearer ' + sys.argv[2]

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Authorization') != expected:
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"Unauthorized"}')
            return
        card = json.loads(card_json)
        card['id'] = self.path.rstrip('/').rsplit('/', 1)[-1]
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(card).encode())

    def log_message(self, *a):
        pass

srv = HTTPServer(('127.0.0.1', 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PYEOF
  rm -f "$TD/dash-stub-port"
  python3 "$TD/dash-validate-stub.py" "$card_json" "$expected" > "$TD/dash-stub-port" 2>/dev/null &
  DASH_STUB_PID=$!
  for _ in $(seq 1 50); do
    [ -s "$TD/dash-stub-port" ] && break
    sleep 0.1
  done
  DASH_STUB_PORT="$(cat "$TD/dash-stub-port" 2>/dev/null || true)"
}

# WR1: ROOT from MARVEEN_ROOT -- --root is the only switch that moves it today (F-A), so a future
# fallback would only fire when --root is omitted. The SUT runs from a COPY placed at the same
# store/ depth as the real file (a symlink would defeat the isolation the same way it would have
# defeated seged-hivo.py's own ROOT, per the F-A follow-on): with --root omitted, this copy's own
# BASH_SOURCE makes $GOOD_ROOT play "the real repo" for today's unmutated line 49, so the baseline
# check below exercises the real code path, not a stand-in.
: > "$LOG"
EVIL_ROOT_WR1="$TD/evil-root-wr1"
mkdir -p "$EVIL_ROOT_WR1/scripts/muszertar" "$EVIL_ROOT_WR1/store"
cp "$REAL_SEGED_HIVO" "$EVIL_ROOT_WR1/scripts/seged-hivo.py"
printf 'import sys\nsys.exit(0)\n' > "$EVIL_ROOT_WR1/scripts/muszertar/titok-kapu.py"
# The mutant under test only redirects ROOT -- CATEGORY_CHECK ("$STORE/gemini-agy-category-check.py")
# would otherwise also resolve into this evil root and fail to open (a DIFFERENT fail-closed path,
# card id/title check) for a reason unrelated to the one this case targets, masking it either way.
cp "$SELF_DIR/gemini-agy-category-check.py" "$EVIL_ROOT_WR1/store/gemini-agy-category-check.py"
start_dashboard_stub "$CLEAN_CARD"
WR1_PORT="$DASH_STUB_PORT"
EXTRA_DASH_PIDS+=("$DASH_STUB_PID")
n=$((n + 1))
set +e
MARVEEN_ROOT="$EVIL_ROOT_WR1" SEGED_BASE="$WR_SEGED_BASE" BWRAP_BIN="$WR_BWRAP_STUB" \
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  "$GOOD_SUT" --dashboard-url "http://127.0.0.1:$WR1_PORT" --dashboard-token-file "$GOOD_ROOT/store/.dashboard-token" \
  --hivo teszt --kartya c1ea0004 --feladattipus kod --kategoria safe \
  --prompt "$WR_SECRET_PROMPT" --mappa "$WR_SEGED_BASE/w" > "$TD/out" 2> "$TD/err"
got=$?
set -e
[ "$got" = 3 ] || fails+=("WR1: ambient MARVEEN_ROOT must not pick which seged-hivo.py/titok-kapu.py run when --root is omitted (want rc=3), got rc=$got, err=$(cat "$TD/err")")
grep -qi 'SUCCESS\|STUB RESPONSE' "$TD/out" && fails+=("WR1: the underlying engine must NOT have run")

# WR4: SEGED_HIVO (the script actually invoked) from SEGED_HIVO_SCRIPT -- --seged-script is the
# only switch that moves it today, but passing --root ALONGSIDE omitting --seged-script does NOT
# isolate it: gemini-agy-call.sh's own --root branch directly reassigns SEGED_HIVO
# ("$ROOT/scripts/seged-hivo.py") after the initial-default line runs, so a hypothetical env
# fallback written only into that first default assignment would stay masked whenever --root is
# given at all (WhiteHat2 komment 18982, MikroB 18983: measured 32/0 green on exactly that
# mutation). Like WR1, this one must also omit --root and run from the GOOD_SUT copy, so there is
# no --root branch left to overwrite the poisoned default.
: > "$LOG"
EVIL_SCRIPT_WR4="$TD/evil-seged-wr4.py"
printf "import sys\nprint('EVIL-NOOP-RAN')\nsys.exit(0)\n" > "$EVIL_SCRIPT_WR4"
start_dashboard_stub "$CLEAN_CARD"
WR4_PORT="$DASH_STUB_PORT"
EXTRA_DASH_PIDS+=("$DASH_STUB_PID")
n=$((n + 1))
set +e
SEGED_HIVO_SCRIPT="$EVIL_SCRIPT_WR4" SEGED_BASE="$WR_SEGED_BASE" BWRAP_BIN="$WR_BWRAP_STUB" \
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  "$GOOD_SUT" --dashboard-url "http://127.0.0.1:$WR4_PORT" --dashboard-token-file "$GOOD_ROOT/store/.dashboard-token" \
  --hivo teszt --kartya c1ea0005 --feladattipus kod --kategoria safe \
  --prompt "$WR_SECRET_PROMPT" --mappa "$WR_SEGED_BASE/w" > "$TD/out" 2> "$TD/err"
got=$?
set -e
[ "$got" = 3 ] || fails+=("WR4: ambient SEGED_HIVO_SCRIPT must not pick which script runs when --seged-script is omitted (want rc=3), got rc=$got, err=$(cat "$TD/err")")
grep -q 'EVIL-NOOP-RAN' "$TD/out" && fails+=("WR4: the underlying call must NOT have run the attacker's substitute script")

# WR5: DASHBOARD_URL from GEMINI_DASHBOARD_URL -- this one flag has its own flat literal default
# ("http://localhost:3420", card 64788453) independent of --root, so omitting it necessarily
# exercises that real default: the check below depends on the fleet's own dashboard actually
# running, queried read-only against THIS card (09117e0a, a real, permanently [SEC][HIGH]-titled
# card) so the baseline has real ground truth to refuse on.
: > "$LOG"
ATTACKER_DASH="$TD/attacker-dash.py"
cat <<'PYEOF' > "$ATTACKER_DASH"
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'id': self.path.rstrip('/').rsplit('/', 1)[-1],
                                      'title': 'Clean attacker-forged card', 'description': 'x', 'labels': []}).encode())
    def log_message(self, *a):
        pass
srv = HTTPServer(('127.0.0.1', 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PYEOF
rm -f "$TD/dash-stub-port"
python3 "$ATTACKER_DASH" > "$TD/dash-stub-port" 2>/dev/null &
ATTACKER_DASH_PID=$!
EXTRA_DASH_PIDS+=("$ATTACKER_DASH_PID")
for _ in $(seq 1 50); do
  [ -s "$TD/dash-stub-port" ] && break
  sleep 0.1
done
ATTACKER_PORT="$(cat "$TD/dash-stub-port" 2>/dev/null || true)"
n=$((n + 1))
set +e
GEMINI_DASHBOARD_URL="http://127.0.0.1:$ATTACKER_PORT" SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-token-file /home/neon/marveen/store/.dashboard-token \
  --hivo teszt --kartya 09117e0a --feladattipus kod --kategoria safe \
  --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err"
got=$?
set -e
[ "$got" = 3 ] || fails+=("WR5: ambient GEMINI_DASHBOARD_URL must not pick which dashboard answers when --dashboard-url is omitted (want rc=3, the real dashboard must see the real [SEC] card), got rc=$got, err=$(cat "$TD/err")")
grep -q 'STUB RESPONSE' "$TD/out" && fails+=("WR5: the underlying helper must NOT have run")

# WR6: DASHBOARD_TOKEN_FILE from DASHBOARD_TOKEN_FILE -- a validating dashboard stub (the earlier
# F1 stubs never check the header at all) makes the actual token VALUE sent observable. Same
# masking RedHat/WhiteHat2 found for WR4 applies here (--root's branch also reassigns
# DASHBOARD_TOKEN_FILE), so this one also drops --root and runs the GOOD_SUT copy; baseline must
# use the real token at $GOOD_ROOT/store/.dashboard-token (teszt-token, set up above) and go
# through; a poisoned env pointing at a file with a different value would get 401'd.
: > "$LOG"
start_validating_dashboard_stub "$CLEAN_CARD" "teszt-token"
WR6_PORT="$DASH_STUB_PORT"
EXTRA_DASH_PIDS+=("$DASH_STUB_PID")
WRONG_TOKEN_FILE="$TD/wr6-wrong-token"
echo 'wrong-token-value' > "$WRONG_TOKEN_FILE"
n=$((n + 1))
set +e
DASHBOARD_TOKEN_FILE="$WRONG_TOKEN_FILE" SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  "$GOOD_SUT" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$WR6_PORT" \
  --hivo teszt --kartya c1ea0006 --feladattipus kod --kategoria safe \
  --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err"
got=$?
set -e
[ "$got" = 0 ] || fails+=("WR6: ambient DASHBOARD_TOKEN_FILE must not pick which token is sent when --dashboard-token-file is omitted (want rc=0, the real token at \$GOOD_ROOT/store/.dashboard-token must be used), got rc=$got, err=$(cat "$TD/err")")

# F-E: a PYTHONPATH-shadowed base64 module must not disable titok-kapu's live-secret check two
# hops down (card f6f67dff, WhiteHat2). run_gate() (scripts/seged-hivo.py) spawns titok-kapu.py
# via a plain subprocess.run() that inherits the caller's ambient PYTHONPATH -- a directory ahead
# of the stdlib on PYTHONPATH can ship its own no-op base64.py, and since titok-kapu.py's
# live-secret detector (_kodolt_alakok) generates the base64-encoded forms of the real dashboard
# token through that exact module, the shadow makes every base64-encoded live secret invisible to
# the filter (exit 3 silently becomes exit 0, engine called). A fresh, dedicated root (own copies
# of the wrapper/seged-hivo.py/titok-kapu.py/category-check, own dashboard-token value) keeps this
# independent of $GOOD_ROOT's fixtures.
: > "$LOG"
FE_ROOT="$TD/fe-root"
mkdir -p "$FE_ROOT/store" "$FE_ROOT/scripts/muszertar"
cp "$SUT" "$FE_ROOT/store/gemini-agy-call.sh"
chmod +x "$FE_ROOT/store/gemini-agy-call.sh"
cp "$REAL_SEGED_HIVO" "$FE_ROOT/scripts/seged-hivo.py"
cp "$SELF_DIR/../scripts/muszertar/titok-kapu.py" "$FE_ROOT/scripts/muszertar/titok-kapu.py"
cp "$SELF_DIR/gemini-agy-category-check.py" "$FE_ROOT/store/gemini-agy-category-check.py"
printf '%s\n' "$(python3 -c "print('x' * 64)")" > "$FE_ROOT/store/.dashboard-token"
FE_SUT="$FE_ROOT/store/gemini-agy-call.sh"

# A directory ahead of the stdlib with a no-op base64.py: b64encode()/urlsafe_b64encode() return
# b'' so _kodolt_alakok() can never produce a matching base64 form for the real token below.
FE_SHADOW_DIR="$TD/fe-shadow"
mkdir -p "$FE_SHADOW_DIR"
cat > "$FE_SHADOW_DIR/base64.py" <<'PYEOF'
def b64encode(b): return b''
def b64decode(s): return b''
def urlsafe_b64encode(b): return b''
def urlsafe_b64decode(s): return b''
PYEOF

FE_SECRET_PROMPT="$TD/fe-secret.md"
python3 -c "
import base64
tok = open('$FE_ROOT/store/.dashboard-token').read().strip()
print(base64.b64encode(tok.encode()).decode())
" > "$FE_SECRET_PROMPT"

start_dashboard_stub "$CLEAN_CARD"
FE_PORT="$DASH_STUB_PORT"
EXTRA_DASH_PIDS+=("$DASH_STUB_PID")
n=$((n + 1))
set +e
PYTHONPATH="$FE_SHADOW_DIR" SEGED_BASE="$WR_SEGED_BASE" SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 BWRAP_BIN="$WR_BWRAP_STUB" \
  "$FE_SUT" --dashboard-url "http://127.0.0.1:$FE_PORT" \
  --hivo teszt --kartya fe000001 --feladattipus kod --kategoria safe \
  --prompt "$FE_SECRET_PROMPT" --mappa "$WR_SEGED_BASE/w" > "$TD/out" 2> "$TD/err"
got=$?
set -e
[ "$got" = 3 ] || fails+=("F-E: a PYTHONPATH-shadowed base64 module must not hide a base64-encoded live secret from titok-kapu.py (want rc=3, blocked), got rc=$got, err=$(cat "$TD/err")")
grep -q 'STUB RESPONSE' "$TD/out" && fails+=("F-E: the underlying call must NOT have run when the secret should have been caught")

: > "$LOG"
n=$((n + 1))
# Port 1 on loopback refuses connections at once -- stands in for an unreachable dashboard.
set +e
SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:1" \
  --hivo teszt --kartya 11111111 --feladattipus kod --kategoria safe \
  --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err"
got=$?
set -e
[ "$got" = 3 ] || fails+=("F1 fail-closed: an unreachable dashboard must refuse (rc=3), got rc=$got, err=$(cat "$TD/err")")
grep -q 'STUB RESPONSE' "$TD/out" && fails+=("F1 fail-closed: the underlying helper must NOT have run when the card could not be verified")

# --- N3: a non-200 JSON error body (unknown/expired card id) must refuse, not "no signal" -------
: > "$LOG"
for spec in "404:{\"error\":\"Kartya nem talalhato\"}" "401:{\"error\":\"Unauthorized\"}" "500:{\"error\":\"internal\"}"; do
  status="${spec%%:*}" body="${spec#*:}"
  start_error_dashboard_stub "$status" "$body"
  ERR_PORT="$DASH_STUB_PORT"
  EXTRA_DASH_PIDS+=("$DASH_STUB_PID")
  n=$((n + 1))
  if [ -z "$ERR_PORT" ]; then
    fails+=("N3 HTTP $status stub: never printed a port")
    continue
  fi
  set +e
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
    "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$ERR_PORT" \
    --hivo teszt --kartya deadbeef --feladattipus kod --kategoria safe \
    --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err"
  got=$?
  set -e
  [ "$got" = 3 ] || fails+=("N3 HTTP $status: a non-200 JSON error body must refuse (rc=3), got rc=$got, err=$(cat "$TD/err")")
  grep -q 'STUB RESPONSE' "$TD/out" && fails+=("N3 HTTP $status: the underlying helper must NOT have run")
done
if [ -s "$LOG" ]; then
  fails+=("N3 HTTP-error refusal must not write any log row, but $LOG is non-empty")
fi

# --- N3: gemini-agy-category-check.py unit-level id-mismatch / empty-title checks ---------------
# Direct unit coverage of the category-check script itself (card.id must equal the caller-
# supplied expected id, and title must be non-empty) -- the full wrapper-level test above already
# covers the HTTP-status half of N3.
n=$((n + 1))
mismatch_rc=0
echo '{"id":"other0001","title":"Clean","description":"x","labels":[]}' \
  | python3 "$SELF_DIR/gemini-agy-category-check.py" deadbeef > /dev/null 2>&1 || mismatch_rc=$?
[ "$mismatch_rc" = 2 ] || fails+=("category-check: card.id != expected id must return 2 (cannot verify), got $mismatch_rc")

n=$((n + 1))
empty_title_rc=0
echo '{"id":"deadbeef","title":"","description":"x","labels":[]}' \
  | python3 "$SELF_DIR/gemini-agy-category-check.py" deadbeef > /dev/null 2>&1 || empty_title_rc=$?
[ "$empty_title_rc" = 2 ] || fails+=("category-check: empty title must return 2 (cannot verify), got $empty_title_rc")

n=$((n + 1))
match_rc=0
match_out="$(echo '{"id":"deadbeef","title":"Clean","description":"x","labels":[]}' \
  | python3 "$SELF_DIR/gemini-agy-category-check.py" deadbeef)" || match_rc=$?
[ "$match_rc" = 0 ] && [ -z "$match_out" ] || fails+=("category-check: matching id + non-empty clean title must return 0 with no signal, got rc=$match_rc out='$match_out'")

# --- N3: a malformed --kartya must be refused BEFORE any URL/HTTP use ---------------------------
: > "$LOG"
for bad in "not-hex!" "../../etc/passwd" "ab" "" "deadbeef; rm -rf /"; do
  [ -z "$bad" ] && continue  # empty is covered by the existing required-args test
  n=$((n + 1))
  set +e
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
    "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$DEFAULT_DASH_PORT" \
    --hivo teszt --kartya "$bad" --feladattipus kod --kategoria safe \
    --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err"
  got=$?
  set -e
  [ "$got" = 3 ] || fails+=("malformed --kartya '$bad' must refuse (rc=3), got rc=$got, err=$(cat "$TD/err")")
  grep -q 'STUB RESPONSE' "$TD/out" && fails+=("malformed --kartya '$bad': the underlying helper must NOT have run")
done
if [ -s "$LOG" ]; then
  fails+=("malformed --kartya refusal must not write any log row, but $LOG is non-empty")
fi

# --- hourly fleet-wide quota -----------------------------------------------
seed_recent 4
case_ 'hourly: 4 recent agy calls -> 5th goes (control)' 0 \
  --hivo teszt --kartya aaaaaaaa --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"
if ! grep -q 'STUB RESPONSE' "$TD/out"; then
  fails+=("hourly control: expected the stub to actually run, stdout was: $(cat "$TD/out")")
fi

seed_recent 5
case_ 'hourly: 5 recent agy calls -> 6th blocked, exit 5' 5 \
  --hivo teszt --kartya aaaaaaaa --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"
if grep -q 'STUB RESPONSE' "$TD/out"; then
  fails+=("hourly block: the stub must NOT have run when the fleet is already at 5/5")
fi

seed_old 5
case_ 'hourly: 5 calls 2h ago (outside window) -> goes (control)' 0 \
  --hivo teszt --kartya aaaaaaaa --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"

# a call blocked by seged-hivo.py's OWN gates (status=blocked) must not count toward the hourly cap
: > "$LOG"
python3 -c "
import json
from datetime import datetime
rows = [{'ido': datetime.now().astimezone().isoformat(timespec='milliseconds'), 'hivas_id': f'b{i}',
         'hivo': 'teszt', 'kartya': 'x', 'seged': 'agy', 'modell': 'm', 'feladattipus': 'kod',
         'status': 'blocked', 'blokk': 'kapu'} for i in range(5)]
with open('$LOG', 'w') as f:
    for r in rows:
        f.write(json.dumps(r) + chr(10))
"
case_ 'hourly: 5 BLOCKED agy rows do not count -> still goes' 0 \
  --hivo teszt --kartya aaaaaaaa --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"

# --- concurrent callers must not exceed the hourly cap (QA FAIL, comment 18226) -----------------
# Repro of QA's exact scenario: 4 recent agy rows seeded (sent_count=4 < 5 limit), two wrapper
# invocations launched at the SAME instant with a delay in the underlying call to widen the race
# window. Before the fix both passed (6/5 final count); after the fix exactly one must go through
# and the other must be blocked with exit 5.
seed_recent 4
n=$((n + 1))
SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  STUB_CALL_DELAY_S=0.3 GEMINI_AGY_HOURLY_LOCK="$TD/store/hourly.lock" \
  "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$DEFAULT_DASH_PORT" \
  --hivo teszt --kartya a0000001 --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w" \
  > "$TD/race-a.out" 2> "$TD/race-a.err" &
PID_A=$!
SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
  STUB_CALL_DELAY_S=0.3 GEMINI_AGY_HOURLY_LOCK="$TD/store/hourly.lock" \
  "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$DEFAULT_DASH_PORT" \
  --hivo teszt --kartya b0000001 --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w" \
  > "$TD/race-b.out" 2> "$TD/race-b.err" &
PID_B=$!
set +e
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
set -e
ok_count=0
[ "$RC_A" -eq 0 ] && ok_count=$((ok_count + 1))
[ "$RC_B" -eq 0 ] && ok_count=$((ok_count + 1))
blocked_count=0
[ "$RC_A" -eq 5 ] && blocked_count=$((blocked_count + 1))
[ "$RC_B" -eq 5 ] && blocked_count=$((blocked_count + 1))
if [ "$ok_count" -ne 1 ] || [ "$blocked_count" -ne 1 ]; then
  fails+=("concurrent race: want exactly 1 ok (rc=0) + 1 blocked (rc=5), got rc_a=$RC_A rc_b=$RC_B")
fi
final_sent=$(grep -c '"status": "ok"' "$LOG" 2>/dev/null || true)
if [ "$final_sent" != "5" ]; then
  fails+=("concurrent race: want final sent count 5 (4 seed + 1 winner), got $final_sent in $LOG")
fi

# --- error propagation from the underlying call ----------------------------
: > "$LOG"
touch "$TD/FORCE_ERROR"
case_ 'underlying call failing propagates its exit code' 1 \
  --hivo teszt --kartya aaaaaaaa --feladattipus kod --kategoria safe --prompt "$PROMPT" --mappa "$TD/base/w"
rm -f "$TD/FORCE_ERROR"

# --- daily-log posting: status reaches the log, prompt text never does ----
: > "$LOG"
CAPTURE="$TD/capture.json"
start_dashboard_stub "$CLEAN_CARD" "$CAPTURE"
PORT="$DASH_STUB_PORT"
EXTRA_DASH_PIDS+=("$DASH_STUB_PID")
if [ -z "$PORT" ]; then
  fails+=("daily-log capture: stub HTTP server never printed a port")
else
  n=$((n + 1))
  SEGED_SZUNET_MIN_S=0 SEGED_SZUNET_MAX_S=0 \
    "$SUT" --root "$TD" --seged-script "$STUB" --dashboard-url "http://127.0.0.1:$PORT" \
    --hivo teszt --kartya cafe0123 --feladattipus kod --kategoria safe \
    --prompt "$PROMPT" --mappa "$TD/base/w" > "$TD/out" 2> "$TD/err" || true
  if [ ! -s "$CAPTURE" ]; then
    fails+=("daily-log capture: no POST body was captured")
  else
    body="$(cat "$CAPTURE")"
    if ! echo "$body" | grep -q 'cafe0123'; then
      fails+=("daily-log capture: card id missing from the logged content: $body")
    fi
    if echo "$body" | grep -qi 'hello.txt'; then
      fails+=("daily-log capture: prompt TEXT leaked into the daily-log content: $body")
    fi
  fi
fi

for f in "${fails[@]}"; do
  echo "FAIL: $f"
done
echo "gemini-agy-call.selftest: $n passed, ${#fails[@]} failed"
[ "${#fails[@]}" -eq 0 ]
