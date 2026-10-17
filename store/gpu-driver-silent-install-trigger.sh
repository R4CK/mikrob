#!/usr/bin/env bash
# gpu-driver-silent-install-trigger.sh -- the WSL-side gate+trigger for the GPU-driver silent
# install (card 8b588834, GPU-driver figyelo (C)). This is the ONLY thing the WSL side is allowed
# to do: decide whether every precondition holds, and if so, fire the pre-registered Windows
# scheduled task BY NAME, passing it NO arguments. The actual version-query, download, Authenticode
# verification, checkpoint and silent install run entirely inside the Windows-side admin script
# (gpu-driver-install.ps1, store/gpu-driver-install.ps1 in this repo, copied by Peti by hand into
# C:\ProgramData\MikroB -- an Administrator-only location, see comment 8258 on this card) -- never
# here. Plan-grilling verdict (komment 15819) point 1: "A szkript es minden bemenete a
# Windows-oldalon, csak Administrator altal irhato helyen; a WSL oldal SEMMILYEN parametert nem ad
# at, csak inditja a taskot." This script enforces exactly that boundary: no parameter ever reaches
# `schtasks /run` beyond the task name.
#
# Every precondition is FAIL-CLOSED -- unlike store/agent-cap-check.sh's deliberate fail-open (that
# one guards against an overload, this one guards against an irreversible host-level install plus
# a full-fleet `wsl --shutdown`). Any missing token, unreachable dashboard, malformed state, or
# absent precondition means NO-OP, never "proceed anyway".
#
# Preconditions, all required (MIKROB DONTES, kartya-komment 21106 + plan-grilling 15819):
#   1. GPU_DRIVER_SILENT_INSTALL=on (default off -- the flag itself, not this script, is the
#      kill-switch Peti flips; this script never changes it).
#   2. A level-2 approval exists: category=$APPROVAL_CATEGORY, status=approved, resolved within
#      $APPROVAL_WINDOW_S seconds, AND not already consumed by an earlier run of this script (local
#      replay-guard state -- the generic /api/approvals table has no HTTP-exposed one-shot-consume
#      for arbitrary categories, see this card's REVIEW for why a local once-per-approval-id guard
#      is proportionate here: a single admin, a rare manual-approved event, not a race-prone
#      multi-caller path).
#   3. The board is idle: GET /api/kanban?status=in_progress returns an empty list (flotta
#      "parkolt" per the plan's point 3 -- the operation runs `wsl --shutdown` which kills every
#      running agent panel, so nothing may be mid-card when it fires).
#   4. state.available is a validated, strictly newer dotted-numeric version than
#      state.installedHost (gpu-driver-check.sh --compare) -- nothing to install otherwise.
# Only once ALL FOUR hold does this script run `schtasks /run /TN <task>` with no other arguments.
#
# Usage: gpu-driver-silent-install-trigger.sh
# Exit 0 = no-op (flag off, no approval, board busy, nothing newer) OR the task was triggered.
# Exit 1 = a precondition that SHOULD have been satisfiable failed unexpectedly (dashboard
#          unreachable, malformed state/response) -- fail-closed, logged, no schtasks call.
# Exit 2 = schtasks itself reported a non-zero exit when invoked.
#
# Every external dependency is overridable so the selftest never touches a real dashboard, a real
# Windows host, or the real on-disk state:
#   GPU_DRIVER_SILENT_INSTALL, GPU_DRIVER_INSTALL_TASK_NAME, GPU_DRIVER_INSTALL_SCHTASKS_BIN,
#   GPU_DRIVER_INSTALL_API, GPU_DRIVER_INSTALL_TOKEN_FILE, GPU_DRIVER_INSTALL_CURL_BIN,
#   GPU_DRIVER_INSTALL_APPROVAL_CATEGORY, GPU_DRIVER_INSTALL_APPROVAL_WINDOW_S,
#   GPU_DRIVER_INSTALL_STATE, GPU_DRIVER_INSTALL_CHECK_BIN, GPU_DRIVER_INSTALL_DRIVER_STATE,
#   GPU_DRIVER_INSTALL_WSL_INTEROP_RESOLVE
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FLAG="${GPU_DRIVER_SILENT_INSTALL:-off}"
TASK_NAME="${GPU_DRIVER_INSTALL_TASK_NAME:-MikroB-GPU-Driver-Install}"
SCHTASKS_BIN="${GPU_DRIVER_INSTALL_SCHTASKS_BIN:-/mnt/c/Windows/System32/schtasks.exe}"
# Card 73b500f9's own lesson (gpu-driver-check.sh header): WSL_INTEROP can be empty or point at a
# dead socket while a live one still works elsewhere under /run/WSL/ -- resolved lazily, right
# before the one .exe call this script makes, same as gpu-driver-check.sh's read_host_version().
WSL_INTEROP_RESOLVE_SH="${GPU_DRIVER_INSTALL_WSL_INTEROP_RESOLVE:-$HERE/wsl-interop-resolve.sh}"
API="${GPU_DRIVER_INSTALL_API:-http://localhost:3420}"
TOKEN_FILE="${GPU_DRIVER_INSTALL_TOKEN_FILE:-$HERE/.dashboard-token}"
CURL_BIN="${GPU_DRIVER_INSTALL_CURL_BIN:-curl}"
APPROVAL_CATEGORY="${GPU_DRIVER_INSTALL_APPROVAL_CATEGORY:-gpu-driver-silent-install}"
APPROVAL_WINDOW_S="${GPU_DRIVER_INSTALL_APPROVAL_WINDOW_S:-3600}"
STATE="${GPU_DRIVER_INSTALL_STATE:-$HERE/gpu-driver-silent-install-trigger-state.json}"
CHECK_BIN="${GPU_DRIVER_INSTALL_CHECK_BIN:-$HERE/gpu-driver-check.sh}"
DRIVER_STATE="${GPU_DRIVER_INSTALL_DRIVER_STATE:-$HERE/gpu-driver-state.json}"

log() { printf '[gpu-driver-silent-install-trigger %s] %s\n' "$(date -u +'%H:%M:%S')" "$1"; }

# --- precondition 1: the flag itself ---------------------------------------------------------
case "$FLAG" in
  on|true|1) ;;
  *) log "GPU_DRIVER_SILENT_INSTALL is off -- no-op"; exit 0 ;;
esac

if [ ! -r "$TOKEN_FILE" ]; then
  log "FAIL-CLOSED: no dashboard token at $TOKEN_FILE -- cannot verify approval/board-idle, refusing"
  exit 1
fi

hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$hdr_file"

http_get() { # $1 = path (with query string)
  "$CURL_BIN" -s --max-time 10 -H @"$hdr_file" "$API$1"
}

# --- precondition 2: a fresh, approved, not-yet-used approval --------------------------------
APPROVALS_JSON="$(http_get "/api/approvals?category=${APPROVAL_CATEGORY}&status=approved&limit=5")"
if [ -z "$APPROVALS_JSON" ]; then
  log "FAIL-CLOSED: /api/approvals unreachable or empty response -- refusing"
  exit 1
fi

PREV_USED_ID="$(python3 -c "
import json
try:
    d = json.load(open('$STATE'))
except Exception:
    d = {}
print(d.get('lastTriggeredApprovalId') or '')
" 2>/dev/null)"

APPROVAL_ID="$(PREV_USED_ID="$PREV_USED_ID" WINDOW_S="$APPROVAL_WINDOW_S" python3 -c "
import json, os, sys, time
try:
    items = json.loads(sys.stdin.read())
except Exception:
    print('')
    sys.exit(0)
if not isinstance(items, list):
    print('')
    sys.exit(0)
now = int(time.time())
window = int(os.environ['WINDOW_S'])
prev_used = os.environ.get('PREV_USED_ID') or None
for a in items:
    if not isinstance(a, dict) or a.get('status') != 'approved':
        continue
    resolved_at = a.get('resolved_at')
    if not isinstance(resolved_at, int):
        continue
    if now - resolved_at > window:
        continue
    aid = a.get('id')
    if not aid or aid == prev_used:
        continue
    print(aid)
    sys.exit(0)
print('')
" <<<"$APPROVALS_JSON")"

if [ -z "$APPROVAL_ID" ]; then
  log "no fresh, unused, approved request for category=$APPROVAL_CATEGORY within ${APPROVAL_WINDOW_S}s -- no-op"
  exit 0
fi

# --- precondition 3: board idle (the install ends with a full fleet wsl --shutdown) ----------
IN_PROGRESS_JSON="$(http_get "/api/kanban?status=in_progress")"
if [ -z "$IN_PROGRESS_JSON" ]; then
  log "FAIL-CLOSED: /api/kanban?status=in_progress unreachable or empty response -- refusing"
  exit 1
fi
IN_PROGRESS_COUNT="$(python3 -c "
import json, sys
try:
    items = json.loads(sys.stdin.read())
except Exception:
    print(-1)
    sys.exit(0)
print(len(items) if isinstance(items, list) else -1)
" <<<"$IN_PROGRESS_JSON")"
if [ "$IN_PROGRESS_COUNT" -lt 0 ]; then
  log "FAIL-CLOSED: /api/kanban?status=in_progress returned an unexpected shape -- refusing"
  exit 1
fi
if [ "$IN_PROGRESS_COUNT" -gt 0 ]; then
  log "board is NOT idle ($IN_PROGRESS_COUNT in_progress card(s)) -- no-op, approval stays unused for a later run"
  exit 0
fi

# --- precondition 4: available is strictly newer than installedHost --------------------------
if [ ! -r "$DRIVER_STATE" ]; then
  log "FAIL-CLOSED: no $DRIVER_STATE -- refusing"
  exit 1
fi
INSTALLED_HOST="$(python3 -c "
import json
try:
    print(json.load(open('$DRIVER_STATE')).get('installedHost') or '')
except Exception:
    print('')
")"
AVAILABLE="$(python3 -c "
import json
try:
    print(json.load(open('$DRIVER_STATE')).get('available') or '')
except Exception:
    print('')
")"
if [ -z "$INSTALLED_HOST" ] || [ -z "$AVAILABLE" ]; then
  log "installedHost or available missing from state -- no-op"
  exit 0
fi
CMP="$("$CHECK_BIN" --compare "$AVAILABLE" "$INSTALLED_HOST")"
if [ "$CMP" != "gt" ]; then
  log "available ($AVAILABLE) is not newer than installedHost ($INSTALLED_HOST) -- no-op"
  exit 0
fi

# --- all four preconditions hold: fire the task, NO parameters passed ------------------------
log "all preconditions hold (approval=$APPROVAL_ID, available=$AVAILABLE > installedHost=$INSTALLED_HOST) -- triggering $TASK_NAME"
if [ -x "$WSL_INTEROP_RESOLVE_SH" ]; then
  _resolved_interop="$("$WSL_INTEROP_RESOLVE_SH" 2>/dev/null)" || _resolved_interop=""
  [ -n "$_resolved_interop" ] && export WSL_INTEROP="$_resolved_interop"
fi
if ! "$SCHTASKS_BIN" /run /TN "$TASK_NAME"; then
  log "schtasks /run /TN $TASK_NAME FAILED"
  exit 2
fi

python3 -c "
import json, os
out = {'lastTriggeredApprovalId': '$APPROVAL_ID', 'lastTriggeredAt': $(date -u +%s)}
tmp = '$STATE.tmp'
with open(tmp, 'w') as f:
    json.dump(out, f, indent=2)
    f.write('\n')
os.replace(tmp, '$STATE')
"
log "triggered. approval $APPROVAL_ID recorded as used -- will not fire again on this same approval."
exit 0
