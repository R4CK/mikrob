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
OK_SERVER_PIDS=()
stop_ok_servers() {
  local p
  for p in "${OK_SERVER_PIDS[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
}
trap 'stop_ok_servers; rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/ollama-boot-restore.sh"

fresh_case() { local d; d="$TMPDIR_BASE/case-$1"; mkdir -p "$d"; echo "$d"; }

# A dead loopback port so ollama_up() always fails without touching the real Ollama on this box.
DEAD_HOST="http://127.0.0.1:1"

# Card a49d1e1a F1/F2: these findings are about Ollama genuinely answering /api/tags, not merely
# a port being "up" per the pid/port override -- so a real (loopback-only) HTTP server, not another
# shell variable, is what makes the distinction real. Prints "http://127.0.0.1:<port> <pid>" (QA2
# FAIL comment 30353: the caller MUST be `OK_HOST="$(start_ok_server)"` for the URL, which runs this
# whole function in a command-substitution SUBSHELL -- a `$!`-into-array mutation inside that
# subshell is lost the instant it exits, so the top-level OK_SERVER_PIDS array the EXIT trap reads
# never actually gets the pid and the server leaks forever. Printing the pid alongside the URL lets
# the caller append it to the array AT THE TOP LEVEL, outside any subshell.
start_ok_server() {
  local port
  port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  python3 - "$port" <<'PY' >/dev/null 2>&1 &
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
    def log_message(self, *a):
        pass
with socketserver.TCPServer(("127.0.0.1", int(sys.argv[1])), H) as httpd:
    httpd.serve_forever()
PY
  local pid=$!
  local tries=0
  while [ "$tries" -lt 50 ]; do
    curl -fsS -m 1 "http://127.0.0.1:$port/api/tags" >/dev/null 2>&1 && break
    sleep 0.1
    tries=$((tries + 1))
  done
  echo "http://127.0.0.1:$port $pid"
}

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

# --- Card 085444e9 (RedHat F-RH4, 39b958a4 comment 19024): the default restart path must go
# through the systemd --user unit, not a bare `nohup ollama serve` -- a bare nohup skips the
# unit's Environment= lines (OLLAMA_VULKAN=0, flash-attention/KV-cache) entirely. Pins the DEFAULT
# command (no OLLAMA_RESTORE_START_CMD_OVERRIDE set) via the DRYRUN log line: RED on the old
# `setsid nohup ollama serve` default, GREEN once it reads `systemctl --user start ollama`.
if echo "$out" | grep -q 'would run: systemctl --user start ollama'; then
  pass "default restart command goes through the systemd --user unit (single env source)"
else
  fail "default restart command does not go through the unit -- env (OLLAMA_VULKAN=0, flash/KV) would come from nowhere: $out"
fi
if echo "$out" | grep -q 'nohup ollama serve'; then
  fail "default restart command still bypasses the unit with a bare nohup: $out"
else
  pass "default restart command no longer bypasses the unit with a bare nohup"
fi

# --- Guard 5 (card f67ce51e, WhiteHat2 16744 off d57d8a01): the local-first-draft kill switch --
# a boot-restore must not flip it back ON every time the box reboots. ---

# BLOCKING (this card's repro): switch OFF -> must NOT start Ollama, even with every other guard
# clear (same fresh fixture shape as the "all guards clear" case above).
d="$(fresh_case local-first-off)"
echo "600.0 1200.0" > "$d/uptime"
echo "kernel: nothing interesting here" > "$d/dmesg"
printf '{"enabled": false}' > "$d/local-first-draft.json"
out="$(run "$d" down "$d/uptime" "$d/dmesg" env OLLAMA_RESTORE_DRYRUN=1)"
if echo "$out" | grep -q 'local-first-draft switch is OFF'; then
  pass "local-first-draft switch OFF defers the restart"
else
  fail "local-first-draft switch OFF did not defer: $out"
fi
if echo "$out" | grep -q 'DRYRUN: would run'; then
  fail "local-first-draft switch OFF still reached the restart step: $out"
else
  pass "local-first-draft switch OFF never reaches the restart step"
fi

# MUTATION PIN: switch explicitly ON -> old behaviour (reaches the restart step), proving the new
# guard does not block the normal case.
d="$(fresh_case local-first-on)"
echo "600.0 1200.0" > "$d/uptime"
echo "kernel: nothing interesting here" > "$d/dmesg"
printf '{"enabled": true}' > "$d/local-first-draft.json"
out="$(run "$d" down "$d/uptime" "$d/dmesg" env OLLAMA_RESTORE_DRYRUN=1)"
if echo "$out" | grep -q 'DRYRUN: would run'; then
  pass "local-first-draft switch ON still reaches the restart step"
else
  fail "local-first-draft switch ON did not reach the restart step: $out"
fi

# REGRESSION GUARD: no flag file at all (the existing "all guards clear" case above has none) --
# absence defaults to ON, same convention local-first-draft-check.sh's own header documents, and
# that earlier case already proves this reaches DRYRUN; this just names the reason explicitly.
d="$(fresh_case local-first-absent)"
echo "600.0 1200.0" > "$d/uptime"
echo "kernel: nothing interesting here" > "$d/dmesg"
out="$(run "$d" down "$d/uptime" "$d/dmesg" env OLLAMA_RESTORE_DRYRUN=1)"
if echo "$out" | grep -q 'DRYRUN: would run'; then
  pass "no local-first-draft.json at all -> defaults to ON, reaches the restart step"
else
  fail "no local-first-draft.json at all did not default to ON: $out"
fi

# Explicit override: OLLAMA_RESTORE_IGNORE_LOCAL_FIRST_SWITCH=1 starts anyway, logged (card's own
# "vagy csak explicit felulirassal, naplozva" alternative).
d="$(fresh_case local-first-off-override)"
echo "600.0 1200.0" > "$d/uptime"
echo "kernel: nothing interesting here" > "$d/dmesg"
printf '{"enabled": false}' > "$d/local-first-draft.json"
out="$(run "$d" down "$d/uptime" "$d/dmesg" env OLLAMA_RESTORE_DRYRUN=1 OLLAMA_RESTORE_IGNORE_LOCAL_FIRST_SWITCH=1)"
if echo "$out" | grep -q 'OLLAMA_RESTORE_IGNORE_LOCAL_FIRST_SWITCH=1 -- starting'; then
  pass "explicit override logs that it is ignoring the switch"
else
  fail "explicit override did not log: $out"
fi
if echo "$out" | grep -q 'DRYRUN: would run'; then
  pass "explicit override reaches the restart step despite switch OFF"
else
  fail "explicit override did not reach the restart step: $out"
fi

# --- Guard 4, REAL journalctl code path (RedHat F-RH2, card 39b958a4, comment 19024) -------------
# Everything above drives dxg_seen_this_boot() through the OLLAMA_RESTORE_DMESG_OVERRIDE seam, which
# never executes the script's actual `journalctl -k -b 0 2>/dev/null` branch -- that production
# branch had ZERO coverage. These cases PATH-shim a fake `journalctl` (no override env var set) so
# the real branch runs, against a script copy (mutation-pinning needs an editable copy).
JBIN_DIR="$(mktemp -d)"
# QA2 FAIL comment 30353: a bare `trap ... EXIT` REPLACES the whole-script trap set at line 21, not
# chains onto it -- dropping stop_ok_servers here would leak the F1/F2 ok-server (started further
# below, after this line) even with its pid correctly tracked.
trap 'stop_ok_servers; rm -rf "$TMPDIR_BASE" "$JBIN_DIR"' EXIT
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

# Card 39b958a4, WhiteHat2 NO-GO (19141, F1): the new `*kernel:*` content guard masks the
# ORIGINAL F1 fix (the `status != 0 -> defer` branch) on a readable-partial-log shape -- every
# exit-1 fixture above this point used EMPTY stdout, which the kernel: guard alone already
# catches, so the status-check branch had no fixture that isolates it. The one fixture that does
# (exit 1 + one readable "kernel:" line) was previously run ONLY against the J1 mutant copy
# below, never against the real $SCRIPT -- so the "guard is ON" side of that proof was missing,
# only the "guard is OFF" (mutant) side existed. This closes that gap directly against $SCRIPT.
d="$(fresh_case real-journalctl-exit1-partial-kernel-line)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 1 "Oct 14 20:00:00 host kernel: partial read before the failure\n"
out="$(run_real_journalctl "$d" "$SCRIPT")"
if echo "$out" | grep -q 'or the log could not be read'; then
  pass "real journalctl: nonzero exit WITH a readable partial kernel: line -> still defers on exit status alone"
else
  fail "real journalctl nonzero exit with a readable kernel line did not defer: $out"
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

# --- Guard 5, REAL systemctl code path under the PRODUCTION narrow env (WhiteHat2 HIGH + MEDIUM, --
# card 085444e9 fix round). Every case above that reaches the restart step either DRYRUNs or uses
# OLLAMA_RESTORE_START_CMD_OVERRIDE, so the real default `systemctl --user start $UNIT_NAME` branch
# and the XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS export had ZERO coverage of their actually-executed
# shape -- exactly the QA FAIL 28515 / WhiteHat2 MEDIUM gap (the old test only pinned the DRYRUN log
# string, which a mutant could leave untouched while reverting only the real branch). These cases
# PATH-shim a fake `systemctl` that records its argv and the env it actually saw, run under
# `env -i PATH HOME` -- the same narrow env channel-monitor.ts's buildOllamaRestoreEnv() hands this
# script in production (ollama-boot-restore-narrow-env.test.ts pins that narrowness on the TS side).
SBIN_DIR="$(mktemp -d)"
# Same trap-replacement hazard as above (QA2 FAIL comment 30353) -- stop_ok_servers must stay in
# every EXIT trap reassignment from here to end of file, since the F1/F2 ok-server starts after this.
trap 'stop_ok_servers; rm -rf "$TMPDIR_BASE" "$JBIN_DIR" "$SBIN_DIR"' EXIT

write_fake_systemctl() {
  # $1 = exit code for the shim to return.
  cat > "$SBIN_DIR/systemctl" <<EOF
#!/bin/bash
printf '%s\n' "\$*" > "\$OLLAMA_TEST_SYSTEMCTL_CAPTURE/argv"
printf '%s\n' "\${XDG_RUNTIME_DIR:-UNSET}" > "\$OLLAMA_TEST_SYSTEMCTL_CAPTURE/xdg"
printf '%s\n' "\${DBUS_SESSION_BUS_ADDRESS:-UNSET}" > "\$OLLAMA_TEST_SYSTEMCTL_CAPTURE/dbus"
exit $1
EOF
  chmod +x "$SBIN_DIR/systemctl"
}

run_real_systemctl() {
  # Real journalctl (clean) + real systemctl (shimmed), under the exact production narrow env.
  # OLLAMA_RESTORE_ALERT_DRYRUN=1 is load-bearing, not cosmetic: a failed shimmed systemctl now
  # triggers alert_owner() (card 84181422), and without this the real HOME above would make
  # alert_owner read this box's REAL ~/.claude/channels/telegram/.env and send a REAL Telegram
  # message every time this test runs.
  local state="$1" script="${2:-$SCRIPT}" capture="$3" host="${4:-$DEAD_HOST}"
  env -i PATH="$SBIN_DIR:$JBIN_DIR:/usr/bin:/bin" HOME="$HOME" \
    OLLAMA_TEST_SYSTEMCTL_CAPTURE="$capture" \
    OLLAMA_HOST="$host" \
    OLLAMA_RESTORE_STATE_DIR="$state" \
    OLLAMA_RESTORE_PORT_CHECK_OVERRIDE=down \
    OLLAMA_RESTORE_UPTIME_OVERRIDE="$state/uptime" \
    OLLAMA_RESTORE_ALERT_DRYRUN=1 \
    OLLAMA_RESTORE_PROBE_SLEEP_SEC=0 \
    bash "$script" 2>&1
}

d="$(fresh_case real-systemctl-narrow-env)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
CAP="$(mktemp -d)"
write_fake_systemctl 0
out="$(run_real_systemctl "$d" "$SCRIPT" "$CAP")"
if [ -f "$CAP/argv" ] && grep -q -- '--user start ollama' "$CAP/argv"; then
  pass "real systemctl invocation: argv is '--user start ollama' (the actual default command, not the dryrun string)"
else
  fail "real systemctl was not invoked with the expected argv: $(cat "$CAP/argv" 2>/dev/null || echo '<no capture file>')"
fi
if [ -f "$CAP/xdg" ] && [ "$(cat "$CAP/xdg")" != "UNSET" ] && [ "$(cat "$CAP/xdg")" != "" ]; then
  pass "XDG_RUNTIME_DIR reached systemctl under a narrow (env -i PATH HOME) caller env, not UNSET"
else
  fail "XDG_RUNTIME_DIR did not reach systemctl: $(cat "$CAP/xdg" 2>/dev/null || echo '<no capture file>')"
fi
if [ -f "$CAP/dbus" ] && [ "$(cat "$CAP/dbus")" != "UNSET" ] && [ "$(cat "$CAP/dbus")" != "" ]; then
  pass "DBUS_SESSION_BUS_ADDRESS reached systemctl under a narrow caller env, not UNSET"
else
  fail "DBUS_SESSION_BUS_ADDRESS did not reach systemctl: $(cat "$CAP/dbus" 2>/dev/null || echo '<no capture file>')"
fi
if echo "$out" | grep -q 'restart command failed'; then
  fail "a systemctl shim that exits 0 was reported as a failed restart: $out"
fi

d="$(fresh_case real-systemctl-failure-is-loud)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
CAP2="$(mktemp -d)"
write_fake_systemctl 1
out="$(run_real_systemctl "$d" "$SCRIPT" "$CAP2")"
if echo "$out" | grep -q 'restart command failed (rc=1)'; then
  pass "a failed systemctl start is logged loudly with its rc, not a silent no-op"
else
  fail "a failed systemctl start was not reported loudly: $out"
fi

# --- Card 84181422: a failed start must alert the owner, rate-limited to once per failure streak -
d="$(fresh_case failure-streak-alerts-once)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
write_fake_systemctl 1
CAP4="$(mktemp -d)"
ALERTS=0
for sweep in 1 2 3; do
  out="$(run_real_systemctl "$d" "$SCRIPT" "$CAP4")"
  if echo "$out" | grep -q 'ALERT_DRYRUN'; then ALERTS=$((ALERTS + 1)); fi
done
if [ "$ALERTS" -eq 1 ]; then
  pass "a failing systemctl shim across 3 sweeps alerts the owner exactly once (rate-limited)"
else
  fail "expected exactly 1 alert_owner call across 3 failing sweeps, got $ALERTS"
fi
if [ -f "$d/.ollama-boot-restore-fail-alerted" ]; then
  pass "a failure streak leaves a rate-limit stamp behind"
else
  fail "failure streak did not leave the expected .ollama-boot-restore-fail-alerted stamp"
fi

# --- Card a49d1e1a F1/F2: a start that genuinely brings Ollama up (not just rc=0) clears the stamp
read -r OK_HOST OK_HOST_PID <<<"$(start_ok_server)"
OK_SERVER_PIDS+=("$OK_HOST_PID")
write_fake_systemctl 0
CAP5="$(mktemp -d)"
out="$(run_real_systemctl "$d" "$SCRIPT" "$CAP5" "$OK_HOST")"
if [ -f "$d/.ollama-boot-restore-fail-alerted" ]; then
  fail "a genuinely successful restart (Ollama answering) did not clear the fail-alerted stamp: $out"
else
  pass "a genuinely successful restart (Ollama answering) clears the fail-alerted stamp"
fi

# A fresh failure after the stamp was cleared must alert again (streak restarted, not permanently
# silenced by the earlier stamp).
write_fake_systemctl 1
CAP6="$(mktemp -d)"
out="$(run_real_systemctl "$d" "$SCRIPT" "$CAP6")"
if echo "$out" | grep -q 'ALERT_DRYRUN'; then
  pass "a NEW failure streak (after a clearing success) alerts again"
else
  fail "a new failure streak after a cleared stamp did not alert: $out"
fi

# --- Card a49d1e1a F1: rc=0 but Ollama never answers must ALSO alert (not just a nonzero rc) ------
d="$(fresh_case rc0-never-answers-alerts)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
write_fake_systemctl 0
CAP7="$(mktemp -d)"
ALERTS=0
for sweep in 1 2 3; do
  out="$(run_real_systemctl "$d" "$SCRIPT" "$CAP7")"
  if echo "$out" | grep -q 'ALERT_DRYRUN'; then ALERTS=$((ALERTS + 1)); fi
done
if [ "$ALERTS" -eq 1 ]; then
  pass "rc=0 with Ollama never answering alerts exactly once across 3 sweeps (F1)"
else
  fail "expected exactly 1 alert for a successful-rc/dead-probe streak across 3 sweeps, got $ALERTS"
fi
if echo "$out" | grep -q 'still not answering'; then
  pass "the F1 alert path still logs the probe-exhausted message too"
else
  fail "F1 path did not log the probe-exhausted message: $out"
fi

# --- Card a49d1e1a F2: a manual recovery (found healthy on a LATER sweep) clears the stamp, -------
# even though THIS script never ran a successful restart itself.
d="$(fresh_case manual-recovery-clears-stamp)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
write_fake_systemctl 1
CAP8="$(mktemp -d)"
run_real_systemctl "$d" "$SCRIPT" "$CAP8" >/dev/null
if [ ! -f "$d/.ollama-boot-restore-fail-alerted" ]; then
  fail "setup failed: failure streak did not leave a stamp to clear"
fi
# Someone fixes Ollama by hand; the NEXT sweep sees it already up via the pid/port guard, before
# ever reaching the restart logic.
out="$(run "$d" up '' '')"
if [ -f "$d/.ollama-boot-restore-fail-alerted" ]; then
  fail "a manually-recovered Ollama (found via pid/port check) did not clear the fail-alerted stamp: $out"
else
  pass "a manually-recovered Ollama (found via pid/port check on a later sweep) clears the fail-alerted stamp (F2)"
fi

# --- Card a49d1e1a F3: the stamp must be set ONLY after a CONFIRMED send ------------------------
d="$(fresh_case send-failure-no-stamp)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
write_fake_systemctl 1
CAP9="$(mktemp -d)"
out="$(env -i PATH="$SBIN_DIR:$JBIN_DIR:/usr/bin:/bin" HOME="$HOME" \
  OLLAMA_TEST_SYSTEMCTL_CAPTURE="$CAP9" \
  OLLAMA_HOST="$DEAD_HOST" \
  OLLAMA_RESTORE_STATE_DIR="$d" \
  OLLAMA_RESTORE_PORT_CHECK_OVERRIDE=down \
  OLLAMA_RESTORE_UPTIME_OVERRIDE="$d/uptime" \
  OLLAMA_RESTORE_ALERT_FAIL_OVERRIDE=1 \
  OLLAMA_RESTORE_PROBE_SLEEP_SEC=0 \
  bash "$SCRIPT" 2>&1)"
if [ -f "$d/.ollama-boot-restore-fail-alerted" ]; then
  fail "a confirmed-FAILED alert send still left a rate-limit stamp behind: $out"
else
  pass "a failed alert send leaves no stamp (F3)"
fi
# The next sweep must retry the alert, not stay silent because of a stamp that should not exist.
out2="$(env -i PATH="$SBIN_DIR:$JBIN_DIR:/usr/bin:/bin" HOME="$HOME" \
  OLLAMA_TEST_SYSTEMCTL_CAPTURE="$CAP9" \
  OLLAMA_HOST="$DEAD_HOST" \
  OLLAMA_RESTORE_STATE_DIR="$d" \
  OLLAMA_RESTORE_PORT_CHECK_OVERRIDE=down \
  OLLAMA_RESTORE_UPTIME_OVERRIDE="$d/uptime" \
  OLLAMA_RESTORE_ALERT_FAIL_OVERRIDE=1 \
  OLLAMA_RESTORE_PROBE_SLEEP_SEC=0 \
  bash "$SCRIPT" 2>&1)"
if echo "$out2" | grep -q 'ALERT sendMessage FAILED'; then
  pass "the next sweep retries the alert after an undelivered send, instead of staying silent (F3)"
else
  fail "next sweep did not retry the alert after a failed send: $out2"
fi

# --- Card a49d1e1a F4: the owner-facing alert text is accented Hungarian, not ASCII-stripped -----
# WhiteHat2 F3/F4 (comment 30347): the old `grep -o ... | grep -q` shape passes if ANY ONE of the
# two known alert strings (rc!=0, and the F1 rc=0-never-answers one) has an accent -- it was
# vacuously green even with accents stripped from one of them. Now requires BOTH known strings to
# be present (non-vacuity: asserts the population, not just "found something") AND each one
# individually accented.
ALERT_STRING_COUNT="$(grep -coE '"Ollama boot-restore[^"]*"' "$SCRIPT")"
ACCENTED_ALERT_STRING_COUNT="$(grep -oE '"Ollama boot-restore[^"]*"' "$SCRIPT" | grep -cP '[áéíóöőúüű]')"
if [ "$ALERT_STRING_COUNT" -eq 2 ] && [ "$ACCENTED_ALERT_STRING_COUNT" -eq 2 ]; then
  pass "the owner-facing failure alert text uses Hungarian accents (F4)"
else
  fail "the owner-facing failure alert text is missing accents or strings: found $ALERT_STRING_COUNT alert string(s), $ACCENTED_ALERT_STRING_COUNT accented"
fi

# --- Card a49d1e1a F1 (real): alert_owner must treat a REJECTED send (HTTP 401/400/429/500), not --
# only a transport failure, as undelivered. WhiteHat2 F1 (comment 30347, QA2-confirmed): the old
# `curl -s -o /dev/null -K -` had no --fail, so curl exits 0 on ANY HTTP response -- this drives
# the REAL curl branch (no FAIL_OVERRIDE/DRYRUN seam) against a loopback server that actually
# answers with a given status, which the override seam can never exercise.
start_status_server() {
  local code="$1" port
  port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  python3 - "$port" "$code" <<'PY' >/dev/null 2>&1 &
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(int(sys.argv[2]))
        self.end_headers()
    def log_message(self, *a):
        pass
with socketserver.TCPServer(("127.0.0.1", int(sys.argv[1])), H) as httpd:
    httpd.serve_forever()
PY
  local pid=$!
  local tries=0
  while [ "$tries" -lt 50 ]; do
    curl -s -m 1 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null
    [ $? -ne 7 ] && break  # 7 = connection refused; anything else means the server IS listening
    sleep 0.1
    tries=$((tries + 1))
  done
  echo "http://127.0.0.1:$port $pid"
}

# A fresh, fully synthetic HOME -- never touches this box's real Telegram credentials. INSTALL_DIR
# has no .env in this worktree, so ALLOWED_CHAT_ID falls through to this fake TELEGRAM_CHAT_ID.
FAKE_HOME="$(mktemp -d)"
mkdir -p "$FAKE_HOME/.claude/channels/telegram"
printf 'TELEGRAM_BOT_TOKEN=fake-test-token\nTELEGRAM_CHAT_ID=fake-test-chat\n' \
  > "$FAKE_HOME/.claude/channels/telegram/.env"

read -r REJECT_URL REJECT_PID <<<"$(start_status_server 401)"
OK_SERVER_PIDS+=("$REJECT_PID")
d="$(fresh_case alert-rejected-by-telegram)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
write_fake_systemctl 1
CAP10="$(mktemp -d)"
out="$(env -i PATH="$SBIN_DIR:$JBIN_DIR:/usr/bin:/bin" HOME="$FAKE_HOME" \
  OLLAMA_TEST_SYSTEMCTL_CAPTURE="$CAP10" \
  OLLAMA_HOST="$DEAD_HOST" \
  OLLAMA_RESTORE_STATE_DIR="$d" \
  OLLAMA_RESTORE_PORT_CHECK_OVERRIDE=down \
  OLLAMA_RESTORE_UPTIME_OVERRIDE="$d/uptime" \
  OLLAMA_RESTORE_TELEGRAM_API_BASE_OVERRIDE="$REJECT_URL" \
  bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q 'ALERT sendMessage FAILED' && ! echo "$out" | grep -q 'owner alerted via direct Bot API'; then
  pass "a rejected send (HTTP 401) is treated as a real failure, not a delivered alert (F1-real)"
else
  fail "a rejected send (HTTP 401) was NOT treated as a failure: $out"
fi
if [ -f "$d/.ollama-boot-restore-fail-alerted" ]; then
  fail "a rejected send (HTTP 401) still left a rate-limit stamp behind"
else
  pass "a rejected send (HTTP 401) leaves no stamp (F1-real)"
fi

read -r ACCEPT_URL ACCEPT_PID <<<"$(start_status_server 200)"
OK_SERVER_PIDS+=("$ACCEPT_PID")
d="$(fresh_case alert-accepted-by-telegram)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
write_fake_systemctl 1
CAP11="$(mktemp -d)"
out="$(env -i PATH="$SBIN_DIR:$JBIN_DIR:/usr/bin:/bin" HOME="$FAKE_HOME" \
  OLLAMA_TEST_SYSTEMCTL_CAPTURE="$CAP11" \
  OLLAMA_HOST="$DEAD_HOST" \
  OLLAMA_RESTORE_STATE_DIR="$d" \
  OLLAMA_RESTORE_PORT_CHECK_OVERRIDE=down \
  OLLAMA_RESTORE_UPTIME_OVERRIDE="$d/uptime" \
  OLLAMA_RESTORE_TELEGRAM_API_BASE_OVERRIDE="$ACCEPT_URL" \
  bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q 'owner alerted via direct Bot API' && [ -f "$d/.ollama-boot-restore-fail-alerted" ]; then
  pass "an accepted send (HTTP 200) through the real curl path is treated as delivered (control for F1-real)"
else
  fail "an accepted send (HTTP 200) through the real curl path was NOT treated as delivered: $out"
fi

# --- Mutant-kill: reverting the real branch to a bare nohup, with the dryrun string UNCHANGED, ----
# must be caught by the Guard-5 cases above even though the OLD dryrun-string-only test (further up
# this file) would have stayed green (QA FAIL 28515's exact gap).
MUTANT_SCRIPT="$TMPDIR_BASE/ollama-boot-restore-mutant-nohup.sh"
sed 's#eval "\$start_cmd"#setsid nohup ollama serve >/dev/null 2>\&1 \&#' "$SCRIPT" > "$MUTANT_SCRIPT"
chmod +x "$MUTANT_SCRIPT"
d="$(fresh_case real-systemctl-mutant-nohup)"
echo "600.0 1200.0" > "$d/uptime"
write_fake_journalctl 0 "Oct 14 20:00:00 host kernel: nothing interesting here\n"
CAP3="$(mktemp -d)"
write_fake_systemctl 0
out="$(run_real_systemctl "$d" "$MUTANT_SCRIPT" "$CAP3")"
if [ -s "$CAP3/argv" ]; then
  fail "mutant (bare nohup instead of eval \"\$start_cmd\") still invoked systemctl -- mutation did not take, test is vacuous"
else
  pass "mutant (bare nohup) is caught: systemctl was never invoked even though the DRYRUN string (unexercised here) is untouched"
fi

# --- Full restart+probe path, with a fake start command -------------------------------------------
d="$(fresh_case restart-fails-to-come-up)"
echo "600.0 1200.0" > "$d/uptime"
echo "kernel: clean, nothing interesting here" > "$d/dmesg"
out="$(OLLAMA_HOST="$DEAD_HOST" OLLAMA_RESTORE_STATE_DIR="$d" OLLAMA_RESTORE_PORT_CHECK_OVERRIDE=down \
  OLLAMA_RESTORE_UPTIME_OVERRIDE="$d/uptime" OLLAMA_RESTORE_DMESG_OVERRIDE="$d/dmesg" \
  OLLAMA_RESTORE_ALERT_DRYRUN=1 OLLAMA_RESTORE_PROBE_SLEEP_SEC=0 \
  OLLAMA_RESTORE_START_CMD_OVERRIDE=true bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q 'restart attempted but /api/tags still not answering'; then
  pass "a start command that never brings Ollama up is reported, not silently swallowed"
else
  fail "failed restart was not reported: $out"
fi

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
