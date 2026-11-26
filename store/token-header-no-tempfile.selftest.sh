#!/usr/bin/env bash
# Regression test for card 0aba66b8 (WhiteHat2 Cybersec GO on 7dde8ebc, M1): a script killed
# mid-run must never leave the dashboard Bearer token sitting in a /tmp file.
#
# Mechanism: a black-hole address (RFC 5737 TEST-NET, 192.0.2.0/24) never responds and never
# resets the connection, so a curl call aimed at it blocks for the full duration of this test --
# giving a window to SIGTERM the process mid-flight, well before its own --max-time would fire.
#
# Two cases:
#   1. CONTROL (proves the test can actually catch the bug): a copy of the PRE-FIX pattern
#      (mktemp header file, final `rm -f` only on the happy path) -- killed mid-run, asserts the
#      token file DOES leak. If this went green, the test below would be proving nothing.
#   2. REAL: the actual, fixed `_curl_get` from store/redispatch-guard.sh (same pattern used by
#      fleet-concurrency-checks.sh and gate-dispatch-check.sh: token piped via stdin, never
#      written to disk at all) -- killed mid-run, asserts NO token file leaks anywhere under TMPDIR.
set -uo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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

[ "$FAIL" -eq 0 ] && echo "selftest: PASS"
exit "$FAIL"
