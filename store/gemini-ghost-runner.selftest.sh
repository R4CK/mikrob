#!/usr/bin/env bash
# Self-test for store/gemini-ghost-runner.sh (card 612058c2). Throw-away MARVEEN_ROOT, stub
# pipeline steps (run-gemini-fallback.sh / dist/gemini-orchestrator*.js), but the hourly-count
# logic runs against the REAL scripts/seged-hivo.py (copied, not symlinked -- its ROOT is
# __file__-based, a symlink would resolve back to the real repo and defeat the sandbox, same
# reasoning as gemini-agy-call.selftest.sh).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SELF_DIR/gemini-ghost-runner.sh"
REAL_SEGED_HIVO="$SELF_DIR/../scripts/seged-hivo.py"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
mkdir -p "$TD/store" "$TD/scripts" "$TD/dist"
cp "$REAL_SEGED_HIVO" "$TD/scripts/seged-hivo.py"

n=0
failures=()
case_() {
  local label="$1" cond="$2"
  n=$((n + 1))
  if [ "$cond" != "0" ]; then
    failures+=("$label")
  fi
}

stub() {  # stub <path> <exit-code> -- always prints its own basename first, so the runner's log
          # (which captures each step's stdout) can confirm which steps actually ran.
  local path="$1" rc="$2"
  case "$path" in
    *.js) printf "console.log('STUB-RAN: %s'); process.exit(%s)\n" "$(basename "$path")" "$rc" > "$path" ;;
    *) printf '#!/bin/bash\necho "STUB-RAN: %s"\nexit %s\n' "$(basename "$path")" "$rc" > "$path"; chmod +x "$path" ;;
  esac
}

append_ghost_row() {  # append_ghost_row <ago-seconds> <status>
  local ago="$1" status="$2"
  python3 -I - "$TD/scripts/seged-hivo.py" "$ago" "$status" <<'PY'
import datetime, importlib.util, os, sys, time
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
ts = time.time() - int(sys.argv[2])
sh.append_log({
    'ido': datetime.datetime.fromtimestamp(ts).isoformat(),
    'hivas_id': os.urandom(8).hex(),
    'seged': 'agy',
    'hivo': 'quota-bridge-ghost',
    'kartya': 'n/a (ghost-sweep tick)',
    'feladattipus': 'kod',
    'status': sys.argv[3],
})
PY
}

run_with_fresh_env() {  # run_with_fresh_env -- the SUT, sourced into a fresh subshell each time
  (
    export MARVEEN_ROOT="$TD"
    export SEGED_HIVO_HELPERS="$TD/scripts/seged-hivo.py"
    # shellcheck source=/dev/null
    source "$SUT"
    run_tick
  )
}

# --- case 1: a clean tick runs all four steps and logs exactly one new ghost row, status=ok ----
rm -f "$TD/store/gemini-ghost-runner.log"
: > "$TD/store/seged-hivo-naplo.jsonl"
stub "$TD/store/run-gemini-fallback.sh" 0
stub "$TD/dist/gemini-orchestrator.js" 0
stub "$TD/dist/gemini-orchestrator-draft.js" 0
stub "$TD/dist/gemini-orchestrator-draft-review.js" 0
run_with_fresh_env
rows_after=$(wc -l < "$TD/store/seged-hivo-naplo.jsonl")
case_ "clean tick appends exactly one ghost-tagged log row" \
  "$([ "$rows_after" -eq 1 ] && echo 0 || echo 1)"
case_ "clean tick's row records status=ok" \
  "$(grep -q '"status": "ok"' "$TD/store/seged-hivo-naplo.jsonl" && echo 0 || echo 1)"
case_ "clean tick's log mentions RUN, not SKIP" \
  "$(grep -q 'RUN tick' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"

# --- case 2: a failing pipeline step is recorded as a non-"ok" status, not silently swallowed --
rm -f "$TD/store/gemini-ghost-runner.log"
: > "$TD/store/seged-hivo-naplo.jsonl"
stub "$TD/dist/gemini-orchestrator-draft.js" 1
run_with_fresh_env
case_ "a failing step's status is recorded (not 'ok')" \
  "$(grep -q '"status": "ok"' "$TD/store/seged-hivo-naplo.jsonl" && echo 1 || echo 0)"
case_ "a failing step still runs every later step (draft-review still invoked)" \
  "$(grep -q 'STUB-RAN: gemini-orchestrator-draft-review.js' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"
stub "$TD/dist/gemini-orchestrator-draft.js" 0   # restore for later cases

# --- case 3: hourly cap -- 5 prior ghost rows in the last hour -> the 6th tick is SKIPPED -------
rm -f "$TD/store/gemini-ghost-runner.log"
: > "$TD/store/seged-hivo-naplo.jsonl"
for i in 1 2 3 4 5; do append_ghost_row $((i * 60)) ok; done
rows_before=$(wc -l < "$TD/store/seged-hivo-naplo.jsonl")
run_with_fresh_env
rows_after=$(wc -l < "$TD/store/seged-hivo-naplo.jsonl")
case_ "the 6th tick within the hour is skipped (no new log row)" \
  "$([ "$rows_after" -eq "$rows_before" ] && echo 0 || echo 1)"
case_ "the skip is logged as a cap hit, not silently" \
  "$(grep -q 'hourly ghost cap reached' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"

# --- case 4: a ghost row OLDER than the 1h window does not count toward the cap -----------------
rm -f "$TD/store/gemini-ghost-runner.log"
: > "$TD/store/seged-hivo-naplo.jsonl"
for i in 1 2 3 4 5; do append_ghost_row $((3600 + i * 60)) ok; done  # all > 1h ago
run_with_fresh_env
case_ "stale (>1h) ghost rows do not block a fresh tick" \
  "$(grep -q 'RUN tick' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"

# --- case 5: gemini-agy-call.sh's OWN rows (hivo != quota-bridge-ghost) never count toward the --
# --- ghost cap, even though they share the identical log file --------------------------------
rm -f "$TD/store/gemini-ghost-runner.log"
: > "$TD/store/seged-hivo-naplo.jsonl"
python3 -I - "$TD/scripts/seged-hivo.py" <<'PY'
import datetime, importlib.util, os, sys
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
for _ in range(5):
    sh.append_log({
        'ido': datetime.datetime.now().isoformat(),
        'hivas_id': os.urandom(8).hex(),
        'seged': 'agy', 'hivo': 'backend2', 'kartya': 'some-card',
        'feladattipus': 'kod', 'status': 'ok',
    })
PY
run_with_fresh_env
case_ "5 unrelated gemini-agy-call.sh rows (different hivo) never block a ghost tick" \
  "$(grep -q 'RUN tick' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"

# --- case 6: a status=blocked ghost row does not count toward the cap --------------------------
rm -f "$TD/store/gemini-ghost-runner.log"
: > "$TD/store/seged-hivo-naplo.jsonl"
for i in 1 2 3 4 5; do append_ghost_row $((i * 60)) blocked; done
run_with_fresh_env
case_ "status=blocked ghost rows do not count toward the cap" \
  "$(grep -q 'RUN tick' "$TD/store/gemini-ghost-runner.log" && echo 0 || echo 1)"

echo
echo "selftest: $n case(s), $([ ${#failures[@]} -eq 0 ] && echo PASS || echo FAIL)"
for f in "${failures[@]:-}"; do
  [ -n "$f" ] && echo "  - $f"
done
[ ${#failures[@]} -eq 0 ]
