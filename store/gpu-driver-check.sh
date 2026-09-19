#!/usr/bin/env bash
# gpu-driver-check.sh -- installed-vs-available NVIDIA driver version tracking (card f268629c,
# GPU-driver figyelo (A), 26c07c33 EPIC). Peti request (Telegram 8736, 2026-09-18) after the
# 09-17 dxgkrnl crash-loop that a manual driver update (616.64) followed.
#
# THE TWO "INSTALLED" NUMBERS CAN LEGITIMATELY DIFFER, AND BOTH ARE REAL. Measured on this host
# (2026-09-19): the WSL-visible nvidia-smi reports whatever driver the HOST is currently running
# (616.92 -- it talks to the host GPU through paravirtualization, so it tracks the host live), but
# the driver PACKAGE physically mounted into the WSL VM's /usr/lib/wsl/lib lags behind until
# `wsl --shutdown` -- and that package's version is NOT exposed by any version flag or file content,
# only by the SUFFIX ON A SYMLINK'S OWN NAME: `libnvidia-gpucomp.so.615.71.08 -> libnvidia-gpucomp.so`.
# This is a real, reproducible artifact of how the WSL kernel driver-package mount works (the
# symlink name is stamped when the package is mounted at WSL start), not a workaround invented here.
# So: installedHost = what nvidia-smi says NOW (host-live). installedWsl = what is actually loaded
# into this VM's library path (package-mount-time, may be stale). A mismatch between them is exactly
# the "needs `wsl --shutdown`" signal the card asks to surface.
#
# WHAT THIS SCRIPT DOES NOT DO: it never queries the NVIDIA upstream "latest available" version --
# that is a web fetch (NVIDIA's AjaxDriverService JSON API), and per the card's gate note ("kulso
# forras olvasasa, quarantine-reader kotelezo") that fetch belongs to the quarantine-reader
# sub-agent, invoked by the daily scheduled-task prompt, never to a script running unattended with
# direct network access. This script only exposes --set-available as the seam where that externally
# fetched number gets recorded, and --compare as the shared, tested place version strings get judged
# against each other -- so the daily prompt and this script can never drift on what "newer" means.
#
# Usage:
#   store/gpu-driver-check.sh                    # detect installedHost/installedWsl, write state, print it
#   store/gpu-driver-check.sh --compare A B       # print gt / lt / eq  (A vs B, dotted numeric)
#   store/gpu-driver-check.sh --set-available V   # patch state.available=V (+ carries lastAlertedAvailable)
#   store/gpu-driver-check.sh --mark-alerted V    # patch state.lastAlertedAvailable=V (after a real Telegram send)
#
# Every path is overridable so the selftest can point at fakes without a real GPU/WSL host:
#   GPU_DRIVER_CHECK_HOST_SMI, GPU_DRIVER_CHECK_WSL_LIB_DIR, GPU_DRIVER_CHECK_STATE
set -uo pipefail

HOST_SMI="${GPU_DRIVER_CHECK_HOST_SMI:-/mnt/c/Windows/System32/nvidia-smi.exe}"
WSL_LIB_DIR="${GPU_DRIVER_CHECK_WSL_LIB_DIR:-/usr/lib/wsl/lib}"
STATE="${GPU_DRIVER_CHECK_STATE:-$(dirname "$0")/gpu-driver-state.json}"

# --- version compare: dotted numeric, different segment counts allowed (616.92 vs 615.71.08) ----
# Fails soft to "eq" on anything unparsable rather than crashing a caller mid-comparison -- an
# unparsable pair means "we cannot tell", and the daily prompt already treats a missing/unknown
# available figure as "nothing to alert on", so eq (no alert-worthy difference) is the safe default.
compare_versions() {
  A_VER="$1" B_VER="$2" python3 -c '
import os, re

def parts(v):
    v = (v or "").strip()
    nums = re.findall(r"\d+", v)
    return [int(n) for n in nums]

a = parts(os.environ.get("A_VER", ""))
b = parts(os.environ.get("B_VER", ""))
if not a or not b:
    print("eq")
else:
    # pad the shorter with zeros so 616.92 vs 616.92.0 compares equal, not "shorter wins"
    n = max(len(a), len(b))
    a += [0] * (n - len(a))
    b += [0] * (n - len(b))
    print("gt" if a > b else ("lt" if a < b else "eq"))
'
}

read_host_version() {
  [ -x "$HOST_SMI" ] || return 0
  local out
  out="$("$HOST_SMI" --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)" || return 0
  out="$(printf '%s' "$out" | tr -d '\r' | sed 's/^ *//;s/ *$//')"
  [ -n "$out" ] && printf '%s' "$out"
}

# The WSL package version lives ONLY in a symlink's own filename (see header). glob, take the
# newest by mtime if more than one somehow exists (there should be exactly one live mount), and
# extract everything after "libnvidia-gpucomp.so.".
read_wsl_version() {
  [ -d "$WSL_LIB_DIR" ] || return 0
  local link
  link="$(ls -t "$WSL_LIB_DIR"/libnvidia-gpucomp.so.* 2>/dev/null | head -1)" || return 0
  [ -n "$link" ] || return 0
  basename "$link" | sed 's/^libnvidia-gpucomp\.so\.//'
}

now_iso() {
  date -u +'%Y-%m-%dT%H:%M:%SZ'
}

prior_field() {
  # $1 = field name. Empty/missing state file -> empty (never a crash, matches gpu-detect.sh
  # fail-soft philosophy -- a first-ever run has no prior state to carry forward).
  [ -f "$STATE" ] || return 0
  FIELD="$1" STATE_PATH_FOR_PY="$STATE" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["STATE_PATH_FOR_PY"]))
except Exception:
    raise SystemExit(0)
v = d.get(os.environ["FIELD"])
if v is not None:
    print(v)
' 2>/dev/null
}

write_state() {
  # $1 installedHost $2 installedWsl $3 available $4 lastAlertedAvailable $5 checkedAt
  INSTALLED_HOST="$1" INSTALLED_WSL="$2" AVAILABLE="$3" LAST_ALERTED="$4" CHECKED_AT="$5" \
    STATE_PATH="$STATE" python3 -c '
import json, os

def none_if_blank(v):
    v = (v or "").strip()
    return v if v else None

out = {
    "installedHost": none_if_blank(os.environ.get("INSTALLED_HOST")),
    "installedWsl": none_if_blank(os.environ.get("INSTALLED_WSL")),
    "available": none_if_blank(os.environ.get("AVAILABLE")),
    "lastAlertedAvailable": none_if_blank(os.environ.get("LAST_ALERTED")),
    "checkedAt": os.environ["CHECKED_AT"],
}
path = os.environ["STATE_PATH"]
parent = os.path.dirname(path)
if parent:
    os.makedirs(parent, exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
print(json.dumps(out, indent=2))
'
}

case "${1:-}" in
  --compare)
    [ $# -eq 3 ] || { echo "usage: $0 --compare <A> <B>" >&2; exit 2; }
    compare_versions "$2" "$3"
    exit 0
    ;;
  --set-available)
    [ $# -eq 2 ] || { echo "usage: $0 --set-available <version>" >&2; exit 2; }
    prev_host="$(prior_field installedHost || true)"
    prev_wsl="$(prior_field installedWsl || true)"
    prev_alerted="$(prior_field lastAlertedAvailable || true)"
    write_state "$prev_host" "$prev_wsl" "$2" "$prev_alerted" "$(now_iso)"
    exit 0
    ;;
  --mark-alerted)
    [ $# -eq 2 ] || { echo "usage: $0 --mark-alerted <version>" >&2; exit 2; }
    prev_host="$(prior_field installedHost || true)"
    prev_wsl="$(prior_field installedWsl || true)"
    prev_available="$(prior_field available || true)"
    write_state "$prev_host" "$prev_wsl" "$prev_available" "$2" "$(now_iso)"
    exit 0
    ;;
  --help|-h)
    sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

HOST_VER="$(read_host_version || true)"
WSL_VER="$(read_wsl_version || true)"
PREV_AVAILABLE="$(STATE_PATH_FOR_PY="$STATE" prior_field available || true)"
PREV_ALERTED="$(STATE_PATH_FOR_PY="$STATE" prior_field lastAlertedAvailable || true)"

write_state "$HOST_VER" "$WSL_VER" "$PREV_AVAILABLE" "$PREV_ALERTED" "$(now_iso)"
