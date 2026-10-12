#!/usr/bin/env bash
# install-wsl-watchdog.selftest.sh -- controls for install-wsl-watchdog.sh (card 58badae1).
#
# INCIDENT 1 (2026-10-12 20:17, MikroB komment 17738): an earlier version of
# this selftest faked powershell.exe on PATH but left TASK_NAME and the
# schtasks.exe path as the real production values -- the script calls them by
# HARDCODED ABSOLUTE PATH, which a PATH-based stub can never intercept. The
# "fake" run registered a REAL Windows Scheduled Task, overwriting a
# deliberate Disable, and restarted the real WSL distro.
#
# INCIDENT 2 (cybered, 2026-10-12 20:47:38, comment 17782): a MUTATION of this
# selftest's own harness -- deliberately flipping the DRY_RUN selector to
# exercise the "unrecognized value" path -- fell through to the REAL branch
# and called the real powershell.exe + schtasks.exe (schtasks /Create did not
# fire only because the live task happened to be Disabled at the time; that
# was luck, not the test's own isolation). Lesson: DRY_RUN correctness must
# NOT be the only thing standing between a test run and a real Windows call.
#
# DEFENSE, two independent layers:
#   1. install-wsl-watchdog.sh's own INSTALL_WSL_WATCHDOG_DRY_RUN=1 seam
#      (unchanged contract: never touches powershell.exe/schtasks.exe at all
#      when correctly selected).
#   2. INSTALL_WSL_WATCHDOG_{SCHTASKS,POWERSHELL,WSLEXE}_BIN overrides, which
#      THIS selftest sets to local fake stubs on EVERY invocation regardless
#      of which DRY_RUN value is under test -- so even a selector that is
#      itself broken (by a real bug or a mutation) cannot reach a real binary
#      during this selftest. assert_no_real_calls() proves the stubs were
#      never invoked for a case that is expected to stay in dry-run.
#
# The generated unit is Windows PowerShell -- this host cannot execute it, so
# PS1-generation controls assert on the GENERATED TEXT. WhiteHat2 delta NO-GO
# (comment 17781) and cybered NO-GO (comment 17782) measured that naive
# substring checks on that text left 9-13 mutants of the restart/grace logic
# undetected, including the FOUNDING bug reintroduced verbatim, because (a) a
# comment in the PS1 can contain the same words as the real code, and (b) a
# substring match does not notice an operator/line being changed as long as
# some other part of the line still matches. Fix: strip_ps1_comments() before
# matching, and check_line() pins a WHOLE line verbatim (not a substring) for
# every security-critical line, so no rewrite of that line can survive.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/install-wsl-watchdog.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { case "$3" in *"$2"*) echo "  ok   $1" ;; *) echo "  FAIL $1 -> needle '$2' not in '$3'"; fail=1 ;; esac; }
check_absent() { case "$3" in *"$2"*) echo "  FAIL $1 -> needle '$2' unexpectedly present"; fail=1 ;; *) echo "  ok   $1" ;; esac; }
# Matches $2 as a COMPLETE line of $3 (grep -F: no regex metachars to escape).
check_line() {
  if printf '%s\n' "$3" | grep -qxF "$2"; then echo "  ok   $1"
  else echo "  FAIL $1 -> exact line not found: '$2'"; fail=1; fi
}
check_line_absent() {
  if printf '%s\n' "$3" | grep -qxF "$2"; then echo "  FAIL $1 -> exact line unexpectedly present: '$2'"; fail=1
  else echo "  ok   $1"; fi
}
# PowerShell comments run '#' to end of line; this generated file never puts a
# literal '#' inside a string, so line-based stripping is exact here.
strip_ps1_comments() { sed -E 's/#.*$//'; }

# --- hermetic fake binaries (defense layer 2, see header) -------------------
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
CALL_LOG="$TMP/real-bin-calls.log"
: > "$CALL_LOG"
cat > "$FAKEBIN/schtasks.sh" <<EOF
#!/usr/bin/env bash
echo "schtasks \$*" >> "$CALL_LOG"
exit 0
EOF
cat > "$FAKEBIN/powershell.sh" <<'EOF'
#!/usr/bin/env bash
echo "powershell $*" >> "__CALL_LOG__"
echo 'C:\FAKE-ISOLATED-LOCALAPPDATA'
exit 0
EOF
sed -i "s#__CALL_LOG__#$CALL_LOG#" "$FAKEBIN/powershell.sh"
cat > "$FAKEBIN/wsl.sh" <<EOF
#!/usr/bin/env bash
echo "wsl \$*" >> "$CALL_LOG"
echo "*  Ubuntu  Running  2"
exit 0
EOF
chmod +x "$FAKEBIN/schtasks.sh" "$FAKEBIN/powershell.sh" "$FAKEBIN/wsl.sh"

run_isolated() { # runs $BIN with the fake-bin overrides ALWAYS set, regardless of DRY_RUN
  INSTALL_WSL_WATCHDOG_SCHTASKS_BIN="$FAKEBIN/schtasks.sh" \
  INSTALL_WSL_WATCHDOG_POWERSHELL_BIN="$FAKEBIN/powershell.sh" \
  INSTALL_WSL_WATCHDOG_WSLEXE_BIN="$FAKEBIN/wsl.sh" \
  bash "$BIN" "$@" 2>&1
}

run_dry() { # $1 = scratch WSL_DIR
  : > "$CALL_LOG"
  INSTALL_WSL_WATCHDOG_DRY_RUN=1 \
  INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$1" \
  WSL_DISTRO_NAME="Ubuntu" \
  run_isolated
}

assert_no_real_calls() { # $1 = label
  if [ -s "$CALL_LOG" ]; then
    echo "  FAIL $1 -> a dry-run case invoked a (fake) real binary: $(cat "$CALL_LOG")"
    fail=1
  else
    echo "  ok   $1"
  fi
}

echo "install-wsl-watchdog controls"

# --- 0. safety: dry-run must require the scratch-dir seam, not silently
#        fall through to a real-looking default -------------------------------
: > "$CALL_LOG"
OUT0="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 WSL_DISTRO_NAME=Ubuntu run_isolated)"; RC0=$?
if [ "$RC0" -ne 0 ]; then
  echo "  ok   dry-run without scratch dir refuses (exit $RC0)"
else
  echo "  FAIL dry-run without INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR did not refuse"
  fail=1
fi
assert_no_real_calls "0: scratch-dir refusal never touches a real binary"

# --- 1. basic dry-run render ---------------------------------------------
mkdir -p "$TMP/run1"
OUT="$(run_dry "$TMP/run1")"
RC=$?
PS1_PATH="$TMP/run1/MikroB/mikrob-wsl-watchdog.ps1"

if [ "$RC" -ne 0 ]; then
  echo "  FAIL install-wsl-watchdog.sh exited $RC (output: $OUT)"
  fail=1
elif [ ! -f "$PS1_PATH" ]; then
  echo "  FAIL rendered PS1 not found at $PS1_PATH (output: $OUT)"
  fail=1
else
  check "dry-run never calls the real scheduler" "DRY-RUN: would register" "$OUT"
  check_absent "dry-run never claims real registration" "registered (every 5 min" "$OUT"
  assert_no_real_calls "1: basic dry-run never touches a real binary"

  PS1_CONTENT="$(cat "$PS1_PATH")"
  PS1_CODE="$(strip_ps1_comments <<< "$PS1_CONTENT")"

  # --- F1 regression pin: the old fail mode must never reappear, on the
  #     COMMENT-STRIPPED code, and the exact restart line is pinned whole so
  #     no rewrite of it (e.g. splitting "--exec"/"/bin/true" into separate
  #     array elements instead of a contiguous substring) can slip past. -----
  check_absent "F1: '--exec /bin/true' substring is gone (raw text)" '--exec /bin/true' "$PS1_CONTENT"
  check_absent "F1: '--exec /bin/true' is gone from comment-stripped code" '--exec /bin/true' "$PS1_CODE"
  check_absent "F1: founding bug alt form '-e true' is gone from code" '-e true' "$PS1_CODE"
  check_line "F1: exact restart line pinned verbatim" \
    '    Start-Process -WindowStyle Hidden -FilePath "wsl.exe" -ArgumentList @("-d", $Distro, "--exec", "/bin/sleep", "infinity")' \
    "$PS1_CONTENT"

  # --- fresh-boot grace (original requirement + F follow-up) ---------------
  check "fresh-boot grace: variable declared" "\$FreshBootGraceSec" "$PS1_CONTENT"
  check "fresh-boot grace: default is 1500 (no env override)" '$FreshBootGraceSec = 1500' "$PS1_CONTENT"
  check "fresh-boot grace: skip marker logged distinctly" "SKIPPED, fresh boot" "$PS1_CONTENT"

  # --- M1 (WhiteHat2 NO-GO, comment 17766): grace clock must be the distro's
  #     own PID 1 age, not the WSL2 VM's /proc/uptime. ----------------------
  check_line "M1: grace clock reads the distro's PID 1 age (exact line)" \
    '$uptimeOut = & wsl.exe -d $Distro -u $WslUser -- ps -o etimes= -p 1 2>$null' \
    "$PS1_CONTENT"
  check_line_absent "M1: grace clock no longer calls 'cat /proc/uptime' (code)" \
    '$uptimeOut = & wsl.exe -d $Distro -u $WslUser -- cat /proc/uptime 2>$null' \
    "$PS1_CODE"
  check_line "M1: uptimeSec initialized to 0 (pin against a dropped guard)" \
    '$uptimeSec = 0' "$PS1_CONTENT"
  check_line "N10: anchored numeric-only match (pin against unanchored regex)" \
    "if (\$LASTEXITCODE -eq 0 -and \$uptimeOut -match '^\s*([0-9]+)\s*\$') { \$uptimeSec = [double]\$matches[1] }" \
    "$PS1_CONTENT"

  # --- grace decision + exit 0, pinned as a WHOLE statement so flipping the
  #     operator (-lt<->-gt), dropping the exit 0, or stubbing the condition
  #     to a constant cannot survive (WhiteHat2 17781 + cybered 17782 B1). --
  check_line "B1: grace condition pinned verbatim (direction + both bounds)" \
    'if ($uptimeSec -gt 0 -and $uptimeSec -lt $FreshBootGraceSec) {' \
    "$PS1_CODE"
  check "B1: grace branch still exits 0 after logging the skip" "exit 0" \
    "$(printf '%s\n' "$PS1_CODE" | sed -n '/if (\$uptimeSec -gt 0/,/^}/p')"

  # --- N2 (cybered 17782, MikroB 17774): grace window is upper-bounded, a
  #     boot-loop under grace must eventually count toward $fails. ---------
  check "N2: MaxFreshSkips bound declared" '$MaxFreshSkips = 10' "$PS1_CONTENT"
  check_line "N2: exceeding MaxFreshSkips falls through to normal counting" \
    '  }' "$(printf '%s\n' "$PS1_CODE" | sed -n '/if (\$freshSkips -lt \$MaxFreshSkips)/,/^  }/p')"
  check "N2: boot-loop case is logged distinctly" "treating as a boot-loop" "$PS1_CONTENT"

  # --- unaffected behavior: MaxFails/MaxRestarts bound still intact --------
  check_line "MaxFails bound intact (exact line)" '$MaxFails    = 3   # consecutive fails (~15 min @ 5-min cadence) before a restart' "$PS1_CONTENT"
  check_line "MaxRestarts bound intact (exact line)" '$MaxRestarts = 3' "$PS1_CONTENT"
fi

# --- configurability: default vs overridden grace window -------------------
mkdir -p "$TMP/run2"
: > "$CALL_LOG"
INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run2" \
  WSL_DISTRO_NAME="Ubuntu" WSL_WATCHDOG_FRESH_BOOT_GRACE_SEC=777 run_isolated >/dev/null 2>&1
PS1_PATH2="$TMP/run2/MikroB/mikrob-wsl-watchdog.ps1"
if [ -f "$PS1_PATH2" ]; then
  check "fresh-boot grace: custom value honored" '$FreshBootGraceSec = 777' "$(cat "$PS1_PATH2")"
else
  echo "  FAIL custom-grace run did not render a PS1"
  fail=1
fi
assert_no_real_calls "custom-grace dry-run never touches a real binary"

# --- idempotency: a second dry-run on the same scratch dir re-renders, does
#     not error (mirrors the script's documented idempotent re-run contract) -
OUT3="$(run_dry "$TMP/run1")"; RC3=$?
[ "$RC3" -eq 0 ] && echo "  ok   dry-run is idempotent (second run exit 0)" || { echo "  FAIL second dry-run exited $RC3"; fail=1; }
assert_no_real_calls "idempotent re-run never touches a real binary"

# --- H1 (WhiteHat2 NO-GO, comment 17766): an existing, Disabled task must
#     never be silently re-enabled by /Create /F -- the registration step is
#     skipped entirely when the (simulated end-to-end) state is "disabled". -
mkdir -p "$TMP/run_h1"
: > "$CALL_LOG"
OUT_H1="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run_h1" \
  INSTALL_WSL_WATCHDOG_DRYRUN_TASK_STATE=disabled WSL_DISTRO_NAME="Ubuntu" run_isolated)"
check "H1: disabled-task mock skips /Create" "skipping /Create" "$OUT_H1"
check_absent "H1: disabled-task mock never claims a would-register line" "DRY-RUN: would register" "$OUT_H1"
assert_no_real_calls "H1: disabled-task mock never touches a real binary"

# --- H1' (WhiteHat2 delta NO-GO, comment 17781): an "unknown" (ambiguous or
#     failed query) state must ALSO skip /Create, never fall through to
#     "ready" -- that fail-open direction is the dangerous one. ------------
mkdir -p "$TMP/run_h1u"
: > "$CALL_LOG"
OUT_H1U="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run_h1u" \
  INSTALL_WSL_WATCHDOG_DRYRUN_TASK_STATE=unknown WSL_DISTRO_NAME="Ubuntu" run_isolated)"
check "H1': unknown-state mock skips /Create (fail-closed)" "skipping /Create" "$OUT_H1U"
check_absent "H1': unknown-state mock never claims a would-register line" "DRY-RUN: would register" "$OUT_H1U"
assert_no_real_calls "H1': unknown-state mock never touches a real binary"

# --- H1' real parse branch (WhiteHat2 17781: "the real parse branch is not
#     tested at all"): classify_task_state() is a pure function, called
#     directly via the script's own CLI-selftest hook with synthetic
#     English/non-English/empty/error-text samples, independent of the
#     DRY_RUN end-to-end seam and of any real schtasks.exe call. -----------
classify() { INSTALL_WSL_WATCHDOG_CLASSIFY_SELFTEST=1 bash "$BIN" "$1" <<< "$2"; }
[ "$(classify 0 '<?xml version="1.0"?><Task><Settings><Enabled>false</Enabled></Settings></Task>')" = "disabled" ] \
  && echo "  ok   H1'-classify: English XML Enabled=false -> disabled" \
  || { echo "  FAIL H1'-classify: English XML Enabled=false did not classify as disabled"; fail=1; }
[ "$(classify 0 '<?xml version="1.0"?><Task><Settings><Enabled>true</Enabled></Settings></Task>')" = "ready" ] \
  && echo "  ok   H1'-classify: English XML Enabled=true -> ready" \
  || { echo "  FAIL H1'-classify: English XML Enabled=true did not classify as ready"; fail=1; }
[ "$(classify 1 '')" = "not-found" ] \
  && echo "  ok   H1'-classify: failed query + empty output -> not-found" \
  || { echo "  FAIL H1'-classify: failed+empty query did not classify as not-found"; fail=1; }
[ "$(classify 1 'ERROR: Access is denied.')" = "unknown" ] \
  && echo "  ok   H1'-classify: failed query + error text -> unknown (not ready, not disabled)" \
  || { echo "  FAIL H1'-classify: error-text query did not classify as unknown"; fail=1; }
[ "$(classify 0 'Scheduled Task State:    Disabled')" = "unknown" ] \
  && echo "  ok   H1'-classify: localized /FO LIST text (no <Enabled> tag) -> unknown, by design (XML-only parse, H1')" \
  || { echo "  FAIL H1'-classify: /FO LIST-style text did not classify as unknown"; fail=1; }
[ "$(classify 0 'Ütemezett feladat állapota: Letiltva')" = "unknown" ] \
  && echo "  ok   H1'-classify: Hungarian localized text with NO <Enabled> tag -> unknown, never silently ready" \
  || { echo "  FAIL H1'-classify: Hungarian text (no <Enabled> tag) did not classify as unknown"; fail=1; }
[ "$(classify 0 '')" = "unknown" ] \
  && echo "  ok   H1'-classify: rc=0 but empty output (e.g. 'query empty -> ready' mutant target) -> unknown, not ready" \
  || { echo "  FAIL H1'-classify: rc=0 empty output did not classify as unknown"; fail=1; }

# --- B2 (MikroB 17774 + cybered 17782): a persistent, version-controlled
#     disable flag must win over ANY query result, including a mocked
#     end-to-end "ready" state. --------------------------------------------
mkdir -p "$TMP/run_b2"
: > "$TMP/.wsl-watchdog-disabled"
: > "$CALL_LOG"
OUT_B2="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run_b2" \
  INSTALL_WSL_WATCHDOG_DRYRUN_TASK_STATE=ready \
  INSTALL_WSL_WATCHDOG_DISABLE_FLAG="$TMP/.wsl-watchdog-disabled" \
  WSL_DISTRO_NAME="Ubuntu" run_isolated)"
check "B2: persistent disable flag overrides a 'ready' query mock" "skipping /Create" "$OUT_B2"
check_absent "B2: persistent disable flag never claims a would-register line" "DRY-RUN: would register" "$OUT_B2"
assert_no_real_calls "B2: disable-flag case never touches a real binary"
rm -f "$TMP/.wsl-watchdog-disabled"
mkdir -p "$TMP/run_b2b"
: > "$CALL_LOG"
OUT_B2B="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run_b2b" \
  INSTALL_WSL_WATCHDOG_DRYRUN_TASK_STATE=ready \
  INSTALL_WSL_WATCHDOG_DISABLE_FLAG="$TMP/.wsl-watchdog-disabled-does-not-exist" \
  WSL_DISTRO_NAME="Ubuntu" run_isolated)"
check "B2: without the flag, a 'ready' mock registers normally (no over-blocking)" "DRY-RUN: would register" "$OUT_B2B"

# --- H2 (WhiteHat2 NO-GO, comment 17766): DRY_RUN fail-open on a non-"1"
#     truthy value is closed -- "true"/"yes" must behave identically to "1",
#     never fall through to the real-install branch. ------------------------
mkdir -p "$TMP/run_h2_true"
: > "$CALL_LOG"
OUT_H2T="$(INSTALL_WSL_WATCHDOG_DRY_RUN=true INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run_h2_true" \
  WSL_DISTRO_NAME="Ubuntu" run_isolated)"; RC_H2T=$?
check "H2: DRY_RUN=true is treated as dry-run" "DRY-RUN: would register" "$OUT_H2T"
[ "$RC_H2T" -eq 0 ] && echo "  ok   H2: DRY_RUN=true exits 0" || { echo "  FAIL H2: DRY_RUN=true exited $RC_H2T"; fail=1; }
assert_no_real_calls "H2: DRY_RUN=true never touches a real binary"

# H2bad: an unrecognized DRY_RUN value must refuse via the SELECTOR itself --
# WhiteHat2 17781 measured that without a valid scratch dir, this exits 1 for
# the WRONG reason (the unrelated ":?" unset-var check), masking a selector
# that silently treats "maybe" as real. Give it a valid scratch dir (so only
# the selector can refuse) AND the hermetic fake binaries (so if the selector
# IS broken, the run still cannot reach a real binary) -- both layers.
mkdir -p "$TMP/run_h2bad"
: > "$CALL_LOG"
OUT_H2BAD="$(INSTALL_WSL_WATCHDOG_DRY_RUN=maybe INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run_h2bad" \
  WSL_DISTRO_NAME="Ubuntu" run_isolated)"; RC_H2BAD=$?
[ "$RC_H2BAD" -ne 0 ] && echo "  ok   H2: unrecognized DRY_RUN value refuses (exit $RC_H2BAD)" || { echo "  FAIL H2: unrecognized DRY_RUN value did not refuse"; fail=1; }
check "H2: refusal names the selector, not an unrelated scratch-dir error" "not a recognized boolean" "$OUT_H2BAD"
assert_no_real_calls "H2: unrecognized-value refusal never touches a real binary (even with a valid scratch dir)"

# H2c: a scratch dir under /mnt/ must be refused even with DRY_RUN=1, and a
# lexical escape ("/tmp/../mnt/...") must be caught too (cybered N9, 17782).
: > "$CALL_LOG"
OUT_H2MNT="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="/mnt/c/not-really-fake" \
  WSL_DISTRO_NAME="Ubuntu" run_isolated)"; RC_H2MNT=$?
[ "$RC_H2MNT" -ne 0 ] && echo "  ok   H2: /mnt/ scratch dir refuses (exit $RC_H2MNT)" || { echo "  FAIL H2: /mnt/ scratch dir did not refuse"; fail=1; }
assert_no_real_calls "H2: /mnt/ scratch dir refusal never touches a real binary"

OUT_H2MNT2="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="/tmp/../mnt/n9-escape-probe" \
  WSL_DISTRO_NAME="Ubuntu" run_isolated)"; RC_H2MNT2=$?
[ "$RC_H2MNT2" -ne 0 ] && echo "  ok   N9: lexical /mnt/ escape ('/tmp/../mnt/...') refuses (exit $RC_H2MNT2)" || { echo "  FAIL N9: lexical /mnt/ escape was not caught"; fail=1; }
[ ! -e "/mnt/n9-escape-probe" ] && echo "  ok   N9: escape probe directory was never created under real /mnt" || { echo "  FAIL N9: /mnt/n9-escape-probe exists -- the escape was not caught in time"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
