#!/bin/bash
# Contract tests for scripts/ollama-boot-restore.sh (card b9a657e6).
# Run: bash scripts/__tests__/ollama-boot-restore.test.sh
#
# Exercises all four guards (pid/port, masked, uptime, dxgkrnl), the mask
# alert-once behavior, dryrun, and the restart+probe path -- all through the
# real script via its OLLAMA_RESTORE_* test hooks (no real ollama/journalctl/
# Telegram touched).

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/ollama-boot-restore.sh"

fresh_case() { local d; d="$TMPDIR_BASE/case-$1"; mkdir -p "$d"; echo "$d"; }

# A dead loopback port so ollama_up() always fails without touching the real Ollama on this box.
DEAD_HOST="http://127.0.0.1:1"

run() {
  # $1=state_dir $2=port_check(up|down) $3=uptime_file(or '') $4=dmesg_file(or '') ; rest = extra env
  local state="$1" port="$2" uptime_f="$3" dmesg_f="$4"
  shift 4
  OLLAMA_HOST="$DEAD_HOST" \
  OLLAMA_RESTORE_STATE_DIR="$state" \
  OLLAMA_RESTORE_PORT_CHECK_OVERRIDE="$port" \
  OLLAMA_RESTORE_UPTIME_OVERRIDE="$uptime_f" \
  OLLAMA_RESTORE_DMESG_OVERRIDE="$dmesg_f" \
  OLLAMA_RESTORE_ALERT_DRYRUN=1 \
  "$@" bash "$SCRIPT" 2>&1
}

echo "=== ollama-boot-restore.test.sh ==="

# --- Guard 1: pid/port check -------------------------------------------------------------------
d="$(fresh_case port-up)"
out="$(run "$d" up '' '')"
if echo "$out" | grep -q 'already up (port/pid check)'; then
  pass "port-check UP short-circuits before anything else"
else
  fail "port-check UP did not short-circuit: $out"
fi

# --- ollama_up() itself (the HTTP probe, independent of the port/pid check) --------------------
# Low uptime + a start-cmd override that is a pure no-op keeps this hermetic even if run somewhere
# without journalctl/a real Ollama binary (CI): the low-uptime guard defers before anything real
# would be attempted, so this only proves ollama_up() itself does not lie about a dead host.
d="$(fresh_case http-up)"
echo "1.0 1.0" > "$d/uptime"
out="$(run "$d" down "$d/uptime" '')"
if echo "$out" | grep -q 'already answering'; then
  fail "http probe against a DEAD host falsely reported UP: $out"
else
  pass "http probe against a dead host does not falsely report UP"
fi

# --- Guard 2: masked flag -----------------------------------------------------------------------
d="$(fresh_case masked-first)"
cat > "$d/.gpu-crashloop-guard-masked.json" <<'JSON'
{"detected_at": 111, "units": "ollama.service", "reason": "dxgkrnl crash-loop", "restore": "systemctl --user unmask ollama"}
JSON
out="$(run "$d" down '' '')"
if echo "$out" | grep -q 'MASKED -- deferring'; then pass "masked flag defers the restart"; else fail "masked flag did not defer: $out"; fi
if echo "$out" | grep -q 'ALERT_DRYRUN'; then pass "masked flag alerts on FIRST sighting"; else fail "masked flag did not alert on first sighting: $out"; fi
if [ -f "$d/.ollama-boot-restore-mask-alerted" ] && [ "$(cat "$d/.ollama-boot-restore-mask-alerted")" = "111" ]; then
  pass "alert-stamp records the detected_at that was alerted on"
else
  fail "alert-stamp missing or wrong content"
fi

d2="$(fresh_case masked-repeat)"
cp "$d/.gpu-crashloop-guard-masked.json" "$d2/.gpu-crashloop-guard-masked.json"
cp "$d/.ollama-boot-restore-mask-alerted" "$d2/.ollama-boot-restore-mask-alerted"
out2="$(run "$d2" down '' '')"
if echo "$out2" | grep -q 'ALERT_DRYRUN'; then
  fail "same detected_at re-alerted (should be silent): $out2"
else
  pass "same detected_at does NOT re-alert (silent on repeat sweeps)"
fi

d3="$(fresh_case masked-changed)"
cp "$d/.ollama-boot-restore-mask-alerted" "$d3/.ollama-boot-restore-mask-alerted"
cat > "$d3/.gpu-crashloop-guard-masked.json" <<'JSON'
{"detected_at": 222, "units": "ollama.service", "reason": "second crash-loop", "restore": "systemctl --user unmask ollama"}
JSON
out3="$(run "$d3" down '' '')"
if echo "$out3" | grep -q 'ALERT_DRYRUN'; then
  pass "a NEW detected_at (different mask event) alerts again"
else
  fail "a new mask event did not alert: $out3"
fi

# --- Guard 3: uptime -----------------------------------------------------------------------------
d="$(fresh_case uptime-low)"
echo "60.0 1200.0" > "$d/uptime"
out="$(run "$d" down "$d/uptime" '')"
if echo "$out" | grep -q 'not yet stable'; then pass "low uptime defers"; else fail "low uptime did not defer: $out"; fi

d="$(fresh_case uptime-unreadable)"
out="$(run "$d" down "$d/nope-does-not-exist" '')"
if echo "$out" | grep -q 'could not read uptime'; then
  pass "unreadable uptime fails closed (does not restart)"
else
  fail "unreadable uptime did not fail closed: $out"
fi

# --- Guard 4: dxgkrnl signature -------------------------------------------------------------------
d="$(fresh_case dxg-seen)"
echo "600.0 1200.0" > "$d/uptime"
echo "kernel: misc dxg: dxgk something bad happened" > "$d/dmesg"
out="$(run "$d" down "$d/uptime" "$d/dmesg")"
if echo "$out" | grep -q 'dxgkrnl fault signature already present'; then
  pass "dxgkrnl signature in current boot defers the restart"
else
  fail "dxgkrnl signature did not defer: $out"
fi

d="$(fresh_case dxg-clean)"
echo "600.0 1200.0" > "$d/uptime"
echo "kernel: nothing interesting here" > "$d/dmesg"
out="$(run "$d" down "$d/uptime" "$d/dmesg" env OLLAMA_RESTORE_DRYRUN=1)"
if echo "$out" | grep -q 'DRYRUN: would run'; then
  pass "all guards clear -> reaches the restart step (dryrun)"
else
  fail "all-clear case did not reach the restart step: $out"
fi

# --- Full restart+probe path, with a fake start command -------------------------------------------
d="$(fresh_case restart-fails-to-come-up)"
echo "600.0 1200.0" > "$d/uptime"
echo "clean" > "$d/dmesg"
out="$(OLLAMA_HOST="$DEAD_HOST" OLLAMA_RESTORE_STATE_DIR="$d" OLLAMA_RESTORE_PORT_CHECK_OVERRIDE=down \
  OLLAMA_RESTORE_UPTIME_OVERRIDE="$d/uptime" OLLAMA_RESTORE_DMESG_OVERRIDE="$d/dmesg" \
  OLLAMA_RESTORE_START_CMD_OVERRIDE=true bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q 'restart attempted but /api/tags still not answering'; then
  pass "a start command that never brings Ollama up is reported, not silently swallowed"
else
  fail "failed restart was not reported: $out"
fi

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
