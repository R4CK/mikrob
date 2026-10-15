#!/bin/bash
# Gemini Ghost runner (card 612058c2).
#
# WHY THIS EXISTS: the cf757409 Gemini-fallback pipeline (route decision -> card ordering ->
# local-LLM draft -> Gemini first-pass review, store/run-gemini-fallback.sh + dist/gemini-
# orchestrator*.js) is only ever DRIVEN by MikroB's own heartbeat/scheduled-task prompts -- and a
# scheduled-task prompt lands in MikroB's tmux pane, which does nothing while MikroB itself is
# frozen on the Claude usage limit (quota-bridge.py's Ghost mode). During a session-level quota
# outage nothing else alive drives that pipeline at all. This script is that driver: started by
# quota-bridge.py's outage_loop() the moment an outage is confirmed, killed the moment recovery is
# detected. It builds NOTHING new -- every step below is an EXISTING entry point, called exactly
# as MikroB's own heartbeat would call it.
#
# HOURLY CAP (Teendo 3, card 612058c2): reuses scripts/seged-hivo.py's OWN log file and
# calls_of()/read_log()/append_log() functions -- the identical machinery store/gemini-agy-
# call.sh's hourly gate already uses -- tagged hivo="quota-bridge-ghost" so this runner's own
# ticks are counted separately from gemini-agy-call.sh's "agy:<model>" rows while sharing the
# exact same file, window and exit-code conventions. Default 5/hour (GEMINI_AGY_HOURLY_LIMIT,
# same env var gemini-agy-call.sh honours), one log row per tick actually run (not per underlying
# Gemini network call -- a tick drives at most one queued card through ordering+draft+review).
set -euo pipefail
ROOT="${MARVEEN_ROOT:-/home/neon/marveen}"
STORE="$ROOT/store"
SEGED_HIVO_HELPERS="${SEGED_HIVO_HELPERS:-$ROOT/scripts/seged-hivo.py}"
HOURLY_LIMIT="${GEMINI_AGY_HOURLY_LIMIT:-5}"
TICK_INTERVAL_S="${GEMINI_GHOST_TICK_INTERVAL_S:-300}"
LOG="$STORE/gemini-ghost-runner.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

ghost_calls_this_hour() {
  local window_start
  window_start=$(($(date +%s) - 3600))
  python3 -I - "$SEGED_HIVO_HELPERS" "$window_start" <<'PY'
import datetime, importlib.util, sys
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
window_start = int(sys.argv[2])
n = 0
for row in sh.calls_of(sh.read_log()):
    if row.get('hivo') != 'quota-bridge-ghost' or row.get('status') == 'blocked':
        continue
    try:
        ts = datetime.datetime.fromisoformat(str(row.get('ido', ''))).timestamp()
    except ValueError:
        continue
    if ts >= window_start:
        n += 1
print(n)
PY
}

ghost_log_tick() {
  local status="$1"
  python3 -I - "$SEGED_HIVO_HELPERS" "$status" <<'PY'
import datetime, importlib.util, os, sys
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
sh.append_log({
    'ido': datetime.datetime.now().isoformat(),
    'hivas_id': os.urandom(8).hex(),
    'seged': 'agy',
    'hivo': 'quota-bridge-ghost',
    'kartya': 'n/a (ghost-sweep tick)',
    'feladattipus': 'kod',
    'status': sys.argv[2],
})
PY
}

run_tick() {
  local used
  if ! used=$(ghost_calls_this_hour); then
    log "SKIP tick: hourly-count check failed (seged-hivo helper unreadable?)"
    return
  fi
  if [ "$used" -ge "$HOURLY_LIMIT" ]; then
    log "SKIP tick: hourly ghost cap reached ($used/$HOURLY_LIMIT)"
    return
  fi
  log "RUN tick ($used/$HOURLY_LIMIT used this hour)"
  local status="ok"
  bash "$STORE/run-gemini-fallback.sh" >>"$LOG" 2>&1 || status="hiba(fallback-runner)"
  node "$ROOT/dist/gemini-orchestrator.js" >>"$LOG" 2>&1 || status="hiba(orchestrator)"
  node "$ROOT/dist/gemini-orchestrator-draft.js" >>"$LOG" 2>&1 || status="hiba(draft)"
  node "$ROOT/dist/gemini-orchestrator-draft-review.js" >>"$LOG" 2>&1 || status="hiba(review)"
  ghost_log_tick "$status" || log "WARN: could not append ghost-call log row"
}

# Sourced (not executed) by the selftest, which defines the functions above and calls run_tick /
# ghost_calls_this_hour directly against a throw-away root -- the loop below must not start then.
if ! (return 0 2>/dev/null); then
  if [ "${1:-}" = "--once" ]; then
    run_tick
    exit 0
  fi
  log "gemini-ghost-runner started (tick=${TICK_INTERVAL_S}s, cap=${HOURLY_LIMIT}/h)"
  while true; do
    run_tick
    sleep "$TICK_INTERVAL_S"
  done
fi
