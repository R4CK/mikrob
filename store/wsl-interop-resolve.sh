#!/usr/bin/env bash
# wsl-interop-resolve.sh -- find a working /run/WSL/*_interop socket when WSL_INTEROP
# is empty or points at a dead socket (card 73b500f9).
#
# Measured 2026-10-15 07:45, gpu-driver-check's daily run: WSL_INTEROP was empty, and
# every /mnt/c/... .exe call ("cmd.exe", "nvidia-smi.exe") died with "Invalid argument".
# installedHost went null, which would have fired a false "driver broken" alert. The file
# /run/WSL/1_interop (a symlink to 2_interop) and 2_interop (stale from the 04:55 boot)
# both failed the same way, but a THIRD socket, /run/WSL/742_interop, worked and let
# nvidia-smi.exe read installedHost=617.42 correctly. A caller that only checks
# `[ -x "$HOST_SMI" ]` never notices this: the file's executable bit is fine, the interop
# transport underneath the current WSL_INTEROP value is what's broken, and that is a
# property of the SOCKET, not the target binary.
#
# Usage:
#   RESOLVED="$(store/wsl-interop-resolve.sh)"
#   [ -n "$RESOLVED" ] && export WSL_INTEROP="$RESOLVED"
#   # ... then call the .exe as normal
#
# Prints the WSL_INTEROP value to use on stdout: the current value if it still works, or
# the first /run/WSL/*_interop candidate that answers a cheap `cmd.exe /c ver` probe.
# Prints nothing (exit 0) if nothing works -- callers keep their existing fail-closed
# behaviour (leave WSL_INTEROP as-is, let the real .exe call fail/return empty, same as
# before this script existed).
#
# Overridable for the selftest (no real GPU/WSL host, no root to write /run/WSL):
#   WSL_INTEROP_RESOLVE_CMD_EXE      -- the probe binary (default: real cmd.exe)
#   WSL_INTEROP_RESOLVE_RUN_WSL_DIR  -- candidate socket directory (default: /run/WSL)
#   WSL_INTEROP_RESOLVE_TIMEOUT      -- per-candidate timeout seconds (default: 3)
set -uo pipefail

CMD_EXE="${WSL_INTEROP_RESOLVE_CMD_EXE:-/mnt/c/Windows/System32/cmd.exe}"
RUN_WSL_DIR="${WSL_INTEROP_RESOLVE_RUN_WSL_DIR:-/run/WSL}"
PROBE_TIMEOUT="${WSL_INTEROP_RESOLVE_TIMEOUT:-3}"

probe() {
  # $1 = candidate WSL_INTEROP value. Cheap, side-effect-free Windows call; exit 0 = usable.
  WSL_INTEROP="$1" timeout "$PROBE_TIMEOUT" "$CMD_EXE" /c ver >/dev/null 2>&1
}

# 1. the current WSL_INTEROP, if set, might already work -- don't thrash it needlessly.
if [ -n "${WSL_INTEROP:-}" ] && probe "$WSL_INTEROP"; then
  printf '%s' "$WSL_INTEROP"
  exit 0
fi

# 2. walk every *_interop socket under $RUN_WSL_DIR, first one that answers wins. Symlinks
# (e.g. 1_interop -> 2_interop) are harmless duplicates here, not a problem: probing one
# twice costs one extra cheap call, never a wrong result.
if [ -d "$RUN_WSL_DIR" ]; then
  for candidate in "$RUN_WSL_DIR"/*_interop; do
    [ -e "$candidate" ] || continue
    if probe "$candidate"; then
      printf '%s' "$candidate"
      exit 0
    fi
  done
fi

# 3. nothing worked -- stay fail-closed, print nothing.
exit 0
