#!/usr/bin/env bash
# gemini-heavy-gate.sh -- the two gates governing the f0b3b674 Gemini "heavy second-opinion"
# path, extracted out of offload-dispatch.sh (card efe4aa40) so a caller OUTSIDE the kanban-leaf
# dispatch sweep (e.g. a direct --task CLI invocation, which has no leaf/project/tags to gate on)
# can reuse the SAME switch and the SAME shared hourly budget, instead of re-deriving them.
#
# Pure extraction, no behavior change: offload-dispatch.sh sources this file instead of defining
# these two functions inline. is_gemini_blocked() is NOT extracted here -- it is inherently
# kanban-leaf-shaped (project/tags/title/desc allowlist + positive-marker check) and has no
# meaningful equivalent for a bare CLI call with no card behind it; see
# upstream-batch-digest-offload.sh for how that gap is covered for this card's one caller.
#
# Requires $HERE to already be set by the sourcing script (both offload-dispatch.sh and
# upstream-batch-digest-offload.sh set it the same way, before sourcing this file).
set -uo pipefail

# HEAVY SECOND-OPINION FLAG (card f0b3b674, MikroB plan-grilling GO-WITH-CHANGES C1). Fail-closed:
# file absence (the shipped default) means OFF. See offload-dispatch.sh's original comment (history
# preserved there via git blame) for the full WhiteHat F1 OFFLOAD_NO_GEMINI rationale.
GEMINI_HEAVY_FLAG="${GEMINI_HEAVY_FLAG:-$HERE/gemini-heavy-second-opinion-enabled}"
gemini_heavy_second_opinion_enabled() {
  [[ "${OFFLOAD_NO_GEMINI:-0}" == "1" ]] && return 1
  [[ -f "$GEMINI_HEAVY_FLAG" ]]
}

# HEAVY BUDGET SUB-RESERVATION (card f0b3b674 C2): shares gemini-agy-call.sh's existing fleet-wide
# hourly window and flock. Reserved sub-cap, not a separate ceiling -- see offload-dispatch.sh's
# original comment for the full rationale (preserved there via git blame).
HEAVY_HOURLY_LOCK="${GEMINI_AGY_HOURLY_LOCK:-$HERE/gemini-agy-call.hourly.lock}"
HEAVY_SEGED_HIVO="${SEGED_HIVO_HELPERS:-$HERE/../scripts/seged-hivo.py}"
reserve_heavy_gemini_slot() {
  local card_id="$1"
  local total_limit="${GEMINI_AGY_HOURLY_LIMIT:-5}"
  local heavy_limit="${GEMINI_AGY_HEAVY_HOURLY_LIMIT:-3}"
  local rc=0
  flock -x -w 30 "$HEAVY_HOURLY_LOCK" python3 -I - "$HEAVY_SEGED_HIVO" "$total_limit" "$heavy_limit" "$card_id" <<'PY' >/dev/null 2>&1 || rc=$?
import datetime, importlib.util, os, sys, time
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
total_limit = int(sys.argv[2])
heavy_limit = int(sys.argv[3])
card_id = sys.argv[4]
window_start = time.time() - 3600
used = 0
heavy_used = 0
for row in sh.calls_of(sh.read_log()):
    if row.get('seged') not in ('agy', 'agy-ghost', 'agy-heavy') or row.get('status') == 'blocked':
        continue
    try:
        ts = datetime.datetime.fromisoformat(str(row.get('ido', ''))).timestamp()
    except ValueError:
        continue
    if ts < window_start:
        continue
    used += 1
    if row.get('seged') == 'agy-heavy':
        heavy_used += 1
if heavy_used >= heavy_limit:
    sys.exit(3)
if used >= total_limit:
    sys.exit(2)
sh.append_log({
    'ido': datetime.datetime.now().isoformat(),
    'hivas_id': os.urandom(8).hex(),
    'seged': 'agy-heavy',
    'hivo': 'offload-dispatch-heavy',
    'kartya': card_id,
    'feladattipus': 'kod',
    'status': 'ok',
})
sys.exit(0)
PY
  [[ "$rc" -eq 0 ]]
}
