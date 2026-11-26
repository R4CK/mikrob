#!/usr/bin/env bash
# Regression test for card 0aba66b8 (WhiteHat2 Cybersec GO on 7dde8ebc, M1): a script killed
# mid-run must never leave the dashboard Bearer token sitting in a /tmp file.
#
# Scope note (CYBERED NO-GO on 8c291307): the first fix round scanned store/*.sh only and missed
# scripts/doctor.sh, which had the exact same vulnerable shape. Case 3 below exercises doctor.sh's
# own Dashboard API block behaviourally; case 4 is a static repo-wide scan (store/ + scripts/) so
# a future reintroduction anywhere in either directory fails this test instead of needing another
# live kill-and-grep to be noticed.
#
# Mechanism for cases 1-3: a black-hole address (RFC 5737 TEST-NET, 192.0.2.0/24) never responds
# and never resets the connection, so a curl call aimed at it blocks for the full duration of this
# test -- giving a window to SIGTERM the process mid-flight, well before its own --max-time fires.
#
# Cases:
#   1. CONTROL (proves the test can actually catch the bug): a copy of the PRE-FIX pattern
#      (mktemp header file, final `rm -f` only on the happy path) -- killed mid-run, asserts the
#      token file DOES leak. If this went green, the test below would be proving nothing.
#   2. REAL: the actual, fixed `_curl_get` from store/redispatch-guard.sh (same pattern used by
#      fleet-concurrency-checks.sh and gate-dispatch-check.sh: token piped via stdin, never
#      written to disk at all) -- killed mid-run, asserts NO token file leaks anywhere under TMPDIR.
#   3. REAL: doctor.sh's own "Dashboard API" block (the one CYBERED found), extracted verbatim and
#      run the same way.
#   4. STATIC SCAN (non-vacuous: asserts the file count it scanned): every store/*.sh and
#      scripts/*.sh file that assigns a var from `mktemp`, writes an `Authorization:` header into
#      it, and uses it in a `curl -H @...`, must ALSO have a `trap ... EXIT` (or a TERM trap that
#      itself calls `exit`, which chains into the EXIT trap) that removes that same var -- anywhere
#      in the file, not just adjacent to the mktemp call. Mutation-tested against case 1's own
#      pre-fix snippet (copied into the scan tree) to prove the scan actually flags the shape.
set -uo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SELF_DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

BLACKHOLE="http://192.0.2.1:9"   # TEST-NET-1, never routed, curl just hangs until timeout
export TOKEN_FILE="$WORK/.dashboard-token"
echo "the-real-dashboard-token" > "$TOKEN_FILE"
export DASH="$BLACKHOLE"
export TMPDIR="$WORK/tmp"
mkdir -p "$TMPDIR"

token_leaked() {
  grep -rl "the-real-dashboard-token" "$TMPDIR" 2>/dev/null
}

# --- Case 1: control, pre-fix pattern -----------------------------------------------------------
cat > "$WORK/pre-fix-pattern.sh" <<'EOF'
#!/usr/bin/env bash
hf="$(mktemp)"; chmod 600 "$hf"
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$hf"
curl -s --max-time 30 -H @"$hf" "${DASH}/x" 2>/dev/null
rm -f "$hf"
EOF
chmod +x "$WORK/pre-fix-pattern.sh"

bash "$WORK/pre-fix-pattern.sh" &
pid=$!
sleep 1
kill -TERM "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

if [ -n "$(token_leaked)" ]; then
  pass "control: pre-fix pattern DOES leak the token file when killed mid-run (test mechanism works)"
else
  fail "control: pre-fix pattern did not leak -- the test setup is not actually catching the bug"
fi
rm -f "$TMPDIR"/tmp.* 2>/dev/null || true

# --- Case 2: real, fixed _curl_get (store/redispatch-guard.sh) ---------------------------------
# shellcheck disable=SC1091
source <(sed -n '/^_curl_get() {/,/^}/p' "$SELF_DIR/redispatch-guard.sh")

_curl_get "/x" &
pid=$!
sleep 1
kill -TERM "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

if [ -z "$(token_leaked)" ]; then
  pass "fixed redispatch-guard.sh _curl_get: no token file left under TMPDIR after SIGTERM mid-run"
else
  fail "fixed redispatch-guard.sh _curl_get: token file LEAKED after SIGTERM mid-run"
fi
rm -f "$TMPDIR"/tmp.* 2>/dev/null || true

# --- Case 3: real, fixed doctor.sh Dashboard API block ------------------------------------------
sed -n '/^# --- Dashboard API/,/^# --- Database/p' "$REPO_ROOT/scripts/doctor.sh" \
  | sed '/^# --- Database/d' > "$WORK/doctor-block.sh"
cat > "$WORK/doctor-runner.sh" <<EOF
#!/usr/bin/env bash
ok() { :; }
fail() { :; }
WEB_PORT="\${DASH#http://localhost:}"
cd "$WORK"
$(cat "$WORK/doctor-block.sh")
EOF
chmod +x "$WORK/doctor-runner.sh"

bash "$WORK/doctor-runner.sh" &
pid=$!
sleep 1
kill -TERM "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

if [ -z "$(token_leaked)" ]; then
  pass "fixed scripts/doctor.sh Dashboard API block: no token file left under TMPDIR after SIGTERM mid-run"
else
  fail "fixed scripts/doctor.sh Dashboard API block: token file LEAKED after SIGTERM mid-run"
fi

# --- Case 4: static scan, store/*.sh + scripts/*.sh, mutation-tested ----------------------------
SCAN_WORK="$WORK/scan"
mkdir -p "$SCAN_WORK/store" "$SCAN_WORK/scripts"
cp "$REPO_ROOT"/store/*.sh "$SCAN_WORK/store/" 2>/dev/null || true
cp "$REPO_ROOT"/scripts/*.sh "$SCAN_WORK/scripts/" 2>/dev/null || true
# This selftest itself embeds the pre-fix pattern as a literal control string (case 1), not as
# production code -- exclude it from the scan it is running, or it would flag its own fixture.
rm -f "$SCAN_WORK/store/token-header-no-tempfile.selftest.sh"
# Plant the known-bad control shape from case 1 so the scan has something real to find.
cp "$WORK/pre-fix-pattern.sh" "$SCAN_WORK/store/zz-mutation-control.sh"

SCAN_OUT="$(python3 "$SELF_DIR/token-header-no-tempfile-scan.py" "$SCAN_WORK/store" "$SCAN_WORK/scripts")"
SCANNED_COUNT="$(printf '%s\n' "$SCAN_OUT" | sed -n 's/^scanned: //p')"
SCANNED_COUNT="${SCANNED_COUNT:-0}"
FLAGGED="$(printf '%s\n' "$SCAN_OUT" | grep '^FLAGGED: ' || true)"

if [ "$SCANNED_COUNT" -lt 1 ]; then
  fail "static scan: found zero mktemp+Authorization candidates to even check -- scan is inert, not passing"
elif ! printf '%s\n' "$FLAGGED" | grep -q "zz-mutation-control.sh"; then
  fail "static scan: did not flag the planted pre-fix control -- the scan cannot catch the bug it exists for"
else
  real_flags="$(printf '%s\n' "$FLAGGED" | grep -v "zz-mutation-control.sh" || true)"
  if [ -n "$real_flags" ]; then
    fail "static scan: real file(s) still match the vulnerable shape (no matching trap):"
    printf '%s\n' "$real_flags" | sed 's/^/     /'
  else
    pass "static scan ($SCANNED_COUNT candidate var(s) across store/+scripts/): planted control caught, zero real files flagged"
  fi
fi

[ "$FAIL" -eq 0 ] && echo "selftest: PASS"
exit "$FAIL"
