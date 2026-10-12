#!/usr/bin/env bash
# install-wsl-watchdog.selftest.sh -- controls for install-wsl-watchdog.sh (card 58badae1).
#
# The generated unit is Windows PowerShell -- this host cannot execute it, so
# the controls assert on the GENERATED TEXT instead, pinning the exact
# regression the card's NO-GO measured: the restart command must never be
# '--exec /bin/true' again, and the fresh-boot grace window must be present.
# Needles use declaration/call-site keywords, not bare substrings (CLAUDE.md
# kódminőségi elv 12) so a comment mentioning the old command can't fake a
# pass.
#
# Faked powershell.exe / schtasks.exe / wsl.exe stubs let this run WITHOUT a
# real WSL/Windows host: install-wsl-watchdog.sh only needs them to resolve
# LOCALAPPDATA, the distro name, and to "register" the task -- none of that
# requires a live distro.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/install-wsl-watchdog.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { case "$3" in *"$2"*) echo "  ok   $1" ;; *) echo "  FAIL $1 -> needle '$2' not in '$3'"; fail=1 ;; esac; }
check_absent() { case "$3" in *"$2"*) echo "  FAIL $1 -> needle '$2' unexpectedly present"; fail=1 ;; *) echo "  ok   $1" ;; esac; }

mkdir -p "$TMP/fakebin" "$TMP/localappdata"
cat > "$TMP/fakebin/powershell.exe" <<'EOF'
#!/usr/bin/env bash
# Only -Command '$env:LOCALAPPDATA' is used by install-wsl-watchdog.sh.
for a in "$@"; do
  case "$a" in
    *LOCALAPPDATA*) echo "$FAKE_LOCALAPPDATA"; exit 0 ;;
  esac
done
exit 0
EOF
cat > "$TMP/fakebin/schtasks.exe" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$TMP/fakebin/wsl.exe" <<'EOF'
#!/usr/bin/env bash
echo "  NAME"
echo "* Ubuntu    Running  2"
EOF
chmod +x "$TMP"/fakebin/*.exe

# install-wsl-watchdog.sh resolves /proc/version for the WSL guard and
# wslpath for the LOCALAPPDATA path -- both are real on this (WSL) host, so
# the selftest only needs to stub powershell.exe/schtasks.exe/wsl.exe on PATH
# and point LOCALAPPDATA at a scratch dir.
export FAKE_LOCALAPPDATA="C:\\fake\\localappdata"
export PATH="$TMP/fakebin:$PATH"
export WSL_DISTRO_NAME="Ubuntu"

OUT="$(cd "$TMP" && PATH="$TMP/fakebin:$PATH" bash "$BIN" 2>&1)"
RC=$?
WSL_DIR="$(wslpath -u "$(cat "$TMP/fakebin/powershell.exe" >/dev/null; echo "C:\\fake\\localappdata")" 2>/dev/null)/MikroB"
PS1_PATH="$WSL_DIR/mikrob-wsl-watchdog.ps1"

echo "install-wsl-watchdog controls"

if [ "$RC" -ne 0 ]; then
  echo "  FAIL install-wsl-watchdog.sh exited $RC (output: $OUT)"
  fail=1
elif [ ! -f "$PS1_PATH" ]; then
  echo "  FAIL rendered PS1 not found at $PS1_PATH (output: $OUT)"
  fail=1
else
  PS1_CONTENT="$(cat "$PS1_PATH")"

  # --- F1 regression pin: the old fail mode must never reappear ------------
  check_absent "F1: '--exec /bin/true' restart command is gone" '--exec /bin/true' "$PS1_CONTENT"

  # --- F1 fix present: a detached holding process relaunches the distro ----
  check "F1: Start-Process used to relaunch (detached from this run)" "Start-Process" "$PS1_CONTENT"
  check "F1: holding process runs 'sleep infinity' inside the distro" "sleep infinity" "$PS1_CONTENT"
  check "F1: relaunch is hidden (no console flash)" "WindowStyle Hidden" "$PS1_CONTENT"

  # --- fresh-boot grace (original requirement + F follow-up) ---------------
  check "fresh-boot grace: variable declared" "\$FreshBootGraceSec" "$PS1_CONTENT"
  check "fresh-boot grace: uptime read inside wsl" "/proc/uptime" "$PS1_CONTENT"
  check "fresh-boot grace: skip marker logged distinctly" "SKIPPED, fresh boot" "$PS1_CONTENT"

  # --- unaffected behavior: MaxFails/MaxRestarts bound still intact --------
  check "MaxFails bound intact" "\$MaxFails    = 3" "$PS1_CONTENT"
  check "MaxRestarts bound intact" "\$MaxRestarts = 3" "$PS1_CONTENT"
fi

# --- configurability: default vs overridden grace window -------------------
rm -rf "$TMP/fakebin2"; mkdir -p "$TMP/run2"
OUT2="$(cd "$TMP" && PATH="$TMP/fakebin:$PATH" WSL_WATCHDOG_FRESH_BOOT_GRACE_SEC=777 bash "$BIN" 2>&1)"
if [ -f "$PS1_PATH" ]; then
  check "fresh-boot grace: custom value honored" '$FreshBootGraceSec = 777' "$(cat "$PS1_PATH")"
else
  echo "  FAIL custom-grace run did not render a PS1 (output: $OUT2)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
