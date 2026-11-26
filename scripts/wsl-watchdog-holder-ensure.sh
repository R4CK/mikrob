#!/bin/bash
# Reports whether exactly one anti-idle-termination keepalive holder process
# ("sleep infinity") is running inside THIS distro. Called by the Windows-side
# watchdog (mikrob-wsl-watchdog.ps1) on every tick.
#
# CYBERED NO-GO (card 3f6bb903, comment 38947, F-1/F-2): the original design
# asked wsl.exe to run `pgrep -f "sleep infinity"` directly through its `--`
# shell hop. That has two unproven, measured-both-ways failure modes:
#   - if the shell wsl.exe invokes stays as the PARENT process (e.g. a
#     non-bash default shell), pgrep matches its OWN command line (which
#     necessarily contains the search text) and reports a holder that does
#     not exist -- the watchdog then never relaunches a dead one.
#   - if wsl.exe loses the quoting around "sleep infinity" on the way in (a
#     documented wsl.exe argument-passing issue), pgrep receives it as TWO
#     arguments and errors "only one pattern can be provided" (rc=2) -- the
#     watchdog's old check treated any nonzero LASTEXITCODE as "no holder"
#     and relaunched on EVERY tick, piling up hidden wsl.exe+sleep processes
#     without bound (~288/day at the 5-min cadence).
# Moving the decision into a NAMED SCRIPT, invoked the same way the existing
# rollback/notify scripts already are (`-e bash -lc <path>`, no inline
# multi-word argument crossing the wsl.exe CLI boundary at all), removes the
# quoting failure mode structurally: there is no multi-word argument left
# for wsl.exe to lose quoting on.
#
# For the self-match and lookalike-process failure modes, this reads
# /proc/<pid>/cmdline directly (NUL-separated argv, not a joined string) and
# requires an EXACT 2-element argv: basename "sleep", second element exactly
# "infinity" -- this is what Start-Process actually launches
# (-ArgumentList @(... "/bin/sleep", "infinity")). Unlike a `pgrep -f`
# substring/regex match (even with the "[s]leep" bracket trick), an exact
# argv-length + argv-value check cannot match a process whose cmdline merely
# CONTAINS the text "sleep infinity" as a substring (e.g. a file or script
# literally named "sleep infinity", or this very script's own invocation,
# whose argv is always ["bash", "<path>"] or similar, never ["sleep",
# "infinity"]) -- measured directly against that exact case below.
#
# Called as: wsl.exe -d <distro> -u <user> -e bash -lc "<this script>"
# Exit codes (PowerShell side acts ONLY on exit 1 + the HOLDER_MISSING
# marker together -- never on "any nonzero", per the F-2 fix):
#   0 = exactly one holder present, nothing to do
#   1 = zero holders present, PowerShell should launch one
#   2 = ambiguous (2+ matches) or an internal error -- NEVER relaunch here,
#       to avoid piling up duplicate holders on top of an already-odd state
#
# CYBERED NO-GO round 3 (comment 39005, F-1/F-2): the decisive "zero
# holders" branch above was never exercised by any test, because the live
# distro always has a real holder (the sandbox's own baseline, pid 719) and
# the selftest's behavioural checks spawned a production-shaped
# "/bin/sleep infinity" into the LIVE /proc to test the other branches,
# which both risked leaking it (CYBERED measured a SIGKILL-leaked decoy)
# and could not safely test the zero-holder case without first killing the
# real holder. PROC_ROOT makes the scan directory overridable so a test can
# point this at a fixture directory tree with 0/1/2/N synthetic
# "<pid>/cmdline" files instead of the live distro's /proc -- no real
# process is ever touched by the test.
set -u

PROC_ROOT="${WSL_WATCHDOG_HOLDER_PROC_ROOT:-/proc}"

COUNT=0
for cmdline_file in "$PROC_ROOT"/[0-9]*/cmdline; do
  [ -r "$cmdline_file" ] || continue
  argv=()
  while IFS= read -r -d '' arg; do
    argv+=("$arg")
  done < "$cmdline_file" 2>/dev/null
  [ "${#argv[@]}" -eq 2 ] || continue
  bin="${argv[0]##*/}"
  [ "$bin" = "sleep" ] || continue
  [ "${argv[1]}" = "infinity" ] || continue
  COUNT=$((COUNT + 1))
done

if [ "$COUNT" -eq 1 ]; then
  echo "HOLDER_OK count=1"
  exit 0
elif [ "$COUNT" -eq 0 ]; then
  echo "HOLDER_MISSING count=0"
  exit 1
else
  echo "HOLDER_AMBIGUOUS count=$COUNT"
  exit 2
fi
