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
case "\$1" in
  /Query)
    case "\${FAKE_TASK_MODE:-notfound}" in
      enabled) echo '<Task><Settings><Enabled>true</Enabled></Settings></Task>'; exit 0 ;;
      disabled) echo '<Task><Settings><Enabled>false</Enabled></Settings></Task>'; exit 0 ;;
      *) exit 1 ;;  # notfound: no stdout, non-zero rc -- the real schtasks shape for a missing task
    esac
    ;;
  /Create)
    case "\${FAKE_CREATE_MODE:-ok}" in
      fail) exit 1 ;;
      *) exit 0 ;;
    esac
    ;;
esac
EOF
cat > "$FAKEBIN/powershell.sh" <<'EOF'
#!/usr/bin/env bash
echo "powershell $*" >> "__CALL_LOG__"
echo "${FAKE_PS_LOCALAPPDATA:-C:\\FAKE-ISOLATED-LOCALAPPDATA}"
exit 0
EOF
sed -i "s#__CALL_LOG__#$CALL_LOG#" "$FAKEBIN/powershell.sh"
cat > "$FAKEBIN/wsl.sh" <<EOF
#!/usr/bin/env bash
echo "wsl \$*" >> "$CALL_LOG"
echo "*  Ubuntu  Running  2"
exit 0
EOF
cat > "$FAKEBIN/wslpath.sh" <<EOF
#!/usr/bin/env bash
echo "wslpath \$*" >> "$CALL_LOG"
echo "\${FAKE_WSLPATH_OUT:-$TMP/winroot-view}"
EOF
chmod +x "$FAKEBIN/schtasks.sh" "$FAKEBIN/powershell.sh" "$FAKEBIN/wsl.sh" "$FAKEBIN/wslpath.sh"

run_isolated() { # runs $BIN with the fake-bin overrides ALWAYS set, regardless of DRY_RUN
  # Hermetic-selftest fix (card 035d02fc): without an explicit override,
  # install-wsl-watchdog.sh's own default DISABLE_FLAG resolves to
  # $INSTALL_DIR/store/.wsl-watchdog-disabled -- the REAL, gitignored,
  # host-state flag file for whichever checkout $BIN lives in. Every call
  # site below except the B2 cases relies on this function's env, not an
  # explicit override, so without a default here they would silently read
  # that live file: if it happens to exist (e.g. during a real Disable
  # window), TASK_STATE gets forced to "disabled" for cases that are
  # supposed to be exercising something else entirely (H1/H2/F1/...),
  # making them pass or fail for the wrong reason depending on live host
  # state the test never declared. Default to a scratch path that can never
  # exist unless a caller deliberately sets the var first (the B2 cases do).
  INSTALL_WSL_WATCHDOG_DISABLE_FLAG="${INSTALL_WSL_WATCHDOG_DISABLE_FLAG:-$TMP/.wsl-watchdog-disabled-absent-by-default}" \
  INSTALL_WSL_WATCHDOG_SCHTASKS_BIN="$FAKEBIN/schtasks.sh" \
  INSTALL_WSL_WATCHDOG_POWERSHELL_BIN="$FAKEBIN/powershell.sh" \
  INSTALL_WSL_WATCHDOG_WSLEXE_BIN="$FAKEBIN/wsl.sh" \
  INSTALL_WSL_WATCHDOG_WSLPATH_BIN="$FAKEBIN/wslpath.sh" \
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

# --- hermetic-selftest regression (card 035d02fc): a call site that does
#     NOT override INSTALL_WSL_WATCHDOG_DISABLE_FLAG must never read the
#     real, live flag file at $BIN's own natural default location
#     ($INSTALL_DIR/store/.wsl-watchdog-disabled, where $INSTALL_DIR is
#     dirname($BIN)/..) -- regardless of whether that file happens to exist
#     on this host at the time. Create it for real at that exact path, run
#     an ordinary dry-run through run_isolated with NO override, and confirm
#     it still registers (proves the default stayed hermetic); then remove
#     it and confirm the SAME case behaves identically either way.
REAL_INSTALL_DIR="$(cd "$(dirname "$BIN")/.." && pwd)"
REAL_DISABLE_FLAG="$REAL_INSTALL_DIR/store/.wsl-watchdog-disabled"
mkdir -p "$REAL_INSTALL_DIR/store"
LIVE_FLAG_PRE_EXISTED=0
[ -f "$REAL_DISABLE_FLAG" ] && LIVE_FLAG_PRE_EXISTED=1
[ "$LIVE_FLAG_PRE_EXISTED" -eq 0 ] && : > "$REAL_DISABLE_FLAG"
mkdir -p "$TMP/run_hermetic"
: > "$CALL_LOG"
OUT_HERMETIC="$(run_dry "$TMP/run_hermetic")"
[ "$LIVE_FLAG_PRE_EXISTED" -eq 0 ] && rm -f "$REAL_DISABLE_FLAG"
check "hermetic: a real live flag file at BIN's own default path is NOT read by a call site with no override" \
  "DRY-RUN: would register" "$OUT_HERMETIC"
check_absent "hermetic: the live-flag case never falls back to skipping /Create" \
  "skipping /Create" "$OUT_HERMETIC"

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
  check_absent "dry-run never claims real registration" "registered (every 1 min" "$OUT"
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
  # CYBERSEC GO 39120 M1b (HARD CONDITION H-1): a substring needle like
  # '$MaxFreshSkips = 50' is also a substring of '$MaxFreshSkips = 500' --
  # check_line anchors the WHOLE line so 50->500 (and any other digit
  # appended/prepended) is caught, not just a value that happens to share no
  # digits with the real one.
  check_line "N2: MaxFreshSkips bound declared (card d97659cb: re-expressed at the 1-min cadence, was 10 @ 5-min, whole-line pin)" '$MaxFreshSkips = 50' "$PS1_CONTENT"
  check_line "N2: exceeding MaxFreshSkips falls through to normal counting" \
    '  }' "$(printf '%s\n' "$PS1_CODE" | sed -n '/if (\$freshSkips -lt \$MaxFreshSkips)/,/^  }/p')"
  check "N2: boot-loop case is logged distinctly" "treating as a boot-loop" "$PS1_CONTENT"

  # N2 pin (card 035d02fc): comment 17822 measured that the ORIGINAL selftest
  # pinned only that SOME closing brace follows the grace-exceeded branch,
  # not the actual counter value written there -- a mutant that reset
  # FreshSkipCountFile to "0" instead of saturating it at $MaxFreshSkips
  # (reintroducing the exact bug the N2 fix closed: only 1 read in every
  # $MaxFreshSkips counts toward $fails during a sustained boot-loop) would
  # have survived that check. Scope to the boot-loop branch specifically (not
  # the unrelated, legitimate reset-to-0 in the $healthy block above it) and
  # pin both the correct value AND the absence of the old wrong one.
  BOOTLOOP_BRANCH="$(printf '%s\n' "$PS1_CODE" | sed -n '/treating as a boot-loop/,/^}/p')"
  check_line "N2: boot-loop branch SATURATES the skip counter at MaxFreshSkips" \
    '  Set-Content -Path $FreshSkipCountFile -Value "$MaxFreshSkips"' "$BOOTLOOP_BRANCH"
  check_line_absent "N2: boot-loop branch never resets the skip counter to 0 (the bug N2 closed)" \
    '  Set-Content -Path $FreshSkipCountFile -Value "0"' "$BOOTLOOP_BRANCH"

  # --- card d97659cb: 1-min cadence keeps the SAME ~15-min restart threshold
  check_line "MaxFails re-expressed at the 1-min cadence (exact line, ~15 min wall-clock preserved)" '$MaxFails    = 15   # consecutive fails (~15 min @ 1-min cadence) before a restart' "$PS1_CONTENT"
  check_line "MaxRestarts bound intact (exact line)" '$MaxRestarts = 3' "$PS1_CONTENT"

  # --- card 3f6bb903: holder-ensure runs on EVERY tick, before either early
  #     exit (healthy, or fresh-boot-grace skip) ---------------------------
  # CYBERED NO-GO (comment 38947, F-1/F-2): the original form called
  # `pgrep -f "sleep infinity"` directly through wsl.exe's `--` hop, which is
  # unproven and measured both ways (self-match through a non-bash parent
  # shell -> never relaunches; lost quoting -> relaunches every tick
  # unboundedly). Replaced with a dedicated, Linux-testable script invoked
  # the same way the rollback/notify scripts already are.
  check_absent "F-1/F-2 regression: the vulnerable inline pgrep form through wsl.exe's -- hop is gone" \
    'wsl.exe -d $Distro -u $WslUser -- pgrep -f "sleep infinity"' "$PS1_CONTENT"
  check_absent "F-1/F-2 regression: the old any-nonzero-relaunches condition is gone" \
    'if ($LASTEXITCODE -ne 0 -or -not $holderOut) {' "$PS1_CODE"
  check "3f6bb903: holder-ensure command variable declared" '$HolderEnsureCmd' "$PS1_CONTENT"
  check_line "3f6bb903: holder-ensure is invoked as a named script via bash -lc (same pattern as rollback/notify, nothing left for wsl.exe to mis-quote)" \
    '$holderOut = & wsl.exe -d $Distro -u $WslUser -e bash -lc $HolderEnsureCmd 2>$null' \
    "$PS1_CONTENT"
  check_line "F-2 fix (d97659cb: now also requires holderNeeded -gt 0): a relaunch requires exit=1 AND the HOLDER_MISSING marker AND a positive need, not just a nonzero exit" \
    "if (\$holderCheckExit -eq 1 -and (\$holderOut -cmatch '^HOLDER_MISSING') -and \$holderNeeded -gt 0) {" \
    "$PS1_CODE"
  check_line "F-2 fix: any other inconclusive result explicitly does NOT relaunch (fail-closed)" \
    '} else {' "$(printf '%s\n' "$PS1_CODE" | sed -n '/holderCheckExit -eq 0/,/^}/p')"
  # The holder-ensure block (lines pinned above) must appear BEFORE the
  # healthy early-exit in the rendered code -- otherwise a healthy tick would
  # never reach it, reintroducing exactly the bug this card fixes.
  HOLDER_IDX="$(printf '%s\n' "$PS1_CODE" | grep -n '\$HolderEnsureCmd 2>\$null' | head -1 | cut -d: -f1)"
  HEALTHY_EXIT_IDX="$(printf '%s\n' "$PS1_CODE" | grep -n 'if ($healthy) {' | head -1 | cut -d: -f1)"
  if [ -n "$HOLDER_IDX" ] && [ -n "$HEALTHY_EXIT_IDX" ] && [ "$HOLDER_IDX" -lt "$HEALTHY_EXIT_IDX" ]; then
    echo "  ok   3f6bb903: holder-ensure runs BEFORE the healthy early-exit (line $HOLDER_IDX < $HEALTHY_EXIT_IDX)"
  else
    echo "  FAIL 3f6bb903: holder-ensure must run before the healthy early-exit (got holder=$HOLDER_IDX healthy-exit=$HEALTHY_EXIT_IDX)"
    fail=1
  fi

  # Regression guard for the EXACT bug this delta introduced and caught on
  # its own render (markdown-style backticks in a PS1-comment inside the
  # UNQUOTED <<PS1EOF heredoc get command-substituted at render time, since a
  # heredoc body is not shell-comment-aware regardless of a leading '#').
  # A clean render must produce ZERO stderr; this would have caught it.
  DRYRUN_STDERR="$TMP/render-stderr.txt"
  mkdir -p "$TMP/run-stderr-check"
  : > "$CALL_LOG"
  INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="$TMP/run-stderr-check" \
    run_isolated >/dev/null 2>"$DRYRUN_STDERR"
  if [ -s "$DRYRUN_STDERR" ]; then
    echo "  FAIL heredoc-safety: dry-run produced stderr output (a backtick or \$(...) inside the PS1EOF heredoc body gets command-substituted at render time, since heredoc bodies ignore a leading '#'): $(cat "$DRYRUN_STDERR")"
    fail=1
  else
    echo "  ok   heredoc-safety: dry-run render produced zero stderr (guards against backtick/\$(...) command substitution inside the unquoted PS1EOF heredoc)"
  fi

  # --- CYBERSEC NO-GO F-2 / QA FAIL: relaunch cap + give-up alert -----------
  # Card d97659cb: cap re-expressed at the 1-min cadence (60 ticks/hour, was
  # 12 @ 5-min) and now charged per HOLDER PROCESS (a tick can need 2 at
  # once from the zero-holder state), so the cap value and compare also
  # changed shape (-ge count -> count+needed -gt cap).
  # CYBERSEC GO 39120 M1b (HARD CONDITION H-1): whole-line pins, not
  # substring needles -- 30->300 and 3600->36000 are both substrings of the
  # old needle and used to survive.
  check_line "F-2 fix: holder relaunch cap variable declared (re-expressed for the 1-min cadence + per-process charging, was 6)" '$MaxHolderRelaunchesPerWindow = 30' "$PS1_CONTENT"
  check_line "F-2 fix: holder relaunch window variable declared" '$HolderRelaunchWindowSec = 3600' "$PS1_CONTENT"
  check "F-2 fix: cap-notify command declared" '$HolderCapNotifyCmd' "$PS1_CONTENT"
  # CYBERED GO 39119 F-1 / CYBERSEC GO 39120 L-5: the need= parse now joins
  # $holderOut to a plain string FIRST (PowerShell -match on an array does
  # not populate $matches), so the pin follows the real two-line shape
  # instead of the single-line form that bug fix replaced.
  check_line "d97659cb L-5/F-1 fix: holderOut is joined to a string before the need= match (array -match does not populate \$matches)" \
    "\$holderOutJoined = (\$holderOut -join ' ')" "$PS1_CONTENT"
  check "d97659cb: need= is parsed from the joined holder-ensure output" "if (\$holderOutJoined -match 'need=([0-9]+)') { \$holderNeeded = [int]\$matches[1] }" "$PS1_CONTENT"
  check_absent "d97659cb L-5/F-1 regression: the raw unjoined \$holderOut is no longer matched directly for need=" \
    "if (\$holderOut -match 'need=([0-9]+)')" "$PS1_CONTENT"
  check_line "F-2 fix (d97659cb): cap check happens before relaunching, charged by needed count not by tick" \
    '  if (($holderRelaunchCount + $holderNeeded) -gt $MaxHolderRelaunchesPerWindow) {' "$PS1_CODE"
  check_line "F-2 fix: cap-reached branch alerts instead of relaunching" \
    '      & wsl.exe -d $Distro -u $WslUser -e bash -lc $HolderCapNotifyCmd 2>$null' "$PS1_CONTENT"
  # CYBERSEC GO 39120 L-2 / CYBERED GO 39119 F-2: the notify is throttled to
  # once per window (the 1-min cadence can otherwise send ~45/hour once the
  # cap is hit, versus ~6/hour at the old 5-min cadence) -- pin the dedupe
  # key and that the window-start value is what's persisted as "notified".
  check_line "d97659cb L-2/F-2 fix: cap-notify only fires when this window hasn't been notified yet" \
    '    if ($lastNotifiedWindow -ne $holderRelaunchWindowStart) {' "$PS1_CODE"
  check_line "d97659cb L-2/F-2 fix: the notified window is persisted so the NEXT tick in the same window skips the alert" \
    '      Set-Content -Path $HolderCapNotifiedWindowFile -Value "$holderRelaunchWindowStart"' "$PS1_CODE"
  check_line "F-2 fix: a confirmed-present holder resets the relaunch cap" \
    '  Set-Content -Path $HolderRelaunchCountFile -Value "0"' "$PS1_CODE"
  check_line "d97659cb: the relaunch counter is incremented by the NEEDED count, not by a fixed 1" \
    '    $holderRelaunchCount += $holderNeeded' "$PS1_CODE"
  check_line 'd97659cb: exactly $holderNeeded holders are launched (loop bound), never a hardcoded single Start-Process' \
    '    for ($i = 0; $i -lt $holderNeeded; $i++) {' "$PS1_CODE"

  # --- CYBERED NO-GO round 3 (comment 39005, F-1 PowerShell side: P4/P6/P7/P9
  #     survived as unpinned text) -- the window-expiry compare, the count
  #     increment, and both persisted Set-Content writes had no pin at all,
  #     so a mutant on any of them kept this selftest green.
  check_line "F-1 round3: relaunch window expiry compare (-eq 0 OR elapsed -gt window)" \
    '  if ($holderRelaunchWindowStart -eq 0 -or ($nowEpoch - $holderRelaunchWindowStart) -gt $HolderRelaunchWindowSec) {' "$PS1_CODE"
  check_line "F-1 round3: new window start is persisted" \
    '    Set-Content -Path $HolderRelaunchWindowStartFile -Value "$holderRelaunchWindowStart"' "$PS1_CODE"
  # F-1 round3's old fixed "++" increment is superseded by card d97659cb's
  # "incremented by the NEEDED count" check above (+= $holderNeeded) -- that
  # check already pins this line; keeping both would just duplicate it under
  # a stale description.
  check_line "F-1 round3: incremented relaunch count is persisted" \
    '    Set-Content -Path $HolderRelaunchCountFile -Value "$holderRelaunchCount"' "$PS1_CODE"
  # The give-up alert must be reached only AFTER the counter would exceed the
  # cap, not before -- i.e. the cap check line precedes the relaunch
  # Start-Process line within the same branch.
  CAP_CHECK_IDX="$(printf '%s\n' "$PS1_CODE" | grep -n 'holderRelaunchCount + \$holderNeeded) -gt \$MaxHolderRelaunchesPerWindow' | head -1 | cut -d: -f1)"
  RELAUNCH_ACT_IDX="$(printf '%s\n' "$PS1_CODE" | grep -n 'ArgumentList @("-d", \$Distro, "--exec", "/bin/sleep", "infinity")' | head -1 | cut -d: -f1)"
  if [ -n "$CAP_CHECK_IDX" ] && [ -n "$RELAUNCH_ACT_IDX" ] && [ "$CAP_CHECK_IDX" -lt "$RELAUNCH_ACT_IDX" ]; then
    echo "  ok   F-2 fix: the cap is checked BEFORE the relaunch action (line $CAP_CHECK_IDX < $RELAUNCH_ACT_IDX)"
  else
    echo "  FAIL F-2 fix: cap check must precede the relaunch action (got cap=$CAP_CHECK_IDX relaunch=$RELAUNCH_ACT_IDX)"
    fail=1
  fi

  # wsl-watchdog-holder-cap-notify.sh exists, is executable, and is a
  # zero-argument fixed-message script (same shape as its two siblings --
  # deliberately NOT parameterized, to avoid crossing the wsl.exe argument
  # boundary with free text).
  CAP_NOTIFY_SCRIPT="$(dirname "$0")/wsl-watchdog-holder-cap-notify.sh"
  if [ -x "$CAP_NOTIFY_SCRIPT" ]; then
    echo "  ok   wsl-watchdog-holder-cap-notify.sh exists and is executable"
    grep -q 'ENV_FILE="\$HOME/.claude/channels/telegram/.env"' "$CAP_NOTIFY_SCRIPT" \
      && echo "  ok   holder-cap-notify.sh reads the token from the same trusted local .env as its siblings" \
      || { echo "  FAIL holder-cap-notify.sh does not read the token from the expected .env path"; fail=1; }
  else
    echo "  FAIL wsl-watchdog-holder-cap-notify.sh not found or not executable at $CAP_NOTIFY_SCRIPT"
    fail=1
  fi

  # --- card 3f6bb903: unplanned-restart detection + alert -------------------
  check "3f6bb903: last-uptime state file declared" '$LastUptimeFile = "$StateDir\wsl-watchdog-last-uptime.txt"' "$PS1_CONTENT"
  check "3f6bb903: unplanned-restart notify command declared" '$UnplannedRestartNotifyCmd' "$PS1_CONTENT"
  check_line "3f6bb903: uptime-drop-without-our-restart condition pinned verbatim" \
    'if ($uptimeSec -gt 0 -and $lastUptime -gt 0 -and $uptimeSec -lt $lastUptime) {' \
    "$PS1_CODE"
  check_line "3f6bb903: unplanned-restart alert actually invokes the notify script" \
    '  & wsl.exe -d $Distro -u $WslUser -e bash -lc $UnplannedRestartNotifyCmd 2>$null' \
    "$PS1_CONTENT"
  check_line "3f6bb903: baseline is persisted every tick after the comparison" \
    'if ($uptimeSec -gt 0) { Set-Content -Path $LastUptimeFile -Value "$uptimeSec" }' \
    "$PS1_CONTENT"
  # The watchdog's OWN restart must zero the baseline so it never alerts on
  # its own expected uptime reset (the self-suppression this card relies on).
  RESTART_ISSUED_BRANCH="$(printf '%s\n' "$PS1_CODE" | sed -n '/RESTARTING WSL distro/,/WSL restart issued/p')"
  check_line "3f6bb903: watchdog-issued restart zeroes its own uptime baseline" \
    '    Set-Content -Path $LastUptimeFile -Value "0"' "$RESTART_ISSUED_BRANCH"
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
# cybered N9 (comment 17806): pin the actual REFUSAL MESSAGE, not just the
# exit code + absent-directory -- on this host a mutant that deletes the
# realpath guard still exits non-zero because mkdir fails under the
# root-owned real /mnt, which made the OLD assertion pass for the wrong
# reason (the exact trap the H2bad fix already closed once).
check "H2: /mnt/ refusal names the real path, not a coincidental mkdir failure" "resolves under /mnt/" "$OUT_H2MNT"

OUT_H2MNT2="$(INSTALL_WSL_WATCHDOG_DRY_RUN=1 INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR="/tmp/../mnt/n9-escape-probe" \
  WSL_DISTRO_NAME="Ubuntu" run_isolated)"; RC_H2MNT2=$?
[ "$RC_H2MNT2" -ne 0 ] && echo "  ok   N9: lexical /mnt/ escape ('/tmp/../mnt/...') refuses (exit $RC_H2MNT2)" || { echo "  FAIL N9: lexical /mnt/ escape was not caught"; fail=1; }
[ ! -e "/mnt/n9-escape-probe" ] && echo "  ok   N9: escape probe directory was never created under real /mnt" || { echo "  FAIL N9: /mnt/n9-escape-probe exists -- the escape was not caught in time"; fail=1; }
check "N9: escape refusal names the real path too" "resolves under /mnt/" "$OUT_H2MNT2"

# --- F1 (cybered NO-GO, comment 17806, BLOCKING): under `set -e`, a failing
#     query (task does not exist, rc!=0) used to abort the WHOLE installer at
#     the `TASK_QUERY_OUT="$(...)"` assignment, before classify_task_state()
#     or the registration decision ever ran -- a fresh install, or
#     re-registering a deleted task, could never succeed. These three cases
#     exercise the REAL query->classify->register wiring end to end (not
#     just the DRYRUN_TASK_STATE shortcut used above), with a fake schtasks
#     standing in for the three real states. ---------------------------------
: > "$CALL_LOG"
OUT_F1_NOTFOUND="$(FAKE_TASK_MODE=notfound WSL_DISTRO_NAME="Ubuntu" run_isolated)"; RC_F1_NOTFOUND=$?
[ "$RC_F1_NOTFOUND" -eq 0 ] && echo "  ok   F1: non-existent task (rc!=0, empty query) no longer aborts the installer" \
  || { echo "  FAIL F1: non-existent-task case exited $RC_F1_NOTFOUND (set -e abort regression?) -- $OUT_F1_NOTFOUND"; fail=1; }
check "F1: non-existent task DOES register (self-heal/fresh-install path works)" "registered (every 1 min" "$OUT_F1_NOTFOUND"
CREATE_CALLS_NOTFOUND="$(grep -c '^schtasks /Create' "$CALL_LOG")"
[ "$CREATE_CALLS_NOTFOUND" = "1" ] && echo "  ok   F1: exactly one /Create call for a non-existent task" \
  || { echo "  FAIL F1: expected exactly 1 /Create call for a non-existent task, got $CREATE_CALLS_NOTFOUND"; fail=1; }

# CYBERSEC GO 39120 M1/HARD CONDITION H-1 (card d97659cb): the success
# MESSAGE text ("registered (every 1 min") is a fixed echo that does not
# depend on the argument actually handed to schtasks -- a regression that
# keeps that message but registers at the OLD 5-minute cadence (MaxFails=15
# would then mean a ~75-minute restart threshold, not ~15) would pass every
# check above. Pin the REAL argument in the REAL /Create call, read back
# from the fake schtasks' own call log.
grep -qF 'SC MINUTE /MO 1' "$CALL_LOG" \
  && echo "  ok   d97659cb H-1: the real /Create call for a fresh install carries '/SC MINUTE /MO 1' (not just the success message)" \
  || { echo "  FAIL d97659cb H-1: real /Create call did not carry /SC MINUTE /MO 1 -- log: $(cat "$CALL_LOG")"; fail=1; }

: > "$CALL_LOG"
OUT_F1_ENABLED="$(FAKE_TASK_MODE=enabled WSL_DISTRO_NAME="Ubuntu" run_isolated)"
check "F1: an existing, enabled task still re-registers (idempotent refresh)" "registered (every 1 min" "$OUT_F1_ENABLED"
[ "$(grep -c '^schtasks /Create' "$CALL_LOG")" = "1" ] && echo "  ok   F1: exactly one /Create call for an enabled task" \
  || { echo "  FAIL F1: enabled-task case did not call /Create exactly once"; fail=1; }

: > "$CALL_LOG"
OUT_F1_DISABLED="$(FAKE_TASK_MODE=disabled WSL_DISTRO_NAME="Ubuntu" run_isolated)"
check "F1: an existing, disabled task still skips /Create (H1 unaffected by the F1 fix)" "skipping /Create" "$OUT_F1_DISABLED"
[ "$(grep -c '^schtasks /Create' "$CALL_LOG")" = "0" ] && echo "  ok   F1: zero /Create calls for a disabled task" \
  || { echo "  FAIL F1: disabled-task case called /Create (should be 0)"; fail=1; }

# CYBERSEC GO 39120 M1/HARD CONDITION H-1, remaining two of the three /MO
# occurrences cybered's Q5 mutant flipped at once (the real /Create call is
# pinned above): the dry-run echo, and the manual-fallback echo printed when
# schtasks /Create itself fails.
mkdir -p "$TMP/run_h1_dryrun"
: > "$CALL_LOG"
OUT_H1_DRYRUN="$(run_dry "$TMP/run_h1_dryrun")"
check "d97659cb H-1: the dry-run echoed command carries the real schtasks argument, not just 'DRY-RUN: would register'" \
  "/SC MINUTE /MO 1" "$OUT_H1_DRYRUN"

: > "$CALL_LOG"
OUT_CREATE_FAIL="$(FAKE_TASK_MODE=notfound FAKE_CREATE_MODE=fail WSL_DISTRO_NAME="Ubuntu" run_isolated)"
check "d97659cb H-1: the manual-fallback message (schtasks /Create failed) also carries /SC MINUTE /MO 1" \
  "/SC MINUTE /MO 1" "$OUT_CREATE_FAIL"
check "d97659cb H-1: the manual-fallback path is actually reached on a /Create failure" \
  "warn: schtasks registration failed" "$OUT_CREATE_FAIL"

# --- N-iso (cybered NO-GO, comment 17806, incident 21:01:13): the real
#     wslpath + mkdir path must ALSO refuse a /mnt/-resolving target when
#     test-mode overrides are active, even though DRY_RUN correctly selected
#     the real branch here (this guards the case where a fake
#     powershell/DRY_RUN-selector defect, not this test, is the thing that is
#     broken). ------------------------------------------------------------
: > "$CALL_LOG"
OUT_NISO="$(FAKE_TASK_MODE=notfound FAKE_WSLPATH_OUT="/mnt/n-iso-escape-probe" \
  WSL_DISTRO_NAME="Ubuntu" run_isolated)"; RC_NISO=$?
[ "$RC_NISO" -ne 0 ] && echo "  ok   N-iso: real wslpath resolving under /mnt/ is refused (exit $RC_NISO)" \
  || { echo "  FAIL N-iso: a /mnt/-resolving wslpath output was NOT refused"; fail=1; }
check "N-iso: refusal names the test-mode override and the real path" "test-mode binary override" "$OUT_NISO"
[ ! -e "/mnt/n-iso-escape-probe" ] && echo "  ok   N-iso: escape probe directory was never created under real /mnt" \
  || { echo "  FAIL N-iso: /mnt/n-iso-escape-probe exists -- the real-path escape was not caught"; fail=1; }
# powershell/wslpath ARE expected to be called here (hermetically, via the
# fakes) to reach the point where the /mnt/ resolution is discovered; the
# guarantee this case is actually proving is that schtasks is NEVER reached.
[ "$(grep -c '^schtasks ' "$CALL_LOG")" = "0" ] && echo "  ok   N-iso: refusal happens before any schtasks call" \
  || { echo "  FAIL N-iso: a schtasks call happened before the /mnt/ refusal"; fail=1; }

# --- X1-X5 (cybered NO-GO, comment 17806, scope: not blocking but pinned so
#     a future change notices): the PS1's OTHER decision comparators, beyond
#     the grace window (B1) already pinned above. ---------------------------
if [ -f "$PS1_PATH" ]; then
  PS1_CODE_X="$(strip_ps1_comments < "$PS1_PATH")"
  check_line "X1: restart threshold uses -ge (not -gt)" 'if ($fails -ge $MaxFails) {' "$PS1_CODE_X"
  check_line "X2: restart-attempt bound uses -le (not -lt)" '  if ($restarts -le $MaxRestarts) {' "$PS1_CODE_X"
  check_line "X3: healthy requires BOTH exit-0 AND OK-match (-and, not -or)" "\$healthy = (\$probeExit -eq 0) -and (\$out -cmatch '^OK')" "$PS1_CODE_X"
  check_absent "OK-match fail-open: case-insensitive unanchored -match is gone from code" '-match "OK"' "$PS1_CODE_X"
  check_absent "OK-match fail-open: raw text never reintroduces the loose match either" '-match "OK"' "$PS1_CONTENT"
  check_line "X4: the wedged distro is actually terminated before relaunch" '    & wsl.exe --terminate $Distro 2>$null' "$PS1_CODE_X"
  check_line "X5: a healthy read resets the restart-count state" '  Set-Content -Path $RestartCountFile -Value "0"' "$PS1_CODE_X"
fi

# --- card 3f6bb903: wsl-watchdog-holder-ensure.sh itself (the script the
#     CYBERED NO-GO fix moved the decision into).
#
# CYBERED NO-GO round 3 (comment 39005, F-1/F-2): the previous version of
# this block spawned a REAL production-shaped "/bin/sleep infinity" into
# the LIVE distro's /proc to test the one/two-holder cases, and relied on
# the live baseline (whatever real holder already existed) for the
# zero-holder case -- which on this host always has a real holder, so the
# zero-holder/MISSING branch (the one that actually makes the watchdog act)
# was NEVER exercised, and mutants H1/H6/H8 on that branch stayed green.
# It also risked leaking the decoy on a SIGKILL mid-test (measured by
# CYBERED). Both are fixed by driving the script entirely through
# WSL_WATCHDOG_HOLDER_PROC_ROOT against a throwaway fixture directory tree
# of synthetic "<n>/cmdline" files -- no real process is ever touched.
HOLDER_SCRIPT="$(dirname "$0")/wsl-watchdog-holder-ensure.sh"
HOLDER_FIXTURE_ROOT="$TMP/holder-proc-fixture"

make_holder_cmdline() { # <file> <argv...>
  local file="$1"; shift
  printf '%s\0' "$@" > "$file"
}

reset_holder_fixture() {
  rm -rf "$HOLDER_FIXTURE_ROOT"
  mkdir -p "$HOLDER_FIXTURE_ROOT"
}

run_holder_fixture() { # sets HOLDER_OUT / HOLDER_RC
  HOLDER_OUT="$(WSL_WATCHDOG_HOLDER_PROC_ROOT="$HOLDER_FIXTURE_ROOT" bash "$HOLDER_SCRIPT")"
  HOLDER_RC=$?
}

assert_holder() { # <want_rc> <want_marker_exact_line> <description>
  local want_rc="$1" want_marker="$2" desc="$3"
  if [ "$HOLDER_RC" -eq "$want_rc" ] && printf '%s\n' "$HOLDER_OUT" | grep -qx "$want_marker"; then
    echo "  ok   holder-ensure (fixture): $desc (rc=$HOLDER_RC out='$HOLDER_OUT')"
  else
    echo "  FAIL holder-ensure (fixture): $desc -- want rc=$want_rc line='$want_marker', got rc=$HOLDER_RC out='$HOLDER_OUT'"
    fail=1
  fi
}

if [ -x "$HOLDER_SCRIPT" ]; then
  # Card d97659cb: target holder count raised 1 -> 2 (3f6bb903 follow-up --
  # a single holder left a gap where WSL's own idle-shutdown could tear the
  # distro down in the window between the holder dying and the next tick
  # relaunching it, measured live on 2026-11-26). The marker line now
  # carries `need=<n>` (how many MORE holders the caller should launch),
  # exact-anchored (grep -qx on the whole line) so a mutant that gets the
  # right exit code with a wrong need= cannot pass silently.
  #
  # Zero holders: the decisive branch. Kills H1 (exit 1 -> 0), H8 (missing
  # branch returns 2), H6 (marker renamed HOLDER_GONE).
  reset_holder_fixture
  run_holder_fixture
  assert_holder 1 'HOLDER_MISSING count=0 need=2' "zero holders -> MISSING, need both, exit 1"

  # Exactly one holder -> still missing one, need=1 (not need=2: must not
  # over-launch on top of the one that already exists).
  reset_holder_fixture
  mkdir -p "$HOLDER_FIXTURE_ROOT/1"
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/1/cmdline" sleep infinity
  run_holder_fixture
  assert_holder 1 'HOLDER_MISSING count=1 need=1' "one holder -> MISSING, need one more, exit 1"

  # Exactly two holders -> target met, nothing to launch.
  reset_holder_fixture
  mkdir -p "$HOLDER_FIXTURE_ROOT/1" "$HOLDER_FIXTURE_ROOT/2"
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/1/cmdline" sleep infinity
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/2/cmdline" sleep infinity
  run_holder_fixture
  assert_holder 0 'HOLDER_OK count=2' "two holders -> OK, exit 0"

  # Three or more holders -> ambiguous / too many; never relaunch on top of
  # an already-odd state (same fail-closed rule as the old 1-target design,
  # just re-pointed at the new threshold).
  reset_holder_fixture
  mkdir -p "$HOLDER_FIXTURE_ROOT/1" "$HOLDER_FIXTURE_ROOT/2" "$HOLDER_FIXTURE_ROOT/3"
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/1/cmdline" sleep infinity
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/2/cmdline" sleep infinity
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/3/cmdline" sleep infinity
  run_holder_fixture
  assert_holder 2 'HOLDER_AMBIGUOUS count=3' "three holders -> AMBIGUOUS, no launch, exit 2"

  # Extra-arg shape ("sleep infinity 5", 3 argv elements) must NOT count --
  # kills H2 (argv length check loosened from -eq 2 to -ge 2).
  reset_holder_fixture
  mkdir -p "$HOLDER_FIXTURE_ROOT/1"
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/1/cmdline" sleep infinity 5
  run_holder_fixture
  assert_holder 1 'HOLDER_MISSING count=0 need=2' "3-arg 'sleep infinity 5' is not counted"

  # Non-sleep argv[0] with argv[1]=infinity must NOT count -- kills H3
  # (basename-sleep check dropped).
  reset_holder_fixture
  mkdir -p "$HOLDER_FIXTURE_ROOT/1"
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/1/cmdline" notsleep infinity
  run_holder_fixture
  assert_holder 1 'HOLDER_MISSING count=0 need=2' "non-sleep argv[0] is not counted"

  # sleep with a different second argument must NOT count -- kills H4
  # (argv[1]=="infinity" check dropped).
  reset_holder_fixture
  mkdir -p "$HOLDER_FIXTURE_ROOT/1"
  make_holder_cmdline "$HOLDER_FIXTURE_ROOT/1/cmdline" sleep 5
  run_holder_fixture
  assert_holder 1 'HOLDER_MISSING count=0 need=2' "sleep with a non-infinity second arg is not counted"

  # Lookalike: a file literally named "sleep infinity" (its own bash/path
  # argv, never argv=["sleep","infinity"]) must not be counted either -- run
  # against the real /proc this time (read-only check, no process started
  # by this test), confirming the fixture semantics match live reality.
  LOOKALIKE_PATH="$TMP/sleep infinity"
  printf '#!/bin/bash\nsleep 5\n' > "$LOOKALIKE_PATH"
  chmod +x "$LOOKALIKE_PATH"
  bash "$LOOKALIKE_PATH" &
  LOOKALIKE_PID=$!
  sleep 0.3
  HOLDER_OUT_LIVE_BEFORE="$(bash "$HOLDER_SCRIPT")"
  kill "$LOOKALIKE_PID" 2>/dev/null; wait "$LOOKALIKE_PID" 2>/dev/null
  HOLDER_OUT_LIVE_AFTER="$(bash "$HOLDER_SCRIPT")"
  [ "$HOLDER_OUT_LIVE_BEFORE" = "$HOLDER_OUT_LIVE_AFTER" ] \
    && echo "  ok   holder-ensure F-1 fix: a file literally named 'sleep infinity' on the live distro does not change the verdict (unchanged: '$HOLDER_OUT_LIVE_AFTER')" \
    || { echo "  FAIL holder-ensure F-1 regression: a lookalike-named process on the live distro changed the verdict (with='$HOLDER_OUT_LIVE_BEFORE' without='$HOLDER_OUT_LIVE_AFTER')"; fail=1; }

  # Self-match: invoking via a non-bash shell (dash) as the parent, against
  # the zero-holder fixture, must still read MISSING -- exact argv match
  # (not a pgrep -f substring) is shell-independent by construction.
  if command -v dash >/dev/null 2>&1; then
    reset_holder_fixture
    HOLDER_OUT_DASH="$(dash -c "WSL_WATCHDOG_HOLDER_PROC_ROOT='$HOLDER_FIXTURE_ROOT' bash '$HOLDER_SCRIPT'")"
    case "$HOLDER_OUT_DASH" in
      HOLDER_MISSING*) echo "  ok   holder-ensure F-1 fix: invoking via a dash parent over an empty fixture still reads MISSING (no self-match)" ;;
      *) echo "  FAIL holder-ensure F-1 regression: dash-parent invocation over an empty fixture did not read MISSING (got '$HOLDER_OUT_DASH')"; fail=1 ;;
    esac
  else
    echo "  ok   holder-ensure F-1 (self-match): dash not installed on this host, skipping that specific shell -- exact argv match (not a pgrep -f substring) makes this shell-independent by construction anyway"
  fi

  rm -rf "$HOLDER_FIXTURE_ROOT"
else
  echo "  FAIL wsl-watchdog-holder-ensure.sh not found or not executable at $HOLDER_SCRIPT"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
