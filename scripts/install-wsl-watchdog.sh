#!/bin/bash
# Install the Windows-side WSL watchdog: the OUTER resilience net.
#
# The three in-WSL systemd guards recover component-level wedges (deaf channel,
# stuck modal, full disk) but they cannot recover a TOTAL WSL/systemd wedge --
# if the whole VM hangs, nothing inside it runs. This installs a Windows
# Scheduled Task that probes MikroB liveness from OUTSIDE the VM and, only after
# a SUSTAINED wedge, restarts the WSL distro (the boot autostart + systemd/linger
# bring MikroB back). High threshold + dual-signal probe so a healthy fleet is
# never nuked over a transient blip.
#
# WSL-only + idempotent. Safe to re-run (install-linux.sh / startup.sh call it).
# Non-WSL hosts and hosts without powershell.exe are a silent no-op.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# WhiteHat2 delta NO-GO H1' (card 58badae1, comment 17781): the disabled/ready
# classification is a pure function, extracted so it can be unit-tested
# directly with synthetic English/Hungarian/empty/error-text samples -- not
# only through the end-to-end DRY_RUN seam, which never exercises this
# parsing at all. Classification source is `schtasks /Query ... /XML`, whose
# <Enabled> tag is NOT localized (unlike the /FO LIST text columns, which
# read "Letiltva"/"Deaktiviert" on a non-English Windows and silently fell
# through to "ready" -- the single most dangerous direction, since that path
# re-enables a disabled task). Fail-closed: anything that is not clearly
# "exists and enabled" or "does not exist" classifies as "unknown", and
# "unknown" is treated exactly like "disabled" by the caller (skip /Create).
classify_task_state() { # $1 = query exit code, stdin = query output (XML or empty)
  local rc="$1" out
  out="$(cat)"
  if [ "$rc" -ne 0 ] && [ -z "$out" ]; then
    echo "not-found"
    return
  fi
  if printf '%s' "$out" | grep -qi '<Enabled>false</Enabled>'; then
    echo "disabled"
    return
  fi
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi '<Enabled>true</Enabled>'; then
    echo "ready"
    return
  fi
  echo "unknown"
}

# CLI-only entry point for the selftest to call classify_task_state() directly
# with synthetic input, with zero side effects and zero real binary calls.
# Usage: INSTALL_WSL_WATCHDOG_CLASSIFY_SELFTEST=1 bash install-wsl-watchdog.sh <rc> <<<"<query output>"
if [ "${INSTALL_WSL_WATCHDOG_CLASSIFY_SELFTEST:-0}" = "1" ]; then
  classify_task_state "${1:-1}"
  exit 0
fi

# --- guard: WSL only ---
if ! grep -qi microsoft /proc/version 2>/dev/null; then
  echo "not WSL -- Windows watchdog not applicable; no-op."
  exit 0
fi
# Card 58badae1 incident (2026-10-12 20:17, MikroB komment 17738): a prior
# selftest for this script faked LOCALAPPDATA but left TASK_NAME and the
# schtasks.exe path as the real, hardcoded production values -- so the "fake"
# run still registered a REAL Windows Scheduled Task under the REAL
# MikroB-WSL-Watchdog name (overwriting a deliberate Disable), and `/mnt/c`
# means even a "fake" LOCALAPPDATA path is still real storage on the C: drive.
# INSTALL_WSL_WATCHDOG_DRY_RUN=1 renders every file (PS1, launcher vbs) and
# prints the registration command it WOULD run, but calls neither
# powershell.exe nor schtasks.exe -- this is the ONLY mode a selftest may use.
#
# WhiteHat2 NO-GO H2 (card 58badae1, comment 17766): the old exact-match
# `[ "$DRY_RUN" = "1" ]` fails OPEN for any other truthy-looking value
# (true/yes/on/TRUE) -- those silently fell through to a REAL install. Any
# value is now normalized to exactly "1" or "0", and an unrecognized value
# aborts instead of guessing which one was meant.
DRY_RUN_RAW="${INSTALL_WSL_WATCHDOG_DRY_RUN:-0}"
case "${DRY_RUN_RAW,,}" in
  1|true|yes|on) DRY_RUN=1 ;;
  0|''|false|no|off) DRY_RUN=0 ;;
  *)
    echo "INSTALL_WSL_WATCHDOG_DRY_RUN='$DRY_RUN_RAW' is not a recognized boolean (1/true/yes/on or 0/false/no/off) -- refusing to guess; abort." >&2
    exit 1
    ;;
esac

# cybered test-isolation incident (card 58badae1, comment 17782, 20:47:38): a
# mutation of the DRY_RUN selector logic itself fell through to this REAL
# branch during a test run and called the real powershell.exe/schtasks.exe.
# These three paths are now independently overridable so a test harness can
# force them to local fake binaries as a SECOND, independent line of defense
# that does not depend on DRY_RUN's own selector being correct -- a selftest
# should set all three regardless of which DRY_RUN value it is exercising.
WSLEXE="${INSTALL_WSL_WATCHDOG_WSLEXE_BIN:-/mnt/c/Windows/System32/wsl.exe}"
WSL_USER="$(id -un)"

if [ "$DRY_RUN" = "1" ]; then
  PS="(dry-run: powershell.exe not invoked)"
else
  PS="${INSTALL_WSL_WATCHDOG_POWERSHELL_BIN:-}"
  [ -z "$PS" ] && PS="$(command -v powershell.exe || true)"
  [ -z "$PS" ] && PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  if [ ! -x "$PS" ]; then
    echo "powershell.exe not reachable -- cannot install Windows watchdog; no-op."
    exit 0
  fi
fi

# --- guard: WSL only --- (checked after the dry-run PS resolve above so a
# dry-run on a non-WSL CI box still exercises the render path; the guard
# below still applies to a REAL install)
if [ "$DRY_RUN" != "1" ] && ! grep -qi microsoft /proc/version 2>/dev/null; then
  echo "not WSL -- Windows watchdog not applicable; no-op."
  exit 0
fi

# --- resolve the distro name (this VM) ---
DISTRO="${WSL_DISTRO_NAME:-}"
if [ -z "$DISTRO" ] && [ "$DRY_RUN" != "1" ]; then
  # Parse `wsl.exe -l -v`: prefer the default (*) row, else the first Running row.
  DISTRO="$("$WSLEXE" -l -v 2>/dev/null | tr -d '\0\r' | awk '/\*/{print $2; found=1} END{if(!found) print ""}')"
fi
[ -z "$DISTRO" ] && DISTRO="Ubuntu"

# --- Windows target dir (LOCALAPPDATA\MikroB), both Windows + WSL views ---
if [ "$DRY_RUN" = "1" ]; then
  # Entirely bypasses powershell.exe AND wslpath -- a dry-run must never
  # resolve to a real path under /mnt/c, real or "fake"-looking.
  WIN_LOCALAPPDATA="${INSTALL_WSL_WATCHDOG_DRYRUN_WIN_LOCALAPPDATA:-C:\\DRYRUN-NOT-REAL}"
  WSL_DIR="${INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR:?dry-run requires INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR (a scratch dir, never under /mnt/c)}/MikroB"
  # WhiteHat2 NO-GO H2: the comment above said "never under /mnt/c" but nothing
  # enforced it -- a value under /mnt/ is real Windows-backed storage even
  # with a "fake"-looking name (the exact incident this card exists to fix).
  # cybered N9 (comment 17782): a textual-only check is beaten by a path like
  # "/tmp/../mnt/x" (never literally starts with "/mnt/"); normalize with
  # `realpath -m` (no filesystem access required, pure lexical resolution)
  # before comparing.
  WSL_DIR_REAL="$(realpath -m "$WSL_DIR")"
  case "$WSL_DIR_REAL" in
    /mnt/*)
      echo "INSTALL_WSL_WATCHDOG_DRYRUN_WSL_DIR resolves under /mnt/ ($WSL_DIR_REAL) -- refusing: dry-run must never touch real Windows-backed storage; abort." >&2
      exit 1
      ;;
  esac
else
  WIN_LOCALAPPDATA="$("$PS" -NoProfile -Command '$env:LOCALAPPDATA' 2>/dev/null | tr -d '\r')"
  [ -z "$WIN_LOCALAPPDATA" ] && { echo "could not resolve LOCALAPPDATA; abort"; exit 1; }
  WSL_DIR="$(wslpath -u "$WIN_LOCALAPPDATA")/MikroB"
fi
WIN_DIR="${WIN_LOCALAPPDATA}\\MikroB"
mkdir -p "$WSL_DIR"

WATCHDOG_WIN="${WIN_DIR}\\mikrob-wsl-watchdog.ps1"
WATCHDOG_WSL="${WSL_DIR}/mikrob-wsl-watchdog.ps1"
# Card 58badae1 incident: TASK_NAME is deliberately NOT overridable by a plain
# env var with no other guard -- a dry-run never reaches the registration
# call at all (see section 2 below), so there is no name to isolate; a REAL
# install must always use the real production name.
TASK_NAME="MikroB-WSL-Watchdog"
SCHTASKS="${INSTALL_WSL_WATCHDOG_SCHTASKS_BIN:-/mnt/c/Windows/System32/schtasks.exe}"

# Fresh-boot grace (card 58badae1 original requirement + F1 follow-up): skip
# UNHEALTHY counting for the first N seconds of WSL distro uptime, default 25
# minutes, configurable, behavior beyond the window unchanged.
FRESH_BOOT_GRACE_SEC="${WSL_WATCHDOG_FRESH_BOOT_GRACE_SEC:-1500}"

# ----------------------------------------------------------------------------
# 1) The watchdog PS1. Probes liveness via the in-WSL probe script; on a
#    sustained wedge (MAX_FAILS consecutive) restarts the distro.
# ----------------------------------------------------------------------------
cat > "$WATCHDOG_WSL" <<PS1EOF
# MikroB WSL watchdog -- outer net for a TOTAL WSL/VM wedge. Auto-generated by
# scripts/install-wsl-watchdog.sh; edit the generator, not this copy.
\$Distro      = "$DISTRO"
\$WslUser     = "$WSL_USER"
\$Probe       = "$INSTALL_DIR/scripts/wsl-liveness-probe.sh"
\$RollbackCmd = "$INSTALL_DIR/scripts/wsl-watchdog-rollback-notify.sh"
\$MaxFails    = 3   # consecutive fails (~15 min @ 5-min cadence) before a restart
# Peti 2026-08-05: "if you can't start on the first try, try 2 more times, then
# restore yourself to the last working backup -- I shouldn't have to start WSL
# myself." MaxRestarts bounds how many times this watchdog will blindly
# terminate+relaunch the distro before giving up and rolling the repo back
# instead of retrying forever (the prior behavior: unbounded restarts every
# ~15min for hours during the 2026-08-05 ollama/dxg VM crash-loop incident).
\$MaxRestarts = 3
# Card 58badae1 (fresh-boot grace): a just-booted distro legitimately needs a
# few minutes before the dashboard/channels come up. Without this, every boot
# read 3x UNHEALTHY and triggered an unnecessary restart cycle. Skipped reads
# during the window are logged but never advance \$fails.
\$FreshBootGraceSec = $FRESH_BOOT_GRACE_SEC
# N2 (cybered 17782, MikroB 17774): the grace window must be upper-bounded --
# the PID1-age clock (M1) resets to near-zero on every watchdog-issued
# restart, so a genuine boot-loop (the distro dying and restarting faster
# than the grace window) would otherwise skip forever and never reach
# MaxFails. After MaxFreshSkips consecutive skips (~50 min @ 5-min cadence),
# this read counts toward \$fails like any other, instead of being skipped.
\$MaxFreshSkips = 10
\$StateDir    = "\$env:LOCALAPPDATA\\MikroB"
\$StateFile   = "\$StateDir\\wsl-watchdog-fails.txt"
\$RestartCountFile = "\$StateDir\\wsl-watchdog-restart-count.txt"
\$FreshSkipCountFile = "\$StateDir\\wsl-watchdog-freshskip-count.txt"
\$LogFile     = "\$StateDir\\wsl-watchdog.log"
New-Item -ItemType Directory -Force -Path \$StateDir | Out-Null
function Log(\$m){ "\$(Get-Date -Format o) \$m" | Out-File -Append -Encoding utf8 \$LogFile }

# Probe INSIDE wsl. If the VM/systemd is wedged, wsl.exe can't run it and
# \$LASTEXITCODE != 0 -> that IS the total-wedge signal.
\$out = & wsl.exe -d \$Distro -u \$WslUser -- \$Probe 2>\$null
\$probeExit = \$LASTEXITCODE
\$healthy = (\$probeExit -eq 0) -and (\$out -match "OK")

if (\$healthy) {
  Set-Content -Path \$StateFile -Value "0"
  Set-Content -Path \$RestartCountFile -Value "0"
  Set-Content -Path \$FreshSkipCountFile -Value "0"
  exit 0
}

# Fresh-boot grace: read the DISTRO's PID 1 age INSIDE wsl (a separate call --
# the liveness probe's own exit code/output must stay UNHEALTHY-or-OK only,
# this is a second, independent signal). WhiteHat2 NO-GO M1 (card 58badae1,
# comment 17766): /proc/uptime is the WSL2 VM's lifetime, not the distro's --
# measured live, /proc/uptime read 10887s (3h) while the distro's own PID 1
# was only 1703s old, because vmIdleTimeout=-1 keeps the VM up across this
# watchdog's own terminate+relaunch. Using VM uptime meant the grace window
# never covered the one case it exists for: a distro this watchdog itself
# just restarted. 'ps -o etimes= -p 1' is the distro instance's own clock. A
# failed read (wedged VM) falls through as "not fresh" so a genuine total
# wedge is never masked by the grace window.
\$uptimeOut = & wsl.exe -d \$Distro -u \$WslUser -- ps -o etimes= -p 1 2>\$null
\$uptimeSec = 0
# cybered N10 (comment 17782): an unanchored match takes the first digit
# sequence ANYWHERE in the output, including inside an unrelated warning
# string on a 0-exit run -- anchor to "the whole trimmed line is a number".
if (\$LASTEXITCODE -eq 0 -and \$uptimeOut -match '^\s*([0-9]+)\s*$') { \$uptimeSec = [double]\$matches[1] }
if (\$uptimeSec -gt 0 -and \$uptimeSec -lt \$FreshBootGraceSec) {
  \$freshSkips = 0
  if (Test-Path \$FreshSkipCountFile) { \$freshSkips = [int](Get-Content \$FreshSkipCountFile -ErrorAction SilentlyContinue) }
  \$freshSkips++
  if (\$freshSkips -lt \$MaxFreshSkips) {
    Set-Content -Path \$FreshSkipCountFile -Value "\$freshSkips"
    Log "probe unhealthy (out='\$out' exit=\$probeExit) -- SKIPPED, fresh boot (uptime=\${uptimeSec}s < grace=\${FreshBootGraceSec}s, skip \$freshSkips/\$MaxFreshSkips)"
    exit 0
  }
  Log "probe unhealthy (out='\$out' exit=\$probeExit) -- fresh-boot grace EXCEEDED MaxFreshSkips (\$MaxFreshSkips): treating as a boot-loop, counting toward failure threshold"
  Set-Content -Path \$FreshSkipCountFile -Value "0"
}

\$fails = 0
if (Test-Path \$StateFile) { \$fails = [int](Get-Content \$StateFile -ErrorAction SilentlyContinue) }
\$fails++
Set-Content -Path \$StateFile -Value "\$fails"
Log "probe unhealthy (out='\$out' exit=\$probeExit) -- consecutive fails=\$fails/\$MaxFails"

if (\$fails -ge \$MaxFails) {
  \$restarts = 0
  if (Test-Path \$RestartCountFile) { \$restarts = [int](Get-Content \$RestartCountFile -ErrorAction SilentlyContinue) }
  \$restarts++

  if (\$restarts -le \$MaxRestarts) {
    Log "RESTARTING WSL distro \$Distro (sustained wedge, attempt \$restarts/\$MaxRestarts)"
    & wsl.exe --terminate \$Distro 2>\$null
    Start-Sleep -Seconds 5
    # Card 58badae1 F1 (root cause): relaunching via a wsl.exe call that runs
    # an immediately-exiting command used to be the restart step, but that
    # command exits right away, and with it the ONLY wsl.exe client holding
    # the VM open -- the distro powers off again ~30s later
    # (measured: 20+ times in one night). Start-Process spawns wsl.exe as an
    # INDEPENDENT Windows process, detached from this watchdog run (which
    # itself exits after this script returns), running 'sleep infinity'
    # inside the distro -- the same holding-client pattern as the
    # Startup-folder MikroB-WSL-Keepalive.vbs launcher, just issued here too
    # so the distro survives even if that separate launcher is not running.
    Start-Process -WindowStyle Hidden -FilePath "wsl.exe" -ArgumentList @("-d", \$Distro, "--exec", "/bin/sleep", "infinity")
    Set-Content -Path \$RestartCountFile -Value "\$restarts"
    Set-Content -Path \$StateFile -Value "0"
    Log "WSL restart issued (holding process launched via Start-Process)"
  } else {
    Log "GIVING UP after \$MaxRestarts restart attempts -- triggering in-WSL auto-rollback"
    & wsl.exe -d \$Distro -u \$WslUser -e bash -lc \$RollbackCmd 2>\$null
    Set-Content -Path \$RestartCountFile -Value "0"
    Set-Content -Path \$StateFile -Value "0"
    Log "auto-rollback command issued"
  }
}
exit 0
PS1EOF

echo "Rendered Windows watchdog for distro=$DISTRO user=$WSL_USER -> $WIN_DIR"

# ----------------------------------------------------------------------------
# 1b) Hidden VBS launcher: wscript (windowless GUI host) -> powershell hidden.
#     WITHOUT this the 5-min task pops a console window EVERY run: the task runs
#     in the interactive session, and `powershell -WindowStyle Hidden` only
#     hides the powershell host AFTER it (and each inner `& wsl.exe`) has already
#     flashed a console. wscript.exe is a GUI-subsystem host, and
#     WScript.Shell.Run(cmd, 0, False) launches powershell fully hidden (window
#     style 0), so no window ever appears -- the exact proven pattern already
#     used by the Startup-folder MikroB-WSL-Autostart.vbs launcher.
# ----------------------------------------------------------------------------
LAUNCHER_WIN="${WIN_DIR}\\mikrob-wsl-watchdog-launcher.vbs"
LAUNCHER_WSL="${WSL_DIR}/mikrob-wsl-watchdog-launcher.vbs"
cat > "$LAUNCHER_WSL" <<VBSEOF
Set s = CreateObject("WScript.Shell")
s.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${WATCHDOG_WIN}""", 0, False
VBSEOF
echo "Rendered hidden VBS launcher -> $LAUNCHER_WIN"

# ----------------------------------------------------------------------------
# 2) Register the Scheduled Task via schtasks.exe. Runs every 5 min as the
#    interactive user (matches the working MikroB Autostart pattern, reliable
#    per-user wsl.exe control). Notes: (a) schtasks is used instead of
#    PowerShell's Register-ScheduledTask because the latter's
#    RepetitionDuration=MaxValue emits out-of-range TaskXML that Task Scheduler
#    rejects; (b) NO /RL HIGHEST -- elevation would need an admin shell (Access
#    Denied otherwise) and the watchdog only needs to call wsl.exe, not admin
#    rights; (c) /TR runs wscript on the hidden VBS launcher (1b) so no console
#    window pops; the launcher path lives under AppData\Local\MikroB (no spaces)
#    so /TR needs no inner quotes. /F overwrites, so re-running is idempotent.
# ----------------------------------------------------------------------------
TR="wscript.exe //B //Nologo ${LAUNCHER_WIN}"

# WhiteHat2 NO-GO H1 (card 58badae1, comment 17766): /Create /F unconditionally
# OVERWRITES an existing task, and /F turns a deliberately Disabled task back
# to Ready -- exactly what undid MikroB's manual Disable at 20:11. Query the
# task's current state first via the locale-independent XML form (H1', comment
# 17781) and classify_task_state(); if it already exists and is Disabled, OR
# the state cannot be determined (unknown -- a failed/ambiguous query), render
# the files (so a later, explicit re-enable has fresh content) but SKIP the
# /Create call so neither a Disabled state nor an inconclusive read is ever
# acted on by this script. INSTALL_WSL_WATCHDOG_DRYRUN_TASK_STATE lets a
# selftest simulate the end-to-end state without ever invoking schtasks.exe.
if [ "$DRY_RUN" = "1" ]; then
  TASK_STATE="${INSTALL_WSL_WATCHDOG_DRYRUN_TASK_STATE:-not-found}"
else
  TASK_QUERY_OUT="$("$SCHTASKS" /Query /TN "$TASK_NAME" /XML 2>/dev/null)"; QUERY_RC=$?
  TASK_STATE="$(printf '%s' "$TASK_QUERY_OUT" | classify_task_state "$QUERY_RC")"
fi

# B2 (MikroB 17774 + cybered 17782): a persistent, version-controlled disable
# flag is the PRIMARY protection -- it does not depend on schtasks.exe, a
# Windows locale, or the query succeeding at all, and startup.sh checks the
# same file before even invoking this installer. The flag always wins over
# whatever the query found.
DISABLE_FLAG="${INSTALL_WSL_WATCHDOG_DISABLE_FLAG:-$INSTALL_DIR/store/.wsl-watchdog-disabled}"
if [ -f "$DISABLE_FLAG" ]; then
  TASK_STATE="disabled"
fi

if [ "$TASK_STATE" = "disabled" ] || [ "$TASK_STATE" = "unknown" ]; then
  echo "Scheduled Task '$TASK_NAME' state is '$TASK_STATE' -- skipping /Create (card 58badae1 H1/H1'/B2: never re-enable a disabled task, and never guess on an inconclusive read). Files rendered; registration state left untouched. Re-enable manually once ready."
elif [ "$DRY_RUN" = "1" ]; then
  # Card 58badae1 incident: schtasks.exe is NEVER invoked in dry-run, not even
  # a stubbed one on PATH -- the real binary is called by its hardcoded
  # absolute path below, so faking PATH alone cannot intercept it.
  echo "DRY-RUN: would register Scheduled Task '$TASK_NAME': schtasks /Create /TN \"$TASK_NAME\" /TR \"$TR\" /SC MINUTE /MO 5 /F"
elif "$SCHTASKS" /Create /TN "$TASK_NAME" /TR "$TR" /SC MINUTE /MO 5 /F >/dev/null 2>&1; then
  echo "Scheduled Task '$TASK_NAME' registered (every 5 min, as $WSL_USER)."
else
  echo "warn: schtasks registration failed. Register manually in a cmd/PowerShell:"
  echo "  schtasks /Create /TN \"$TASK_NAME\" /TR \"$TR\" /SC MINUTE /MO 5 /F"
fi
