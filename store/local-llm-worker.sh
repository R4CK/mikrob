#!/usr/bin/env bash
# local-llm-worker.sh -- drains the local_llm_queue (card defcc189).
#
# WHY A SEPARATE PROCESS: the queue exists so agents never block on the 7B. Something still has to
# run the model, and it must be exactly ONE thing at a time -- the GPU fits one 7B. That serialization
# already exists inside store/local-llm.sh (the flock on /tmp/local-llm-gpu.lock), so this worker
# deliberately shells out to that script instead of calling Ollama itself: one code path owns the
# GPU semaphore, the --task allowlist and the usage logging.
#
# LOOP: claim the oldest highest-priority pending row -> run it -> write the result back. Between
# passes it sleeps; an empty queue costs one cheap API call per interval and no GPU time.
#
# CRASH SAFETY: rows are reclaimed by the API side (reclaimStaleRunning) rather than here, because a
# worker that died is by definition not running to clean up after itself.
#
# NO SECRETS IN ARGV: the token is passed to curl via a 0600 header FILE (-H @file), never on the
# command line -- see the header-file block below for why reading it from a file is not sufficient.
#
# Usage:
#   local-llm-worker.sh            # loop until killed
#   local-llm-worker.sh --once     # drain a single row then exit (used by the tests / a cron poke)
set -uo pipefail

ROOT="/home/neon/marveen"
API="http://127.0.0.1:${WEB_PORT:-3420}/api"
TOKEN_FILE="$ROOT/store/.dashboard-token"
LLM="$ROOT/store/local-llm.sh"
LOG="$ROOT/store/local-llm-worker.log"
IDLE_SLEEP="${LOCAL_LLM_WORKER_IDLE_SLEEP:-10}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

[ -x "$LLM" ] || { log "FATAL: $LLM missing"; exit 3; }
[ -r "$TOKEN_FILE" ] || { log "FATAL: token unreadable"; exit 3; }

# SECURITY (card defcc189, Cybersec NO-GO on bf6fe53): the Authorization header goes through a 0600
# temp file read with curl's `-H @file`, NEVER on the curl argv. `-H "Bearer $(cat token)"` is
# expanded by the shell BEFORE exec, so the token itself lands in /proc/<pid>/cmdline (world-readable
# here: no hidepid) and in `ps` -- any local user could scrape it during the call window, even one
# who cannot read the 0600 token file. Same pattern as store/weekly-usage-probe.sh.
HDR_FILE="$(mktemp)"
trap 'rm -f "$HDR_FILE"' EXIT
chmod 600 "$HDR_FILE"
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$HDR_FILE"


api() {
  # $1=method $2=path ; body on stdin when POST/PATCH
  # --max-time: this worker calls its OWN dashboard API. If the dashboard is
  # wedged (listener alive, not responding), an unbounded curl hangs forever,
  # which then blocks the poke scheduled-task's cron slot and stalls systemd
  # stop (KillMode=process leaves this bash+curl running) -- a self-reinforcing
  # restart-loop that fed a false auto-rollback trigger (Cybersec, 2026-08-06).
  local method="$1" path="$2"
  curl -fsS --max-time 20 -X "$method" "$API$path" \
    -H "@$HDR_FILE" \
    -H 'Content-Type: application/json' \
    ${3:+--data-binary @-}
}

# Returns: 0 = processed one row | 1 = nothing to do | 2 = error reaching the API.
# The distinction matters for --once, which runs as a MONITORED scheduled command: an empty queue
# is the normal steady state and must NOT look like a failure, or the scheduler's failThreshold
# fires a Telegram alert every couple of minutes forever.
drain_one() {
  local claimed
  claimed=$(api POST /local-llm/queue/claim 2>/dev/null) || return 2
  [ -n "$claimed" ] || return 1

  local id prompt template
  id=$(printf '%s' "$claimed" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or "")' 2>/dev/null)
  [ -n "$id" ] || return 1   # empty queue

  prompt=$(printf '%s' "$claimed" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.stdout.write(d.get("prompt") or "")')
  template=$(printf '%s' "$claimed" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("template") or "")')

  log "claim id=$id template=${template:-<none>}"

  # The prompt goes in on STDIN, never in argv: it is agent-supplied text of arbitrary length and
  # shape, and argv is both size-limited and visible in ps(1). local-llm.sh reads stdin exactly when
  # no positional prompt arg is given (verified in its arg handling) -- so we pass none.
  local out rc
  if [ -n "$template" ]; then
    out=$(printf '%s' "$prompt" | "$LLM" --task "$template" --caller "queue" 2>&1); rc=$?
  else
    out=$(printf '%s' "$prompt" | "$LLM" --caller "queue" 2>&1); rc=$?
  fi

  if [ $rc -eq 0 ] && [ -n "$out" ]; then
    printf '%s' "$out" | python3 -c '
import json,sys
sys.stdout.write(json.dumps({"result": sys.stdin.read()}))
' | api POST "/local-llm/queue/$id/complete" body >/dev/null 2>&1
    log "done id=$id bytes=${#out}"
  else
    printf '%s' "$out" | python3 -c '
import json,sys
sys.stdout.write(json.dumps({"error": sys.stdin.read()[:2000]}))
' | api POST "/local-llm/queue/$id/fail" body >/dev/null 2>&1
    log "fail id=$id rc=$rc"
  fi
  return 0
}

if [ "$ONCE" = "1" ]; then
  drain_one
  rc=$?
  # 1 ("nothing to do") is SUCCESS for a scheduled poke. Only a real error is non-zero.
  case "$rc" in
    0|1) exit 0 ;;
    *)   log "ERROR: could not reach the queue API"; exit 2 ;;
  esac
fi

log "worker start (idle sleep ${IDLE_SLEEP}s)"
while true; do
  drain_one || sleep "$IDLE_SLEEP"
done
