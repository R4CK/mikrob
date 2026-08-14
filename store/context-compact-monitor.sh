#!/usr/bin/env bash
# context-compact-monitor.sh -- keep the big agents' context off the ceiling (card 9f74a0da).
#
# WHY, with the measurement behind it (card bb7276e7 PART3 + this card):
#   * The fleet's prompt-cache hit rate is 98.4%. Cache-busting is NOT the quota problem.
#   * The cost is the VOLUME of context re-read: 49.3B cache-read tokens. backend/fullstack/cybered
#     average 450-480k per call and run to the ~1M ceiling; qa sits at 119k doing comparable work.
#   * Two tempting fixes were measured and REJECTED before this one:
#       - "sessions are too long" -> false: qa runs 4x more calls per session at 1/4 the context.
#       - "trim big tool outputs"  -> false: median tool result is 269 chars, and everything over
#         20k chars is 4% of volume. There are no whales to harpoon.
#     What remains is periodic /compact: it does not shave individual results, it resets the
#     CARRIED context -- which is the accumulation the measurement actually found.
#
# WHAT IT DOES: reads each agent's most recent context size from the token_usage table (already
# populated from the Claude Code transcripts by src/web/token-usage.ts), and sends `/compact` to the
# tmux session of any TARGET agent above the threshold.
#
# ANTI-BURN. A /compact is not free -- it costs a summarisation pass -- so spamming it would trade
# one waste for another. Guards, in order:
#   1. only TARGET_AGENTS (the ceiling-runners), never the whole fleet;
#   2. only above THRESHOLD_K;
#   3. a per-agent COOLDOWN, so a still-large context right after a compact does not re-trigger;
#   4. --dry-run, which is what a scheduled task should use first.
# NOTE: this deliberately does NOT go through store/redispatch-guard.sh -- that guard is keyed by
# cardId and exists to stop an agent being made to REDO work. A /compact is agent-keyed and adds no
# work. The cooldown below is the equivalent control for this shape. Flagged for review.
#
# Usage:
#   context-compact-monitor.sh --dry-run     # report what it WOULD do (safe, no side effects)
#   context-compact-monitor.sh               # act
#   context-compact-monitor.sh --selftest    # verify the decision logic, no DB/tmux needed
#
# Exit: 0 ok | 2 bad usage | 3 environment problem
set -uo pipefail

ROOT="/home/neon/marveen"
DB="$ROOT/store/claudeclaw.db"
STATE="$ROOT/store/context-compact-state.json"
LOG="$ROOT/store/context-compact-monitor.log"

# Ceiling-runners only (measured 2026-08-06). qa/fron-teddy are already at target and must not be
# touched -- compacting an agent that is not the problem is pure cost.
#
# mikrob is EXCLUDED by default despite carrying the largest context (632k measured). It is the
# orchestrator: it dispatches, gates and answers Peti, and a mid-flight compact there disturbs the
# whole fleet rather than one worker. Opt it in deliberately via COMPACT_TARGET_AGENTS if wanted.
TARGET_AGENTS="${COMPACT_TARGET_AGENTS:-backend backend2 fullstack cybered cybersec}"
THRESHOLD_K="${COMPACT_THRESHOLD_K:-350}"
COOLDOWN_MIN="${COMPACT_COOLDOWN_MIN:-45}"
# Only trust a reading this fresh; a stale row means the agent is parked, and compacting a parked
# session wakes it up for nothing.
MAX_AGE_MIN="${COMPACT_MAX_AGE_MIN:-20}"

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  --selftest) ;;
  "") ;;
  -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
  *) echo "context-compact-monitor.sh: unknown argument '$1'" >&2; exit 2 ;;
esac

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# --- decision logic, isolated so the selftest can exercise it without a DB or tmux -------------
# should_compact <ctx_k> <threshold_k> <age_min> <max_age_min> <mins_since_last> <cooldown_min>
should_compact() {
  local ctx="$1" thr="$2" age="$3" maxage="$4" since="$5" cool="$6"
  [ "$ctx" -ge "$thr" ] || { echo "below-threshold"; return 1; }
  [ "$age" -le "$maxage" ] || { echo "stale-reading"; return 1; }
  [ "$since" -ge "$cool" ] || { echo "cooldown"; return 1; }
  echo "compact"; return 0
}

# --- cooldown state: read once, FAIL CLOSED on damage (Cybered, card 9f74a0da comment 8232) ------
# The old inline read swallowed every exception into last=0, which made since_min enormous and
# silently switched the cooldown off for EVERY agent -- the anti-burn control disappearing exactly
# when its own state got corrupted. Keep one asymmetry: a VALID state with no entry for an agent
# still means "never compacted" and is allowed to act; only a file we cannot parse is a fault.
#
# On a fault we do not just skip and leave the file damaged -- that would make the monitor silently
# dead, which is the 8-day failure this card exists to fix. We quarantine the damaged file and stamp
# every target agent with NOW: the most conservative reading available (as if all had just been
# compacted). This round is skipped; normal operation resumes after one full cooldown.
#
# Both helpers read $STATE at call time, so the selftest can point them at a throwaway file.
STATE_JSON='{}'

# state_put <json> <agent> <epoch> -> prints the updated json, having written it ATOMICALLY.
# temp file in the same directory + fsync + os.replace: an interrupted run can no longer leave the
# half-written file that the fail-closed path above has to defend against.
state_put() {
  python3 - "$STATE" "$1" "$2" "$3" <<'PY'
import json, os, sys, tempfile
path, payload, agent, stamp = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
data = json.loads(payload)
data[agent] = stamp
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or '.',
                           prefix='.context-compact-state.', suffix='.tmp')
try:
    with os.fdopen(fd, 'w') as fh:
        json.dump(data, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
except BaseException:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
print(json.dumps(data))
PY
}

# read_state -> "OK <json>" or "ERR <reason>". An absent file is a first run, not corruption.
read_state() {
  python3 - "$STATE" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError('state is not a JSON object')
except FileNotFoundError:
    print('OK {}')
except Exception as exc:
    print('ERR ' + str(exc).replace('\n', ' '))
else:
    print('OK ' + json.dumps(data))
PY
}

# cooldown_stamp <json> <agent> -> that agent's last-compact epoch, or ERR if it is not a timestamp.
# A missing key in a valid state is 0 ("never compacted"), which is allowed to act; anything that is
# not a plain non-negative number is a fault, because defaulting it to 0 is what dropped the cooldown.
cooldown_stamp() {
  python3 -c "
import json, sys
v = json.loads(sys.argv[1]).get(sys.argv[2], 0)
print(int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else 'ERR')
" "$1" "$2" 2>/dev/null || echo ERR
}

if [ "${1:-}" = "--selftest" ]; then
  fails=0
  t() { # t <expect> <args...>
    local want="$1"; shift
    local got; got="$(should_compact "$@")"
    if [ "$got" != "$want" ]; then echo "FAIL: want=$want got=$got args=$*"; fails=$((fails+1)); fi
  }
  t compact          400 350 5 20 60 45   # over threshold, fresh, cooled down
  t below-threshold  300 350 5 20 60 45   # under threshold
  t below-threshold  349 350 5 20 60 45   # boundary: strictly below stays put
  t compact          350 350 5 20 60 45   # boundary: at threshold acts
  t stale-reading    400 350 99 20 60 45  # agent parked -> do not wake it
  t cooldown         400 350 5 20 10 45   # compacted recently
  t compact          400 350 5 20 45 45   # boundary: cooldown exactly elapsed

  # --- cooldown-state layer (Cybered comment 8232: fail-open cooldown + non-atomic write) -------
  # The seven cases above only ever exercised should_compact's arithmetic. They stayed green while
  # the state file -- the thing that FEEDS the `since` argument -- silently degraded the cooldown to
  # a no-op. These cases test that input.
  s() { # s <label> <expect> <got>
    if [ "$3" != "$2" ]; then echo "FAIL: $1 want=[$2] got=[$3]"; fails=$((fails+1)); fi
  }
  s_err() { # s_err <label> <got> -- an ERR verdict; read_state appends a reason, cooldown_stamp does not
    case "$2" in ERR|ERR\ *) ;; *) echo "FAIL: $1 want=[ERR...] got=[$2]"; fails=$((fails+1)) ;; esac
  }
  sttmp="$(mktemp -d)"
  trap 'rm -rf "$sttmp"' EXIT
  STATE="$sttmp/state.json"

  s     "absent-state-is-a-first-run-not-corruption" "OK {}"                   "$(read_state)"
  printf '{"backend": 1700000000}' > "$STATE"
  s     "valid-state-parses"        'OK {"backend": 1700000000}'               "$(read_state)"
  printf '{"backend": 17000'        > "$STATE"   # what a truncated write leaves behind
  s_err "truncated-state-is-a-fault"                                           "$(read_state)"
  : > "$STATE"                                   # and what an interrupted one leaves behind
  s_err "empty-state-is-a-fault"                                               "$(read_state)"
  printf '[]'                       > "$STATE"
  s_err "non-object-state-is-a-fault"                                          "$(read_state)"

  s "missing-agent-in-a-valid-state-means-never-compacted" "0" \
    "$(cooldown_stamp '{"other": 1700000000}' backend)"
  s "present-agent-returns-its-stamp"      "1700000000" \
    "$(cooldown_stamp '{"backend": 1700000000}' backend)"
  s_err "non-numeric-stamp-is-a-fault"     "$(cooldown_stamp '{"backend": "soon"}' backend)"
  s_err "negative-stamp-is-a-fault"        "$(cooldown_stamp '{"backend": -5}' backend)"
  s_err "unparseable-payload-is-a-fault"   "$(cooldown_stamp '{"backend"' backend)"

  # ATOMICITY DISCRIMINATOR. A read-only state file in a writable directory: os.replace only needs
  # write permission on the DIRECTORY, so the atomic write goes through, while the old truncating
  # open(path,'w') fails with EACCES. Put that write back and this case turns RED -- that mutation,
  # not a green suite, is what makes the case evidence. Skipped as root, which ignores the mode.
  if [ "$(id -u)" != "0" ]; then
    printf '{"backend": 1}' > "$STATE"; chmod 400 "$STATE"
    s "atomic-write-survives-a-read-only-state-file" '{"backend": 1786700000}' \
      "$(state_put '{"backend": 1}' backend 1786700000 2>/dev/null)"
    chmod 600 "$STATE" 2>/dev/null
    s "atomic-write-actually-landed-on-disk"         '{"backend": 1786700000}' "$(cat "$STATE")"
  else
    echo "NOTE: running as root, skipping the read-only-file atomicity case"
  fi
  s "atomic-write-leaves-no-temp-debris" "0" \
    "$(find "$sttmp" -name '.context-compact-state.*.tmp' | wc -l)"

  [ "$fails" -eq 0 ] && { echo "selftest OK (20 cases)"; exit 0; } || { echo "selftest FAILED: $fails"; exit 1; }
fi

[ -r "$DB" ] || { echo "context-compact-monitor.sh: cannot read $DB" >&2; exit 3; }

state_raw="$(read_state 2>&1)"
if [ "${state_raw%% *}" = "OK" ]; then
  STATE_JSON="${state_raw#OK }"
else
  if [ "$DRY" = "1" ]; then
    # --dry-run promises no side effects, so it reports the damage instead of repairing it.
    echo "SKIP RUN: cooldown state unreadable (${state_raw#ERR }) -- a live run would quarantine it"
    exit 0
  fi
  log "SKIP RUN: cooldown state unreadable (${state_raw#ERR }) -- quarantining and stamping all targets"
  # Quarantine, never delete: the damaged file is the only evidence of what went wrong. If the move
  # itself fails we leave it in place and carry on -- state_put's os.replace overwrites it anyway.
  mv -f "$STATE" "$STATE.corrupt.$(date +%s)" 2>/dev/null || log "WARN: could not quarantine $STATE"
  for agent in $TARGET_AGENTS; do
    STATE_JSON="$(state_put "$STATE_JSON" "$agent" "$(date +%s)")" || {
      log "SKIP RUN: could not rewrite cooldown state, giving up this round"; exit 3; }
  done
  exit 0
fi

# Refresh token_usage BEFORE deciding. The dashboard only auto-collects hourly (web.ts), so without
# this the monitor would read context sizes up to an hour old -- and an hour-old number is not a
# safe basis for compacting a live session (the agent may already have compacted, or grown far past
# it). Best-effort: if the refresh fails we still run, and the staleness check below is what stops
# us acting on an old reading. Token from a 0600 header file, never argv.
TOKEN_FILE="$ROOT/store/.dashboard-token"
HDR_FILE=""   # stays empty if the token is unreadable; the compact call below checks this (set -u)
if [ -r "$TOKEN_FILE" ]; then
  HDR_FILE="$(mktemp)"; trap 'rm -f "$HDR_FILE"' EXIT; chmod 600 "$HDR_FILE"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$HDR_FILE"
  curl -fsS -m 60 -X POST "http://127.0.0.1:${WEB_PORT:-3420}/api/token-usage/collect" \
    -H "@$HDR_FILE" >/dev/null 2>&1 || log "WARN: token-usage refresh failed; using stored rows"
fi

NOW=$(date +%s)
ACTED=0

for agent in $TARGET_AGENTS; do
  row=$(sqlite3 "$DB" "SELECT CAST(MAX(cache_read_tokens)/1000 AS INT) || ' ' || MAX(timestamp)
                       FROM token_usage WHERE agent='$agent' AND timestamp > $((NOW - 7200));" 2>/dev/null)
  ctx_k=$(echo "$row" | awk '{print $1}')
  ts=$(echo "$row" | awk '{print $2}')
  [ -n "$ctx_k" ] && [ "$ctx_k" != "" ] || continue
  case "$ctx_k" in (*[!0-9]*) continue ;; esac

  age_min=$(( (NOW - ts) / 60 ))
  # From the already-validated state of this run. A per-agent value that is not a plain timestamp is
  # the same class of fault as an unparseable file, so it skips this agent rather than defaulting to
  # 0 (which would read as "never compacted" and drop the cooldown).
  last=$(cooldown_stamp "$STATE_JSON" "$agent")
  case "$last" in (''|*[!0-9]*) log "SKIP $agent: cooldown stamp is not a timestamp"; continue ;; esac
  since_min=$(( (NOW - last) / 60 ))

  reason=$(should_compact "$ctx_k" "$THRESHOLD_K" "$age_min" "$MAX_AGE_MIN" "$since_min" "$COOLDOWN_MIN")
  if [ "$reason" != "compact" ]; then
    [ "$DRY" = "1" ] && echo "SKIP $agent ctx=${ctx_k}k age=${age_min}m since=${since_min}m -> $reason"
    continue
  fi

  if [ "$DRY" = "1" ]; then
    echo "WOULD COMPACT $agent ctx=${ctx_k}k age=${age_min}m since=${since_min}m"
    continue
  fi

  # POST /api/agents/<agent>/compact, not a direct tmux write (card 9cfed589, Cybered's
  # cron-shell-pane-writers survey; same defect class as fleet-nudger.sh, card 7560bb6a). The old
  # line -- `tmux send-keys ... && sleep 1 && tmux send-keys Enter` -- ran from this scheduled-task
  # process, OUTSIDE the dashboard's in-process pane mutex, with a full second between the text and
  # the Enter for another writer's keystrokes to land in the middle of it. The API route holds the
  # SAME lock every other delivery path in this codebase uses, and still sends a LITERAL, unwrapped
  # '/compact' (unlike /api/messages, which prefixes every delivery with a trusted-peer frame that
  # would turn the command into prose Claude Code no longer recognizes as the built-in slash
  # command). $HDR_FILE already exists above (the token-usage refresh reuses it) -- no argv token.
  # Checked for non-empty first: under `set -u` an unset var would abort the whole run, and a
  # missing token should skip this one compact, not crash every remaining agent in the loop.
  if [ -z "$HDR_FILE" ]; then
    log "SKIP $agent: no dashboard token available, cannot call the compact API"
    continue
  fi
  resp="$(curl -fsS -m 15 -X POST "http://127.0.0.1:${WEB_PORT:-3420}/api/agents/${agent}/compact" \
    -H "@$HDR_FILE" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "SKIP $agent: compact request failed ($resp)"
    continue
  fi
  STATE_JSON="$(state_put "$STATE_JSON" "$agent" "$NOW")" || {
    # The compact already happened; failing to record it would let the next run repeat it.
    log "WARN $agent: compacted but could not persist the cooldown stamp"; }
  log "COMPACT $agent ctx=${ctx_k}k (threshold ${THRESHOLD_K}k)"
  ACTED=$((ACTED + 1))
done

[ "$DRY" = "1" ] || log "run complete, compacted=$ACTED"
exit 0
