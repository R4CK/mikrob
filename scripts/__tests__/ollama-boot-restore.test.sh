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

d="$(fresh_case dxg-unreadable)"
echo "600.0 1200.0" > "$d/uptime"
# No dmesg file created at this path -- the override's own `cat` fails (status != 0), the same
# shape a real `journalctl -k -b 0` failure would take. Card 39b958a4 (Cybersec F1): this must
# defer, not fall through to "no dxg signature found" and restart on an unreadable kernel log.
out="$(run "$d" down "$d/uptime" "$d/no-such-dmesg-file")"
if echo "$out" | grep -q 'or the log could not be read'; then
  pass "unreadable kernel log defers (fail-closed), same stance as the uptime guard"
else
  fail "unreadable kernel log did not defer: $out"
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

# --- Guard 4, REAL journalctl code path (RedHat F-RH2, card 39b958a4, comment 19024) -------------
# Everything above drives dxg_seen_this_boot() through the OLLAMA_RESTORE_DMESG_OVERRIDE seam, which
# never executes the script's actual `journalctl -k -b 0 2>/dev/null` branch -- that production
# branch had ZERO coverage. These cases PATH-shim a fake `journalctl` (no override env var set) so
# the real branch runs, against a script copy (mutation-pinning needs an editable copy).
JBIN_DIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE" "$JBIN_DIR"' EXIT
write_fake_journalctl() {
  # $1 = exit code, $2 = stdout text (may be empty)
  cat > "$JBIN_DIR/journalctl" <<EOF
#!/bin/bash
printf '%s' "$2"
exit $1
EOF
  chmod +x "$JBIN_DIR/journalctl"
}

run_real_journalctl() {
  # Same as run(), but with NO dmesg override -- journalctl comes from PATH ($JBIN_DIR first).
  local state="$1" script="${2:-$SCRIPT}"
  shift 2
  PATH="$JBIN_DIR:$PATH" \
  OLLAMA_HOST="$DEAD_HOST" \
  OLLAMA_RESTORE_STATE_DIR="$state" \
  OLLAMA_RESTORE_PORT_CHECK_OVERRIDE=down \
  OLLAMA_RESTORE_UPTIME_OVERRIDE="$state/uptime" \
  "$@" bash "$script" 2>&1
}

d="$(fresh_case real-journalctl-exit1-empty)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 1 ""
out="$(run_real_journalctl "$d" "$SCRIPT")"
if echo "$out" | grep -q 'or the log could not be read'; then
  pass "real journalctl: nonzero exit, empty stdout -> defers"
else
  fail "real journalctl nonzero exit did not defer: $out"
fi

d="$(fresh_case real-journalctl-exit0-empty)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 ""
out="$(run_real_journalctl "$d" "$SCRIPT")"
if echo "$out" | grep -q 'or the log could not be read'; then
  pass "real journalctl: exit 0, EMPTY stdout -> defers (F-RH1)"
else
  fail "real journalctl exit 0 + empty stdout did not defer: $out"
fi

d="$(fresh_case real-journalctl-no-entries)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "-- No entries --\n"
out="$(run_real_journalctl "$d" "$SCRIPT")"
if echo "$out" | grep -q 'or the log could not be read'; then
  pass "real journalctl: exit 0, '-- No entries --' -> defers (F-RH1)"
else
  fail "real journalctl '-- No entries --' did not defer: $out"
fi

d="$(fresh_case real-journalctl-stderr-hint-only)"
echo "600.0 1200.0" > "$d/uptime"
# The script's own `2>/dev/null` discards stderr -- a permission-hint-only run looks like exit 0 with
# empty stdout to dxg_seen_this_boot(), same as the case above. Modeled explicitly so the intent is
# on record, not just coincidentally covered by the empty-stdout case.
write_fake_journalctl 0 ""
out="$(run_real_journalctl "$d" "$SCRIPT")"
if echo "$out" | grep -q 'or the log could not be read'; then
  pass "real journalctl: exit 0, only a stderr permission hint -> defers (F-RH1)"
else
  fail "real journalctl stderr-hint-only did not defer: $out"
fi

d="$(fresh_case real-journalctl-dxg-signature)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: misc dxg: dxgk something bad happened\n"
out="$(run_real_journalctl "$d" "$SCRIPT")"
if echo "$out" | grep -q 'dxgkrnl fault signature already present'; then
  pass "real journalctl: readable log WITH dxg signature -> defers"
else
  fail "real journalctl dxg signature did not defer: $out"
fi

d="$(fresh_case real-journalctl-clean)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
out="$(run_real_journalctl "$d" "$SCRIPT" env OLLAMA_RESTORE_DRYRUN=1)"
if echo "$out" | grep -q 'DRYRUN: would run'; then
  pass "real journalctl: readable log, no dxg signature -> reaches restart step"
else
  fail "real journalctl clean log did not reach restart: $out"
fi

# --- Mutation pin: swallowing journalctl's exit status must turn this suite RED (RedHat's J1) -----
# RedHat (19024, item 4): `text="$(journalctl -k -b 0 2>/dev/null || true)"` always reports status=0,
# even when journalctl itself failed. Fixture: journalctl exits 1 (a real failure) but still manages
# to print ONE readable-looking kernel line first (e.g. a read that fails partway through) -- the
# F-RH1 empty-output check alone would NOT catch this (the text is non-empty and contains "kernel:"),
# so this is the one case that isolates "did we honor the exit code" from "did we check the content".
MUTANT_SCRIPT="$TMPDIR_BASE/ollama-boot-restore.mutant-j1.sh"
sed 's#text="\$(journalctl -k -b 0 2>/dev/null)"#text="$(journalctl -k -b 0 2>/dev/null || true)"#' \
  "$SCRIPT" > "$MUTANT_SCRIPT"
if diff -q "$SCRIPT" "$MUTANT_SCRIPT" >/dev/null 2>&1; then
  fail "J1 mutant sed did not match anything -- the mutation was not actually applied, this pin is dead"
else
  pass "J1 mutant script differs from the original (the sed substitution matched)"
fi
d="$(fresh_case real-journalctl-j1-mutant)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 1 "Oct 14 20:00:00 host kernel: partial read before the failure\n"
# DRYRUN=1: if the mutant wrongly clears guard 4, this must only PRINT what it would run, never
# actually spawn `ollama serve` -- the mutation-pin's job is to detect the bug, not to act on it.
out="$(run_real_journalctl "$d" "$MUTANT_SCRIPT" env OLLAMA_RESTORE_DRYRUN=1)"
if echo "$out" | grep -q 'or the log could not be read'; then
  fail "J1 mutant (swallows journalctl's exit status) was NOT caught -- it still deferred correctly, this pin does not detect the regression"
elif echo "$out" | grep -q 'DRYRUN: would run'; then
  pass "J1 mutant (swallows journalctl's exit status) is caught: the mutated script wrongly proceeds past guard 4 instead of deferring"
else
  fail "J1 mutant produced neither the defer message nor DRYRUN -- unexpected output, investigate: $out"
fi

# --- Full restart+probe path, with a fake start command -------------------------------------------
d="$(fresh_case restart-fails-to-come-up)"
echo "600.0 1200.0" > "$d/uptime"
echo "kernel: clean, nothing interesting here" > "$d/dmesg"
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
